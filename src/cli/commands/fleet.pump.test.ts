/**
 * `warren fleet pump` through its seam. Split out of `fleet.test.ts`
 * (warren-4553) to keep each test file under the repo's size threshold; the
 * shared fake boxes / stub seams live in `fleet-harness.ts`.
 *
 * Nothing here reads a real fleet config, opens a socket, or touches a
 * database — the pump's claims, placements and leases all go through the stub
 * `seeds` / `spawn` seams the harness injects.
 */

import { describe, expect, test } from "bun:test";
import { type FleetCliDeps, runFleet } from "./fleet.ts";
import { fakeBox, harness, PROJECT, pumpSeeds } from "./fleet-harness.ts";

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
