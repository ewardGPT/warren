/**
 * The wait stage of the seed-drain lane (ubuntu-6ab8).
 *
 * The wait is the part with the exit contract, so it gets its own suite: every
 * non-merge exit reports a reason, and the bound always terminates the loop.
 */

import { describe, expect, test } from "bun:test";
import {
	awaitSeedDrain,
	DEFAULT_SEED_DRAIN_WAIT_MS,
	type SeedDrainMergeState,
	type SeedDrainRunSnapshot,
} from "./seed-drain.ts";

describe("awaitSeedDrain", () => {
	/** Drive the wait with a scripted run-state sequence and a virtual clock. */
	async function wait(
		snapshots: Array<SeedDrainRunSnapshot | null>,
		over: {
			mergeState?: (prUrl: string) => Promise<SeedDrainMergeState>;
			timeoutMs?: number;
			pollMs?: number;
		} = {},
	) {
		let index = 0;
		let t = 0;
		return await awaitSeedDrain(
			{ runId: "run_abc" },
			{
				runState: async () => {
					const value = snapshots[Math.min(index, snapshots.length - 1)] ?? null;
					index += 1;
					return value;
				},
				...(over.mergeState !== undefined ? { mergeState: over.mergeState } : {}),
				sleep: async (ms) => {
					t += ms;
				},
				now: () => t,
				pollMs: over.pollMs ?? 10,
				timeoutMs: over.timeoutMs ?? 100,
			},
		);
	}

	test("reports merged when the run succeeds and its PR merged", async () => {
		const outcome = await wait(
			[{ state: "succeeded", failureReason: null, prUrl: "https://github.com/x/y/pull/1" }],
			{ mergeState: async () => "merged" },
		);
		expect(outcome.kind).toBe("merged");
		expect(outcome.state).toBe("succeeded");
		expect(outcome.prUrl).toBe("https://github.com/x/y/pull/1");
	});

	test("reports the failure reason when the run failed", async () => {
		const outcome = await wait([
			{ state: "failed", failureReason: "finalize_failed", prUrl: null },
		]);
		expect(outcome.kind).toBe("run_failed");
		expect(outcome.failureReason).toBe("finalize_failed");
		expect(outcome.detail).toBe("the run failed: finalize_failed");
	});

	test("a failed run with no recorded reason still names the failure", async () => {
		const outcome = await wait([{ state: "failed", failureReason: null, prUrl: null }]);
		expect(outcome.detail).toBe("the run failed");
	});

	test("the default sleep yields to the event loop", async () => {
		// Drives the `sleep` default: one poll, then a terminal snapshot.
		const snapshots: SeedDrainRunSnapshot[] = [
			{ state: "running", failureReason: null, prUrl: null },
			{ state: "cancelled", failureReason: null, prUrl: null },
		];
		let index = 0;
		const outcome = await awaitSeedDrain(
			{ runId: "run_abc" },
			{
				runState: async () => snapshots[Math.min(index++, snapshots.length - 1)] ?? null,
				pollMs: 1,
				timeoutMs: 1000,
			},
		);
		expect(outcome.kind).toBe("run_cancelled");
		expect(outcome.detail).toBe("the run was cancelled");
	});

	test("reports a cancelled run as cancelled", async () => {
		const outcome = await wait([{ state: "cancelled", failureReason: null, prUrl: null }]);
		expect(outcome.kind).toBe("run_cancelled");
		expect(outcome.state).toBe("cancelled");
	});

	test("reports a succeeded run with no PR", async () => {
		const outcome = await wait([{ state: "succeeded", failureReason: null, prUrl: null }]);
		expect(outcome.kind).toBe("run_succeeded_no_pr");
		expect(outcome.prUrl).toBeNull();
	});

	test("reports a PR that closed unmerged", async () => {
		const outcome = await wait(
			[{ state: "succeeded", failureReason: null, prUrl: "https://github.com/x/y/pull/2" }],
			{ mergeState: async () => "closed_unmerged" },
		);
		expect(outcome.kind).toBe("pr_closed_unmerged");
	});

	test("times out on a PR that stays open, and names the bound", async () => {
		const outcome = await wait(
			[{ state: "succeeded", failureReason: null, prUrl: "https://github.com/x/y/pull/3" }],
			{ mergeState: async () => "open", timeoutMs: 30, pollMs: 10 },
		);
		expect(outcome.kind).toBe("timed_out");
		expect(outcome.prUrl).toBe("https://github.com/x/y/pull/3");
		expect(outcome.detail).toContain("30ms");
		expect(outcome.polls).toBeGreaterThan(1);
	});

	test("times out on a run that never reaches terminal", async () => {
		const outcome = await wait([{ state: "running", failureReason: null, prUrl: null }], {
			timeoutMs: 30,
			pollMs: 10,
		});
		expect(outcome.kind).toBe("timed_out");
		expect(outcome.state).toBeNull();
		expect(outcome.detail).toContain("running");
	});

	test("reports a vanished run row", async () => {
		const outcome = await wait([null]);
		expect(outcome.kind).toBe("run_missing");
		expect(outcome.state).toBeNull();
	});

	test("bound disabled (timeoutMs 0) still settles on a terminal state", async () => {
		const outcome = await wait(
			[{ state: "succeeded", failureReason: null, prUrl: "https://github.com/x/y/pull/4" }],
			{ mergeState: async () => "merged", timeoutMs: 0 },
		);
		expect(outcome.kind).toBe("merged");
	});

	test("polls until the PR merges, then stops", async () => {
		const merges: SeedDrainMergeState[] = ["open", "open", "merged"];
		let t = 0;
		const outcome = await awaitSeedDrain(
			{ runId: "run_abc" },
			{
				runState: async () => ({
					state: "succeeded",
					failureReason: null,
					prUrl: "https://github.com/x/y/pull/5",
				}),
				mergeState: async () => merges.shift() ?? "merged",
				sleep: async (ms) => {
					t += ms;
				},
				now: () => t,
				pollMs: 10,
				timeoutMs: 10_000,
			},
		);
		expect(outcome.kind).toBe("merged");
		expect(outcome.polls).toBe(3);
	});

	test("the default bound is the documented thirty minutes", () => {
		expect(DEFAULT_SEED_DRAIN_WAIT_MS).toBe(30 * 60 * 1000);
	});
});
