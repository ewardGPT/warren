/**
 * `warren fleet <status|dispatch>` through its seam.
 *
 * Every test injects a provider (`FleetCliDeps.provider`), so nothing here
 * reads a real fleet config or opens a socket: the boxes are fake
 * `FleetBoxRuntime`s whose client only has to answer the two calls the real
 * `probeBoxes` makes (`probe`, then `burrows.list`).
 */

import { describe, expect, test } from "bun:test";
import type { RunHandle, RunSpec } from "../../runtime/contract.ts";
import type { FleetBoxRuntime } from "../../runtime/local/fleet/index.ts";
import type { CliContext, Stdio } from "../output.ts";
import { type FleetCliDeps, runFleet } from "./fleet.ts";

/** runFleet returns its lines; it never writes to stdio. */
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

interface FleetCalls {
	readonly create: RunSpec[];
	readonly terminated: RunHandle[];
	statusCount: number;
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
 * A provider whose `status` walks `phases` in order (the last phase repeats), so
 * a `--wait` test reaches a terminal answer within `maxPolls` without sleeping.
 */
function harness(options: {
	boxes: readonly FleetBoxRuntime[];
	phases?: readonly string[];
	createError?: string;
	maxPolls?: number;
}): FleetHarness {
	const calls: FleetCalls = { create: [], terminated: [], statusCount: 0 };
	const phases = options.phases ?? ["succeeded"];
	let index = 0;
	const provider: NonNullable<FleetCliDeps["provider"]> = {
		boxes: options.boxes,
		create: async (spec: RunSpec): Promise<RunHandle> => {
			calls.create.push(spec);
			if (options.createError !== undefined) throw new Error(options.createError);
			const box = options.boxes[0]?.id ?? "box";
			return { runId: spec.runId, sandboxId: "sandbox-07", providerRunId: `${box}/inner-run` };
		},
		status: async (_handle: RunHandle) => {
			calls.statusCount += 1;
			const phase = phases[Math.min(index, phases.length - 1)] ?? "running";
			index += 1;
			return { phase, exitCode: phase === "succeeded" ? 0 : 1, exists: true };
		},
		terminate: async (handle: RunHandle): Promise<unknown> => {
			calls.terminated.push(handle);
			return {};
		},
	};
	const context: CliContext = {
		env: {},
		stdio: NOOP_STDIO,
		spawn: () => Promise.reject(new Error("fleet must not spawn")),
	};
	const deps: FleetCliDeps = {
		provider,
		env: {},
		pollMs: 1,
		maxPolls: options.maxPolls ?? 3,
	};
	return { context, deps, calls };
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
		expect(h.calls.create).toHaveLength(0);
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
		expect(h.calls.create).toHaveLength(0);
	});

	test("places the run on a box and returns without waiting or terminating", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })] });
		const report = await runFleet(
			{ action: "dispatch", repo: "https://example.test/x.git", prompt: "go" },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(0);
		expect(report.lines[0]).toBe(`dispatched ${h.calls.create[0]?.runId} on box-a`);
		expect(report.lines[1]).toContain("sandbox sandbox-07");
		expect(h.calls.create).toHaveLength(1);
		expect(h.calls.statusCount).toBe(0);
		expect(h.calls.terminated).toHaveLength(0);
	});

	test("passes repo, prompt, branch, base branch and runtime through to create", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })] });
		const report = await runFleet(
			{
				action: "dispatch",
				repo: "https://example.test/x.git",
				prompt: "do the thing",
				branch: "warren/ticket",
				baseBranch: "develop",
				runtime: "codex",
			},
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(0);
		const spec = h.calls.create[0];
		expect(spec?.originUrl).toBe("https://example.test/x.git");
		expect(spec?.prompt).toBe("do the thing");
		expect(spec?.branch).toBe("warren/ticket");
		expect(spec?.baseBranch).toBe("develop");
		expect(spec?.runtimeId).toBe("codex");
		expect(spec?.mode).toBe("batch");
		// The agent needs the host network namespace to reach a model gateway.
		// bwrap treats `restricted` without a proxy address as deny-all, so a
		// dispatch that selected it would leave the agent with no model.
		expect(spec?.network).toBe("open");
		expect(spec?.runId.startsWith("fleet-")).toBe(true);
		expect(spec?.metadata).toBeUndefined();
	});

	test("folds a provider and model override into the run's frontmatter", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })] });
		await runFleet(
			{
				action: "dispatch",
				repo: "https://example.test/x.git",
				prompt: "go",
				provider: "headroom-bifrost",
				model: "deepseek-v4-flash",
			},
			h.context,
			h.deps,
		);
		// burrow reads run metadata's frontmatter and turns it into the agent's
		// `--provider`/`--model` flags, which is how a box's own gateway is chosen.
		expect(h.calls.create[0]?.metadata).toEqual({
			frontmatter: {
				source: "builtin",
				provider: "headroom-bifrost",
				model: "deepseek-v4-flash",
			},
		});
	});

	test("defaults the branch and runtime a bare dispatch leaves out", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })] });
		await runFleet(
			{ action: "dispatch", repo: "https://example.test/x.git", prompt: "go" },
			h.context,
			h.deps,
		);
		expect(h.calls.create[0]?.branch).toBe("warren/fleet-run");
		expect(h.calls.create[0]?.baseBranch).toBe("main");
		expect(h.calls.create[0]?.runtimeId).toBe("pi");
	});

	test("--wait polls to success, terminates the box and exits 0", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })], phases: ["running", "succeeded"] });
		const report = await runFleet(
			{ action: "dispatch", repo: "https://example.test/x.git", prompt: "go", wait: true },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(0);
		expect(h.calls.statusCount).toBe(2);
		expect(h.calls.terminated).toHaveLength(1);
		expect(report.lines.at(-1)).toContain("succeeded (exit 0)");
	});

	test("--wait on a failed run terminates and exits 1", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })], phases: ["failed"] });
		const report = await runFleet(
			{ action: "dispatch", repo: "https://example.test/x.git", prompt: "go", wait: true },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(1);
		expect(h.calls.terminated).toHaveLength(1);
		expect(report.lines.at(-1)).toContain("failed (exit 1)");
	});

	test("--wait gives up after maxPolls rather than hanging", async () => {
		const h = harness({ boxes: [fakeBox({ id: "box-a" })], phases: ["running"], maxPolls: 2 });
		const report = await runFleet(
			{ action: "dispatch", repo: "https://example.test/x.git", prompt: "go", wait: true },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(1);
		expect(h.calls.statusCount).toBe(3);
		expect(h.calls.terminated).toHaveLength(1);
		expect(report.lines.at(-1)).toContain("running");
	});

	test("a create failure is reported with its message and exits 1", async () => {
		const h = harness({
			boxes: [fakeBox({ id: "box-a" })],
			createError: "burrow refused: no capacity",
		});
		const report = await runFleet(
			{ action: "dispatch", repo: "https://example.test/x.git", prompt: "go" },
			h.context,
			h.deps,
		);
		expect(report.exitCode).toBe(1);
		expect(report.lines).toEqual(["fleet dispatch failed: burrow refused: no capacity"]);
		expect(h.calls.terminated).toHaveLength(0);
	});
});
