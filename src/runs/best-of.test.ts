import { describe, expect, test } from "bun:test";
import {
	BEST_OF_MAX_REPLICATES,
	BEST_OF_MIN_REPLICATES,
	BEST_OF_TRIGGER,
	type BestOfCollectDeps,
	type BestOfCollectInput,
	type BestOfCollectResult,
	type BestOfRunFacts,
	collectBestOf,
	rankBestOf,
} from "./best-of.ts";
import type { RunScorecard } from "./reap/scorecard.ts";

const BASE_SCORECARD: RunScorecard = {
	schema: 1,
	outcome: "succeeded",
	failureReason: null,
	noChanges: false,
	pushProtection: false,
	providerError: false,
	branchPushed: true,
	commitsAhead: 1,
	diffFiles: null,
	diffLines: null,
	prUrl: null,
	salvageRef: null,
	salvageBundlePath: null,
	costUsd: 0.1,
	tokensInput: null,
	tokensOutput: null,
	tokensCacheRead: null,
	tokensCacheWrite: null,
	turns: 0,
	mulchUpdated: 0,
	mulchAppended: 0,
	seedsClosed: 0,
	seedsCreated: 0,
};

function scored(over: Partial<RunScorecard>): RunScorecard {
	return { ...BASE_SCORECARD, ...over };
}

function facts(id: string, scorecard: RunScorecard): BestOfRunFacts {
	return { runId: id, scorecard };
}

describe("rankBestOf", () => {
	test("real work beats an empty success beats a failure", () => {
		const ranked = rankBestOf([
			facts("failed", scored({ outcome: "failed", failureReason: "crashed" })),
			facts("empty", scored({ noChanges: true, commitsAhead: null })),
			facts("worked", scored({ branchPushed: true, commitsAhead: 3 })),
		]);
		expect(ranked.map((run) => run.runId)).toEqual(["worked", "empty", "failed"]);
	});

	test("an all-failed batch yields a best-failed pick", () => {
		const ranked = rankBestOf([
			facts("later", scored({ outcome: "failed", failureReason: "crashed", commitsAhead: null })),
			facts(
				"earlier",
				scored({ outcome: "failed", failureReason: "dropped_commit", commitsAhead: 0 }),
			),
		]);
		expect(ranked.map((run) => run.runId)).toEqual(["earlier", "later"]);
	});

	test("within a tier: more commits ahead first, then lower cost, then run id", () => {
		const ranked = rankBestOf([
			facts("cheap", scored({ commitsAhead: 2, costUsd: 0.3 })),
			facts("rich", scored({ commitsAhead: 2, costUsd: 0.9 })),
			facts("ahead", scored({ commitsAhead: 5, costUsd: 2 })),
		]);
		expect(ranked.map((run) => run.runId)).toEqual(["ahead", "cheap", "rich"]);
	});

	test("unknown commit counts rank below numeric counts", () => {
		const ranked = rankBestOf([
			facts("unknown", scored({ commitsAhead: null })),
			facts("zero", scored({ commitsAhead: 0 })),
		]);
		expect(ranked.map((run) => run.runId)).toEqual(["zero", "unknown"]);
	});

	test("returns an empty ranking for no input", () => {
		expect(rankBestOf([])).toEqual([]);
	});
});

describe("collectBestOf", () => {
	const INPUT: BestOfCollectInput = {
		projectId: "prj_xxxxxxxxxxxx",
		agentName: "refactor-bot",
		prompt: "Implement the retry",
		seedId: "warren-1a2b",
		replicates: 2,
	};

	async function collect(
		over: {
			input?: BestOfCollectInput;
			scorecards?: Record<string, RunScorecard | null | undefined>;
			firstPollMissing?: boolean;
			deadlineMs?: number;
		} = {},
	): Promise<{ result: BestOfCollectResult; spawned: BestOfSpawnRecord[] }> {
		const spawned: BestOfSpawnRecord[] = [];
		const firstPolled = new Set<string>();
		let t = 0;
		const deps: BestOfCollectDeps = {
			spawn: async (input) => {
				spawned.push({
					prompt: input.prompt,
					trigger: input.trigger,
					seedId: input.seedId,
					modelOverride: input.modelOverride,
				});
				return `run_${spawned.length}`;
			},
			scorecard: async (runId) => {
				if (over.firstPollMissing === true && !firstPolled.has(runId)) {
					firstPolled.add(runId);
					return null;
				}
				const value = over.scorecards?.[runId];
				return value === undefined ? null : value;
			},
			sleep: async () => {
				t += 1000;
			},
			now: () => t,
			deadlineMs: over.deadlineMs ?? 5000,
			pollMs: 1000,
		};
		const result = await collectBestOf(over.input ?? INPUT, deps);
		return { result, spawned };
	}

	interface BestOfSpawnRecord {
		readonly prompt: string;
		readonly trigger: string;
		readonly seedId?: string;
		readonly modelOverride?: string;
	}

	test("spawns every replicate with an approach marker, trigger, and seed", async () => {
		const { spawned } = await collect();
		expect(spawned).toHaveLength(2);
		expect(spawned[0]?.prompt).toContain("Approach 1 of 2");
		expect(spawned[1]?.prompt).toContain("Approach 2 of 2");
		expect(spawned[0]?.prompt).toContain("Implement the retry");
		expect(spawned[0]?.trigger).toBe(BEST_OF_TRIGGER);
		expect(spawned[0]?.seedId).toBe("warren-1a2b");
	});

	test("cycles model tiers across replicates", async () => {
		const { spawned } = await collect({
			input: { ...INPUT, replicates: 3, tiers: ["sonnet", "opus"] },
		});
		expect(spawned.map((s) => s.modelOverride)).toEqual(["sonnet", "opus", "sonnet"]);
	});

	test("ranks the batch once every replicate is terminal", async () => {
		const { result } = await collect({
			scorecards: {
				run_1: scored({ outcome: "failed", failureReason: "crashed" }),
				run_2: scored({ commitsAhead: 4, costUsd: 0.2 }),
			},
			deadlineMs: 0,
		});
		expect(result.winner?.runId).toBe("run_2");
		expect(result.pendingRunIds).toEqual([]);
		expect(result.ranked.map((run) => run.runId)).toEqual(["run_2", "run_1"]);
	});

	test("polls until scorecards appear, then stops", async () => {
		const { result } = await collect({
			scorecards: {
				run_1: scored({ commitsAhead: 1 }),
				run_2: scored({ commitsAhead: 2 }),
			},
			firstPollMissing: true,
			deadlineMs: 100000,
		});
		expect(result.ranked).toHaveLength(2);
		expect(result.pendingRunIds).toEqual([]);
	});

	test("reports runs still pending at the deadline", async () => {
		const { result } = await collect({ deadlineMs: 3500 });
		expect(result.ranked).toEqual([]);
		expect(result.pendingRunIds).toEqual(["run_1", "run_2"]);
		expect(result.winner).toBeNull();
	});

	test("rejects a replicate count outside 2..5", async () => {
		await expect(collect({ input: { ...INPUT, replicates: 1 } })).rejects.toBeInstanceOf(
			RangeError,
		);
		await expect(
			collect({ input: { ...INPUT, replicates: BEST_OF_MAX_REPLICATES + 1 } }),
		).rejects.toBeInstanceOf(RangeError);
		expect(BEST_OF_MIN_REPLICATES).toBe(2);
	});
});
