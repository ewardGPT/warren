/**
 * `warren fleet <status|config|dispatch>` through its seam. The `pump` verb's
 * tests live in `fleet.pump.test.ts`; the shared fake boxes / stub seams live in
 * `fleet-harness.ts`.
 *
 * Nothing here reads a real fleet config, opens a socket, or touches a
 * database. The boxes are fake `FleetBoxRuntime`s whose client only has to
 * answer the two calls the real `probeBoxes` makes (`probe`, then
 * `burrows.list`), and the placing verbs get stub `spawnRun` / `runRun` seams
 * plus a stub project repo.
 */

import { describe, expect, test } from "bun:test";
import type { CliContext } from "../output.ts";
import { runFleet } from "./fleet.ts";
import { fakeBox, harness, NOOP_STDIO, PROJECT, type StatusJson } from "./fleet-harness.ts";

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
