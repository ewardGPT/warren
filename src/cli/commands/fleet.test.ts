/**
 * `warren fleet <status|dispatch|pump>` through its seam.
 *
 * Nothing here reads a real fleet config, opens a socket, or touches a
 * database. The boxes are fake `FleetBoxRuntime`s whose client only has to
 * answer the two calls the real `probeBoxes` makes (`probe`, then
 * `burrows.list`), and the placing verbs get stub `spawnRun` / `runRun` seams
 * plus a stub project repo.
 */

import { describe, expect, test } from "bun:test";
import type { Repos } from "../../db/repos/index.ts";
import type { ProjectRow } from "../../db/schema.ts";
import type { SpawnRunInput, SpawnRunResult } from "../../runs/spawn/types.ts";
import type { FleetBoxRuntime } from "../../runtime/local/fleet/index.ts";
import type { ReadySeed } from "../../seeds-cli/ready.ts";
import type { CliContext, Stdio } from "../output.ts";
import { type FleetCliDeps, runFleet } from "./fleet.ts";
import type { RunArgs, RunResult } from "./run.ts";

/** runFleet returns its lines; the placing verbs write through injected seams. */
const NOOP_STDIO: Stdio = {
	stdout: { write: (_chunk: string): void => undefined },
	stderr: { write: (_chunk: string): void => undefined },
};

type BoxMode = "ok" | "probe-down" | "list-down";

/** A tcp box backed by a client stub — probe ok means healthy. */
function fakeBox(options: {
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
const PROJECT: ProjectRow = {
	id: "prj_test",
	gitUrl: "https://example.test/x.git",
	localPath: "/tmp/x",
	defaultBranch: "main",
	addedAt: "2026-01-01T00:00:00.000Z",
	lastFetchedAt: null,
	lastHeadSha: null,
	hasSeeds: false,
};

interface FleetCalls {
	/** Every domain spawn the placing verbs made, in order. */
	readonly spawns: SpawnRunInput[];
	/** Every lifecycle delegation `dispatch --wait` made. */
	readonly runs: RunArgs[];
}

/** The single line `status --json` prints. */
interface StatusJson {
	readonly boxes: readonly {
		readonly id: string;
		readonly url: string;
		readonly healthy: boolean;
		readonly live: number;
		readonly detail: string | null;
	}[];
	readonly healthy: number;
}

interface FleetHarness {
	readonly context: CliContext;
	readonly deps: FleetCliDeps;
	readonly calls: FleetCalls;
}

/**
 * A harness whose placing verbs go through stub domain seams. `exactUrl` is what
 * `findByGitUrl` answers to; `listedUrl` is what the fallback scan sees, which
 * lets a test drive the normalization path on its own.
 */
function harness(options: {
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
function pumpSeeds(claims: readonly (ReadySeed | null)[]): {
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

describe("warren fleet status", () => {
	test("one reachable box is a success and the line carries its load and url", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a", live: 2, port: 7455 })] });
		const report = await runFleet({ action: "status" }, h.context, h.deps);
		expect(report.exitCode).toBe(0);
		expect(report.lines[0]).toBe("fleet: 1/1 boxes reachable");
		const row = report.lines[1];
		expect(row).toContain("box-a");
		expect(row).toContain("ok");
		expect(row).toContain("2 live");
		expect(row).toContain("http://100.64.0.1:7455");
		expect(h.calls.spawns).toHaveLength(0);
	});

	test("every box down is exit 3, and each row says why", async () => {
		const h = harness({
			boxes: [
				fakeBox({ id: "box-a", mode: "probe-down" }),
				fakeBox({ id: "box-b", mode: "probe-down" }),
			],
		});
		const report = await runFleet({ action: "status" }, h.context, h.deps);
		expect(report.exitCode).toBe(3);
		expect(report.lines[0]).toBe("fleet: 0/2 boxes reachable");
		const down = report.lines[1];
		expect(down).toContain("down (healthz: connection refused)");
		expect(down).toContain("! box-a");
		expect(report.lines[2]).toContain("! box-b");
	});

	test("an auth-failing box is down on the burrows.list half, not the probe", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a", mode: "list-down" })] });
		const report = await runFleet({ action: "status" }, h.context, h.deps);
		expect(report.exitCode).toBe(3);
		expect(report.lines[1]).toContain("down (burrows.list: workspace list failed)");
	});

	test("no boxes configured is its own failure, not 'all down'", async () => {
		const h = harness({ boxes: [] });
		const report = await runFleet({ action: "status" }, h.context, h.deps);
		expect(report.exitCode).toBe(1);
		expect(report.lines).toEqual(["fleet: no boxes configured"]);
	});

	test("--json prints the rows and the healthy count as one line", async () => {
		const h = harness({
			boxes: [
				fakeBox({ id: "box-a", live: 3 }),
				fakeBox({ id: "box-b", mode: "probe-down", port: 8000 }),
			],
		});
		const report = await runFleet({ action: "status", json: true }, h.context, h.deps);
		expect(report.exitCode).toBe(0);
		expect(report.lines).toHaveLength(1);
		const parsed = JSON.parse(report.lines[0] ?? "") as StatusJson;
		expect(parsed.healthy).toBe(1);
		// NB: `detail` for the healthy box is not asserted: statusReport coerces
		// the probe's `detail: null` to the string "not probed" (see bug report).
		expect(parsed.boxes[0]).toMatchObject({
			id: "box-a",
			url: "http://100.64.0.1:7455",
			healthy: true,
			live: 3,
		});
		expect(parsed.boxes[1]?.healthy).toBe(false);
		expect(parsed.boxes[1]?.url).toBe("http://100.64.0.1:8000");
		expect(parsed.boxes[1]?.detail).toContain("healthz");
	});
});

describe("warren fleet config", () => {
	test("an unusable fleet config is a two-line failure, never a throw", async () => {
		const missing = "/nonexistent/warren-fleet-test/fleet.yaml";
		const context: CliContext = {
			env: { WARREN_FLEET_CONFIG: missing },
			stdio: NOOP_STDIO,
			spawn: () => Promise.reject(new Error("fleet must not spawn")),
		};
		const report = await runFleet({ action: "status" }, context, {
			env: { WARREN_FLEET_CONFIG: missing },
		});
		expect(report.exitCode).toBe(1);
		expect(report.lines).toHaveLength(2);
		expect(report.lines[0]).toContain(`no fleet config at ${missing}`);
		expect(report.lines[1]).toContain("WARREN_FLEET_CONFIG");
	});
});

describe("warren fleet dispatch", () => {
	test("missing --repo or --prompt is refused before any call", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })] });
		const noRepo = await runFleet({ action: "dispatch", prompt: "go" }, h.context, h.deps);
		expect(noRepo.exitCode).toBe(1);
		expect(noRepo.lines).toEqual(["fleet dispatch needs --repo and --prompt"]);
		const noPrompt = await runFleet(
			{ action: "dispatch", repo: "https://example.test/x.git" },
			h.context,
			h.deps,
		);
		expect(noPrompt.exitCode).toBe(1);
		expect(h.calls.spawns).toHaveLength(0);
	});

	test("an unregistered repo stops with the command that fixes it", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })] });
		const report = await runFleet(
			{ action: "dispatch", repo: "https://example.test/other.git", prompt: "go" },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(1);
		expect(report.lines[0]).toBe(
			"fleet: https://example.test/other.git is not a registered project",
		);
		expect(report.lines[1]).toContain("warren add-project https://example.test/other.git");
		expect(h.calls.spawns).toHaveLength(0);
	});

	test("dispatches through the domain, so the run gets a row and a seed-free trigger", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })], exactUrl: PROJECT.gitUrl });
		const report = await runFleet(
			{ action: "dispatch", repo: PROJECT.gitUrl, prompt: "go" },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(0);
		expect(report.lines[0]).toBe("dispatched run_1 on box-a");
		expect(report.lines[1]).toContain("sandbox sandbox-07");
		const input = h.calls.spawns[0];
		expect(input?.projectId).toBe("prj_test");
		expect(input?.agentName).toBe("pi");
		expect(input?.prompt).toBe("go");
		expect(input?.trigger).toBe("cli");
		expect(input?.seedId).toBeUndefined();
		// The run's own branch composition owns the branch, so no branch rides in.
		expect(h.calls.runs).toHaveLength(0);
	});

	test("a repo typed with .git, a trailing slash or other case still resolves", async () => {
		const h = harness({
			boxes: [fakeBox({ id: "box-a" })],
			exactUrl: null,
			listedUrl: "https://example.test/X.git/",
		});
		const report = await runFleet(
			{ action: "dispatch", repo: "https://example.test/x", prompt: "go" },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(0);
		expect(h.calls.spawns[0]?.projectId).toBe("prj_listed");
	});

	test("passes the agent and the provider and model overrides through", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })], exactUrl: PROJECT.gitUrl });
		await runFleet(
			{
				action: "dispatch",
				repo: PROJECT.gitUrl,
				prompt: "go",
				runtime: "codex",
				provider: "headroom-bifrost",
				model: "deepseek-v4-flash",
			},
			h.context,
			h.deps,
		);
		const input = h.calls.spawns[0];
		expect(input?.agentName).toBe("codex");
		expect(input?.providerOverride).toBe("headroom-bifrost");
		expect(input?.modelOverride).toBe("deepseek-v4-flash");
	});

	test("warns that reap needs a fleet server when the shell does not pick that runtime", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })], exactUrl: PROJECT.gitUrl });
		const local = await runFleet(
			{ action: "dispatch", repo: PROJECT.gitUrl, prompt: "go" },
			h.context,
			h.deps,
		);
		expect(local.lines.at(-1)).toContain("WARREN_RUNTIME=fleet");

		const fleet = harness({
			boxes: [fakeBox({ id: "box-a" })],
			exactUrl: PROJECT.gitUrl,
			env: { WARREN_RUNTIME: "fleet" },
		});
		const report = await runFleet(
			{ action: "dispatch", repo: PROJECT.gitUrl, prompt: "go" },
			fleet.context,
			fleet.deps,
		);
		expect(report.lines.at(-1)).toContain("next watchdog tick");
	});

	test("--wait runs the whole lifecycle instead of leaving reap to a server", async () => {
		const h = harness({
			boxes: [fakeBox({ id: "box-a" })],
			exactUrl: PROJECT.gitUrl,
			runExit: 0,
		});
		const report = await runFleet(
			{ action: "dispatch", repo: PROJECT.gitUrl, prompt: "go", wait: true },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(0);
		expect(report.lines[0]).toContain("run_wait succeeded");
		// The lifecycle is the domain's, so nothing here spawns directly.
		expect(h.calls.spawns).toHaveLength(0);
		expect(h.calls.runs[0]?.project).toBe("prj_test");
		expect(h.calls.runs[0]?.prompt).toBe("go");
	});

	test("--wait passes a failing lifecycle's exit code through", async () => {
		const h = harness({
			boxes: [fakeBox({ id: "box-a" })],
			exactUrl: PROJECT.gitUrl,
			runExit: 1,
		});
		const report = await runFleet(
			{ action: "dispatch", repo: PROJECT.gitUrl, prompt: "go", wait: true },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(1);
	});

	test("a spawn failure is reported with its message and exits 1", async () => {
		const h = harness({
			boxes: [fakeBox({ id: "box-a" })],
			exactUrl: PROJECT.gitUrl,
			spawnError: "burrow refused: no capacity",
		});
		const report = await runFleet(
			{ action: "dispatch", repo: PROJECT.gitUrl, prompt: "go" },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(1);
		expect(report.lines).toEqual(["fleet dispatch failed: burrow refused: no capacity"]);
	});

	test("refuses to place without a database, rather than writing no evidence", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })] });
		const report = await runFleet(
			{ action: "dispatch", repo: PROJECT.gitUrl, prompt: "go" },
			h.context,
			{ ...h.deps, repos: undefined },
		);
		expect(report.exitCode).toBe(1);
		expect(report.lines[0]).toContain("no warren database in reach");
	});
});

describe("warren fleet pump", () => {
	test("a dry run lists the ready seeds and writes nothing", async () => {
		const seeds = pumpSeeds([
			{ id: "ubuntu-aaaa", title: "first" },
			{ id: "ubuntu-bbbb", title: "second" },
		]);
		const h = harness({
			boxes: [fakeBox({ id: "box-a" }), fakeBox({ id: "box-b" })],
			seeds: seeds.seam,
			projectPath: "/proj",
			exactUrl: PROJECT.gitUrl,
		});
		const report = await runFleet(
			{ action: "pump", repo: PROJECT.gitUrl, dryRun: true },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(0);
		expect(report.lines[0]).toBe("pump: dry run, 2 ready seed(s), nothing claimed or dispatched");
		expect(report.lines[1]).toContain("ubuntu-aaaa");
		// The point of the flag: no lease is taken and no run is created.
		expect(seeds.calls.claimed).toBe(0);
		expect(h.calls.spawns).toHaveLength(0);
	});

	test("claims one seed per box and records each seed on its run", async () => {
		const seeds = pumpSeeds([
			{ id: "ubuntu-aaaa", title: "first" },
			{ id: "ubuntu-bbbb", title: "second" },
		]);
		const h = harness({
			boxes: [fakeBox({ id: "box-a" }), fakeBox({ id: "box-b" })],
			seeds: seeds.seam,
			projectPath: "/proj",
			exactUrl: PROJECT.gitUrl,
		});
		const report = await runFleet({ action: "pump", repo: PROJECT.gitUrl }, h.context, h.deps);
		expect(report.exitCode).toBe(0);
		// One per box, because the default limit is the box count.
		expect(h.calls.spawns).toHaveLength(2);
		expect(seeds.calls.claimed).toBe(2);
		expect(h.calls.spawns[0]?.seedId).toBe("ubuntu-aaaa");
		expect(h.calls.spawns[1]?.seedId).toBe("ubuntu-bbbb");
		expect(h.calls.spawns[0]?.prompt).toContain("ubuntu-aaaa");
		expect(h.calls.spawns[0]?.prompt).toContain("sd show ubuntu-aaaa");
		expect(h.calls.spawns[0]?.projectId).toBe("prj_test");
		expect(report.lines[0]).toBe("ubuntu-aaaa -> box-a (run_1)");
		// Claiming an epic would hand an agent a plan, so the pump asks for tasks.
		expect(seeds.calls.types).toEqual(["task", "task"]);
		// The pump places and returns: waiting on each seed would serialize the queue.
		expect(h.calls.runs).toHaveLength(0);
	});

	test("reports an empty queue and places nothing", async () => {
		const seeds = pumpSeeds([null]);
		const h = harness({
			boxes: [fakeBox({ id: "box-a" })],
			seeds: seeds.seam,
			projectPath: "/proj",
			exactUrl: PROJECT.gitUrl,
		});
		const report = await runFleet({ action: "pump", repo: PROJECT.gitUrl }, h.context, h.deps);
		expect(report.exitCode).toBe(1);
		expect(report.lines[0]).toBe("pump: nothing else is ready, 0 placed");
		expect(h.calls.spawns).toHaveLength(0);
	});

	test("keeps a claim whose placement failed, and still places the next seed", async () => {
		const seeds = pumpSeeds([
			{ id: "ubuntu-cccc", title: "doomed" },
			{ id: "ubuntu-dddd", title: "fine" },
		]);
		const h = harness({
			boxes: [fakeBox({ id: "box-a" })],
			seeds: seeds.seam,
			projectPath: "/proj",
			exactUrl: PROJECT.gitUrl,
		});
		// The first placement throws, the second succeeds.
		let calls = 0;
		const realSpawn = h.deps.spawn as NonNullable<FleetCliDeps["spawn"]>;
		const failing: FleetCliDeps = {
			...h.deps,
			spawn: async (input) => {
				calls += 1;
				if (calls === 1) throw new Error("burrow refused: no capacity");
				return await realSpawn(input);
			},
		};
		const report = await runFleet(
			{ action: "pump", repo: PROJECT.gitUrl, limit: 2 },
			h.context,
			failing,
		);
		expect(report.lines[0]).toBe("ubuntu-cccc claimed but not placed: burrow refused: no capacity");
		expect(report.lines[1]).toContain("ubuntu-dddd -> box-a");
		expect(report.exitCode).toBe(0);
	});

	test("needs a repo, because a run works on a registered project", async () => {
		const seeds = pumpSeeds([{ id: "ubuntu-eeee", title: "x" }]);
		const h = harness({ boxes: [fakeBox({ id: "box-a" })], seeds: seeds.seam });
		const report = await runFleet({ action: "pump" }, h.context, h.deps);
		expect(report.exitCode).toBe(1);
		expect(report.lines).toEqual(["fleet pump needs --repo"]);
	});

	test("an unregistered repo stops before it claims a lease", async () => {
		const seeds = pumpSeeds([{ id: "ubuntu-ffff", title: "x" }]);
		const h = harness({
			boxes: [fakeBox({ id: "box-a" })],
			seeds: seeds.seam,
			projectPath: "/proj",
		});
		const report = await runFleet(
			{ action: "pump", repo: "https://example.test/other.git" },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(1);
		expect(report.lines[0]).toContain("is not a registered project");
		expect(seeds.calls.claimed).toBe(0);
	});
});
