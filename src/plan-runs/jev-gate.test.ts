import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../decide/index.ts";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun } from "./coordinator.ts";
import {
	continuationVerdict,
	countChildren,
	judgeContinuation,
	type PlanContinuationEvidence,
	planGateEnabled,
} from "./jev-gate.ts";

const decided = (noul: number): Decision => ({
	outcome: "decided",
	answers: { proceed: { noul } },
	band: noul >= 0.9 ? "act" : noul <= 0.1 ? "hold" : "ask",
	provider: "stub",
	model: "jev-stub",
	ms: 3,
	via: "stub",
});

const EVIDENCE: PlanContinuationEvidence = {
	planRunId: "pr-1",
	projectId: "p",
	completedChildren: 2,
	failedChildren: 0,
	remainingChildren: 1,
	nextChildSeq: 3,
	nextSeedId: "warren-abc",
};

describe("continuationVerdict", () => {
	test("act continues", () => {
		expect(continuationVerdict(decided(0.96))).toEqual({ kind: "continue" });
	});

	test("hold stops and names the band", () => {
		const verdict = continuationVerdict(decided(0.02));
		expect(verdict.kind).toBe("stop");
		expect(verdict.kind === "stop" ? verdict.band : "").toBe("hold");
	});

	test("an unanswered question stops as ask, never as permission to proceed", () => {
		for (const decision of [
			{ outcome: "unavailable", reason: "no key" },
			{ outcome: "over-budget", reason: "cap" },
			{ outcome: "unsure", reason: "nothing to ask" },
		] as const) {
			const verdict = continuationVerdict(decision);
			expect(verdict.kind).toBe("stop");
			expect(verdict.kind === "stop" ? verdict.band : "").toBe("ask");
			expect(verdict.kind === "stop" ? verdict.reason : "").toContain(decision.reason);
		}
	});
});

describe("countChildren", () => {
	test("splits finished, failed and in-flight children", () => {
		expect(countChildren(["merged", "skipped", "failed", "running", "pending"])).toEqual({
			completed: 2,
			failed: 1,
			remaining: 2,
		});
	});
});

describe("planGateEnabled", () => {
	test("only an explicit truthy flag opens the gate", () => {
		expect(planGateEnabled({})).toBe(false);
		expect(planGateEnabled({ WARREN_JEV_PLAN_GATE: "0" })).toBe(false);
		expect(planGateEnabled({ WARREN_JEV_PLAN_GATE: "TRUE" })).toBe(true);
		expect(planGateEnabled({ WARREN_JEV_PLAN_GATE: "1" })).toBe(true);
	});
});

describe("judgeContinuation (offline provider)", () => {
	const dirs: string[] = [];

	async function fixtureWith(noul: number): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "jev-gate-"));
		dirs.push(dir);
		const path = join(dir, "fixture.json");
		await writeFile(
			path,
			JSON.stringify({ model: "fake", defaults: { noul: { noul } }, usage: {} }),
		);
		return path;
	}

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	test("a confident answer continues", async () => {
		const env = { WARREN_JEV_STUB: "1", WARREN_JEV_STUB_FIXTURE: await fixtureWith(0.97) };
		expect(await judgeContinuation(EVIDENCE, { env })).toEqual({ kind: "continue" });
	});

	test("a low answer stops at hold", async () => {
		const env = { WARREN_JEV_STUB: "1", WARREN_JEV_STUB_FIXTURE: await fixtureWith(0.01) };
		const verdict = await judgeContinuation(EVIDENCE, { env });
		expect(verdict.kind).toBe("stop");
		expect(verdict.kind === "stop" ? verdict.band : "").toBe("hold");
	});
});

describe("advancePlanRun with a continuation gate", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	async function run(input: { verdict: "continue" | "ask" | "hold" }): Promise<{
		kind: string;
		reason?: string;
		spawned: number;
	}> {
		let spawned = 0;
		const spawn = h.spawnStub(() => "run_x");
		const result = await advancePlanRun({
			planRun: h.planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: (spawnInput) => {
				spawned += 1;
				return spawn(spawnInput);
			},
			emit: h.emit,
			now: () => NOW,
			judgeContinuation: async () =>
				input.verdict === "continue"
					? { kind: "continue" }
					: { kind: "stop", band: input.verdict, reason: `jevs_${input.verdict}` },
		});
		return {
			kind: result.kind,
			...(result.kind === "plan_failed" ? { reason: result.reason } : {}),
			spawned,
		};
	}

	test("a continue verdict dispatches the first child", async () => {
		const outcome = await run({ verdict: "continue" });
		expect(outcome.kind).toBe("dispatched");
		expect(outcome.spawned).toBe(1);
	});

	test("an ask verdict fails the plan loudly and dispatches nothing", async () => {
		const outcome = await run({ verdict: "ask" });
		expect(outcome.kind).toBe("plan_failed");
		expect(outcome.reason).toContain("plan_gate_ask:");
		expect(outcome.spawned).toBe(0);
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toContain("plan_gate_ask:");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
		// The stop happened before the first dispatch, so there is no run to
		// attach a `plan_run.failed` event to; the plan row carries the reason.
		expect(h.events).toEqual([]);
	});

	test("a hold verdict fails the plan and dispatches nothing", async () => {
		const outcome = await run({ verdict: "hold" });
		expect(outcome.kind).toBe("plan_failed");
		expect(outcome.reason).toContain("plan_gate_hold:");
		expect(outcome.spawned).toBe(0);
	});

	test("no judge means no gate: the plan dispatches as it always did", async () => {
		let spawned = 0;
		const result = await advancePlanRun({
			planRun: h.planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: (spawnInput) => {
				spawned += 1;
				return h.spawnStub(() => "run_x")(spawnInput);
			},
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
		expect(spawned).toBe(1);
	});
});
