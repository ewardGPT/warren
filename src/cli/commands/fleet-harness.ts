/**
 * Shared scaffolding for the `warren fleet` seam tests (`fleet.test.ts`,
 * `fleet.pump.test.ts`). Split out (warren-4553) to keep each test file under
 * the repo's file-size threshold without duplicating the fake fleet boxes, the
 * stub repos and the placing-verb seams.
 *
 * Nothing here reads a real fleet config, opens a socket, or touches a
 * database. The boxes are fake `FleetBoxRuntime`s whose client only has to
 * answer the two calls the real `probeBoxes` makes (`probe`, then
 * `burrows.list`), and the placing verbs get stub `spawnRun` / `runRun` seams
 * plus a stub project repo.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type { SpawnRunInput, SpawnRunResult } from "../../runs/spawn/types.ts";
import type { FleetBoxRuntime } from "../../runtime/local/fleet/index.ts";
import type { ReadySeed } from "../../seeds-cli/ready.ts";
import type { CliContext, Stdio } from "../output.ts";
import type { FleetCliDeps } from "./fleet.ts";
import type { RunArgs, RunResult } from "./run.ts";

/** runFleet returns its lines; the placing verbs write through injected seams. */
export const NOOP_STDIO: Stdio = {
	stdout: { write: (_chunk: string): void => undefined },
	stderr: { write: (_chunk: string): void => undefined },
};

export type BoxMode = "ok" | "probe-down" | "list-down";

/** A tcp box backed by a client stub — probe ok means healthy. */
export function fakeBox(options: {
	id: string;
	mode?: BoxMode;
	hostname?: string;
	port?: number;
	live?: number;
}): FleetBoxRuntime {
	const mode = options.mode ?? "ok";
	const live = options.live ?? 0;
	const client = {
		config: {
			transport: {
				kind: "tcp" as const,
				hostname: options.hostname ?? "100.64.0.1",
				port: options.port ?? 7455,
			},
			token: "tok",
		},
		probe: async (_timeoutMs?: number): Promise<void> => {
			if (mode === "probe-down") throw new Error("connection refused");
		},
		http: {
			burrows: {
				list: async (_options?: object): Promise<readonly { state: string }[]> => {
					if (mode === "list-down") throw new Error("workspace list failed");
					return Array.from({ length: live }, () => ({ state: "active" }));
				},
			},
		},
	};
	return { id: options.id, client, provider: {}, ssh: {} } as unknown as FleetBoxRuntime;
}

/** The registered project the stub repo answers with. */
export const PROJECT: ProjectRow = {
	id: "prj_test",
	gitUrl: "https://example.test/x.git",
	localPath: "/tmp/x",
	defaultBranch: "main",
	addedAt: "2026-01-01T00:00:00.000Z",
	lastFetchedAt: null,
	lastHeadSha: null,
	hasSeeds: false,
};

export interface FleetCalls {
	/** Every domain spawn the placing verbs made, in order. */
	readonly spawns: SpawnRunInput[];
	/** Every lifecycle delegation `dispatch --wait` made. */
	readonly runs: RunArgs[];
}

/** The single line `status --json` prints. */
export interface StatusJson {
	readonly boxes: readonly {
		readonly id: string;
		readonly url: string;
		readonly healthy: boolean;
		readonly live: number;
		readonly detail: string | null;
	}[];
	readonly healthy: number;
}

export interface FleetHarness {
	readonly context: CliContext;
	readonly deps: FleetCliDeps;
	readonly calls: FleetCalls;
}

/**
 * A harness whose placing verbs go through stub domain seams. `exactUrl` is what
 * `findByGitUrl` answers to; `listedUrl` is what the fallback scan sees, which
 * lets a test drive the normalization path on its own.
 */
export function harness(options: {
	boxes: readonly FleetBoxRuntime[];
	seeds?: FleetCliDeps["seeds"];
	projectPath?: string;
	repos?: Repos;
	exactUrl?: string | null;
	listedUrl?: string | null;
	spawnError?: string;
	runExit?: number;
	env?: Record<string, string | undefined>;
}): FleetHarness {
	const calls: FleetCalls = { spawns: [], runs: [] };
	const provider = { boxes: options.boxes } as NonNullable<FleetCliDeps["provider"]>;
	const repos =
		options.repos ??
		({
			projects: {
				findByGitUrl: async (gitUrl: string): Promise<ProjectRow | null> =>
					options.exactUrl === gitUrl ? PROJECT : null,
				listAll: async (): Promise<ProjectRow[]> =>
					options.listedUrl === null || options.listedUrl === undefined
						? []
						: [{ ...PROJECT, id: "prj_listed", gitUrl: options.listedUrl }],
			},
		} as unknown as Repos);
	const context: CliContext = {
		env: options.env ?? {},
		stdio: NOOP_STDIO,
		spawn: () => Promise.reject(new Error("fleet must not spawn")),
	};
	const deps: FleetCliDeps = {
		provider,
		env: options.env ?? {},
		repos,
		spawn: async (input: SpawnRunInput): Promise<SpawnRunResult> => {
			calls.spawns.push(input);
			if (options.spawnError !== undefined) throw new Error(options.spawnError);
			const box = options.boxes[0]?.id ?? "box-a";
			return {
				run: { id: `run_${calls.spawns.length}`, agentName: input.agentName } as never,
				burrow: { id: "sandbox-07", workspacePath: "" },
				burrowRun: { id: `${box}/run_inner` },
				agent: {} as never,
			};
		},
		run: async (_context, _deps, args: RunArgs): Promise<RunResult> => {
			calls.runs.push(args);
			return { exitCode: options.runExit ?? 0, runId: "run_wait", state: "succeeded" };
		},
		...(options.seeds === undefined ? {} : { seeds: options.seeds }),
		...(options.projectPath === undefined ? {} : { projectPath: options.projectPath }),
	};
	return { context, deps, calls };
}

/**
 * A seeds seam over a scripted list of claims. `null` in the list means "nothing
 * ready", which is how a pump sees an empty queue.
 */
export function pumpSeeds(claims: readonly (ReadySeed | null)[]): {
	readonly seam: NonNullable<FleetCliDeps["seeds"]>;
	readonly calls: { listed: number; claimed: number; types: string[] };
} {
	const calls = { listed: 0, claimed: 0, types: [] as string[] };
	const queue = [...claims];
	return {
		calls,
		seam: {
			listReady: async (_projectPath: string, options: { limit?: number; type?: string }) => {
				calls.listed += 1;
				calls.types.push(options.type ?? "");
				const limit = options.limit ?? queue.length;
				return queue.slice(0, limit).filter((seed): seed is ReadySeed => seed !== null);
			},
			claim: async (_projectPath: string, options: { leaseMinutes?: number; type?: string }) => {
				calls.claimed += 1;
				calls.types.push(options.type ?? "");
				return queue.shift() ?? null;
			},
		},
	};
}
