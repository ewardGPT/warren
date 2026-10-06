import { describe, expect, test } from "bun:test";
import type { EventRow } from "../../db/schema.ts";
import {
	type BuildRunScorecardInput,
	buildRunScorecard,
	RUN_SCORECARD_SCHEMA,
	type ScorecardReapFacts,
	type ScorecardRunRow,
} from "./scorecard.ts";
import type { ReapExec } from "./types.ts";

const FACTS: ScorecardReapFacts = {
	noChanges: false,
	branchPushed: true,
	commitsAhead: 3,
	prUrl: "https://github.com/x/y/pull/1",
	pushProtection: { reason: "GH013" },
	mulchUpdated: 2,
	mulchAppended: 1,
	seedsClosed: 1,
	seedsCreated: 0,
};

const RUN_ROW: ScorecardRunRow = {
	costUsd: 1.25,
	tokensInput: 100,
	tokensOutput: 40,
	tokensCacheRead: 10,
	tokensCacheWrite: 2,
};

const NUMSTAT_EXEC: ReapExec = {
	run: async () => ({ stdout: "2\t3\tfile.ts\n-\t-\tbinary.dat\n", stderr: "" }),
};

function event(payload: unknown): EventRow {
	return { payloadJson: payload } as EventRow;
}

function baseInput(over: Partial<BuildRunScorecardInput> = {}): BuildRunScorecardInput {
	return {
		outcome: "succeeded",
		failureReason: null,
		state: FACTS,
		run: RUN_ROW,
		salvageRef: null,
		salvageBundlePath: null,
		providerError: false,
		events: [event({ type: "turn_end" }), event({ type: "text" }), event({ type: "turn_end" })],
		workspacePath: "/data/burrow/ws/run_1",
		baseBranch: "main",
		exec: NUMSTAT_EXEC,
		...over,
	};
}

describe("buildRunScorecard", () => {
	test("maps every deterministic fact onto the payload", async () => {
		const scorecard = await buildRunScorecard(baseInput());
		expect(scorecard).toEqual({
			schema: RUN_SCORECARD_SCHEMA,
			outcome: "succeeded",
			failureReason: null,
			noChanges: false,
			pushProtection: true,
			providerError: false,
			branchPushed: true,
			commitsAhead: 3,
			diffFiles: 2,
			diffLines: 5,
			prUrl: "https://github.com/x/y/pull/1",
			salvageRef: null,
			salvageBundlePath: null,
			costUsd: 1.25,
			tokensInput: 100,
			tokensOutput: 40,
			tokensCacheRead: 10,
			tokensCacheWrite: 2,
			turns: 2,
			mulchUpdated: 2,
			mulchAppended: 1,
			seedsClosed: 1,
			seedsCreated: 0,
		});
	});

	test("carries the failure discriminator on failed runs", async () => {
		const scorecard = await buildRunScorecard(
			baseInput({ outcome: "failed", failureReason: "dropped_commit" }),
		);
		expect(scorecard.outcome).toBe("failed");
		expect(scorecard.failureReason).toBe("dropped_commit");
	});

	test("renders a cancelled run with no failure reason", async () => {
		const scorecard = await buildRunScorecard(
			baseInput({ outcome: "cancelled", failureReason: null }),
		);
		expect(scorecard.outcome).toBe("cancelled");
		expect(scorecard.failureReason).toBeNull();
	});

	test("counts only turn_end events as turns", async () => {
		const scorecard = await buildRunScorecard(
			baseInput({
				events: [
					event({ type: "turn_end" }),
					event({ type: "turn_end", message: { role: "assistant" } }),
					event(null),
					event("plain string"),
					event({ type: "text", text: "hi" }),
					event({ not: "an object type" }),
				],
			}),
		);
		expect(scorecard.turns).toBe(2);
	});

	test("flips push-protection and provider-error flags only when present", async () => {
		const clean = await buildRunScorecard(
			baseInput({
				state: { ...FACTS, pushProtection: null },
				providerError: true,
			}),
		);
		expect(clean.pushProtection).toBe(false);
		expect(clean.providerError).toBe(true);
	});

	test("nulls diff stats without a workspace or base branch", async () => {
		const noWorkspace = await buildRunScorecard(baseInput({ workspacePath: null }));
		expect(noWorkspace.diffFiles).toBeNull();
		expect(noWorkspace.diffLines).toBeNull();
		const noBase = await buildRunScorecard(baseInput({ baseBranch: "" }));
		expect(noBase.diffFiles).toBeNull();
	});

	test("degrades diff stats when the git call fails", async () => {
		const failing: ReapExec = {
			run: async () => {
				throw new Error("git: not a git repository");
			},
		};
		const scorecard = await buildRunScorecard(baseInput({ exec: failing }));
		expect(scorecard.diffFiles).toBeNull();
		expect(scorecard.diffLines).toBeNull();
	});

	test("counts binary numstat rows as files with zero lines", async () => {
		const exec: ReapExec = {
			run: async () => ({ stdout: "-\t-\tbinary.dat\nx\ty\tnumeric.ts\n", stderr: "" }),
		};
		const scorecard = await buildRunScorecard(baseInput({ exec }));
		expect(scorecard.diffFiles).toBe(2);
		expect(scorecard.diffLines).toBe(0);
	});
});
