import { describe, expect, test } from "bun:test";
import type { Repos } from "../db/repos/index.ts";
import type { PlanRunChildRow } from "../db/schema.ts";
import { type Harness, NOW, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type CoordinatorSpawnFn, DEFAULT_MAX_ROUNDS } from "./coordinator.ts";

const prOpenChild = (planRunId: string, runId: string): PlanRunChildRow =>
	({
		seq: 1,
		seedId: "warren-a",
		state: "pr_open",
		planRunId,
		runId,
	}) as PlanRunChildRow;

/**
 * Pathological repos: listChildren always reports a pr_open child whose PR
 * keeps resolving merged (the DB write that would terminal it is bypassed),
 * and pickNextPending always yields another pending child. A naive `for(;;)`
 * loop would spin forever; the guard must fail the plan after maxRounds.
 */
function spinningRepos(h: Harness, runId: string): Repos {
	const base = h.repos;
	const planRuns = Object.create(base.planRuns);
	planRuns.listChildren = async () => [prOpenChild(h.planRun.id, runId)];
	planRuns.pickNextPending = async () =>
		({
			seq: 1,
			seedId: "warren-a",
			state: "pending" as const,
			planRunId: h.planRun.id,
			runId: null,
		}) as PlanRunChildRow;
	return { ...base, planRuns };
}

describe("advancePlanRun — max-rounds guard (warren-guard)", () => {
	test("default cap exists and is positive", () => {
		expect(DEFAULT_MAX_ROUNDS).toBeGreaterThan(0);
	});

	test("spinning repo fails the plan after maxRounds", async () => {
		const h = await setup();
		try {
			const runId = await h.makeRun("warren-a");
			await h.repos.runs.markRunning(runId, NOW);
			await h.repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/1");
			await h.repos.runs.finalize(runId, "succeeded", NOW);
			const spawn: CoordinatorSpawnFn = async ({ child, prompt }) => {
				const run = await h.repos.runs.create({
					agentName: "claude-code",
					projectId: h.projectId,
					prompt,
					renderedAgentJson: { sections: {} },
					trigger: "plan-run",
					seedId: child.seedId,
					now: NOW,
				});
				return { runId: run.id };
			};
			const result = await advancePlanRun({
				planRun: h.planRun,
				repos: spinningRepos(h, runId),
				showSeed: h.showSeedStub("open"),
				checkPrMerged: async () => ({ kind: "merged", mergedAt: NOW.toISOString() }),
				spawn,
				emit: h.emit,
				now: () => NOW,
				maxRounds: 3,
			});
			expect(result.kind).toBe("plan_failed");
			if (result.kind === "plan_failed") {
				expect(result.reason).toContain("max rounds (3)");
			}
			const reloaded = await h.repos.planRuns.require(h.planRun.id);
			expect(reloaded.state).toBe("failed");
			expect(reloaded.failureReason).toContain("max rounds (3)");
		} finally {
			await h.db.close();
		}
	});

	test("large maxRounds does not interfere with normal completion", async () => {
		const h = await setup();
		try {
			const result = await advancePlanRun({
				planRun: h.planRun,
				repos: h.repos,
				showSeed: h.showSeedStub("open"),
				checkPrMerged: async () => ({ kind: "open" as const }),
				spawn: h.spawnStub(() => "run_x"),
				emit: h.emit,
				now: () => NOW,
				maxRounds: 1000,
			});
			expect(result.kind).toBe("dispatched");
		} finally {
			await h.db.close();
		}
	});
});
