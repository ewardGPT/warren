/**
 * Wait stage of the seed-drain lane (ubuntu-6ab8).
 *
 * Observe one dispatched run to a terminal outcome. The wait is bounded and
 * every exit carries a reason: the run failed (with its failure reason) or was
 * cancelled, the run succeeded without a PR, the PR closed unmerged, the PR
 * merged, the run row vanished, or the wait budget elapsed. A poll loop with
 * no exit is not an outcome, so the deadline is always armed and the default
 * budget lives here as {@link DEFAULT_SEED_DRAIN_WAIT_MS}.
 */

import { isTerminalRunState } from "../core/wire.ts";
import type { RunFailureReason, RunState, RunTerminalState } from "../db/schema.ts";

/** Default wait budget for one drain: 30 minutes. `0` disables the bound. */
export const DEFAULT_SEED_DRAIN_WAIT_MS = 30 * 60 * 1000;

/** Default poll cadence while a run or its PR is unresolved. */
export const DEFAULT_SEED_DRAIN_POLL_MS = 10_000;

/** The slice of a run row the wait needs. */
export interface SeedDrainRunSnapshot {
	readonly state: RunState;
	readonly failureReason: RunFailureReason | null;
	readonly prUrl: string | null;
}

/** Merge state of the run's pull request. `unknown` means "not known yet". */
export type SeedDrainMergeState = "open" | "merged" | "closed_unmerged" | "unknown";

export interface SeedDrainWaitDeps {
	/** The run's current row, or `null` when the run row is gone. */
	readonly runState: (runId: string) => Promise<SeedDrainRunSnapshot | null>;
	/** Merge state of the run's PR URL; absent ⇒ `unknown` while the PR exists. */
	readonly mergeState?: (prUrl: string) => Promise<SeedDrainMergeState>;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	/** Default {@link DEFAULT_SEED_DRAIN_POLL_MS}. */
	readonly pollMs?: number;
	/** Default {@link DEFAULT_SEED_DRAIN_WAIT_MS}; `0` disables the bound. */
	readonly timeoutMs?: number;
}

export type SeedDrainOutcomeKind =
	| "merged"
	| "run_failed"
	| "run_cancelled"
	| "run_succeeded_no_pr"
	| "pr_closed_unmerged"
	| "run_missing"
	| "timed_out";

export interface SeedDrainOutcome {
	readonly kind: SeedDrainOutcomeKind;
	readonly runId: string;
	/** Terminal run state, or `null` when the run never reached one. */
	readonly state: RunTerminalState | null;
	readonly failureReason: RunFailureReason | null;
	readonly prUrl: string | null;
	/** One human-readable line naming what happened. */
	readonly detail: string;
	readonly waitedMs: number;
	readonly polls: number;
}

/**
 * Observe one drained run to a terminal outcome, bounded by `timeoutMs`.
 *
 * The wait settles when the run fails or is cancelled (the failure reason is
 * reported), when the run succeeds with no PR, when the PR closes unmerged, or
 * when the PR merges. A run that succeeded with its PR still open keeps
 * polling until the deadline, which reports `timed_out`.
 */
export async function awaitSeedDrain(
	input: { readonly runId: string },
	deps: SeedDrainWaitDeps,
): Promise<SeedDrainOutcome> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? defaultSleep;
	const pollMs = deps.pollMs ?? DEFAULT_SEED_DRAIN_POLL_MS;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_SEED_DRAIN_WAIT_MS;
	const startedAt = now();
	const deadline = timeoutMs > 0 ? startedAt + timeoutMs : Number.POSITIVE_INFINITY;
	let polls = 0;
	let snapshot: SeedDrainRunSnapshot | null = null;

	for (;;) {
		polls += 1;
		snapshot = await deps.runState(input.runId);
		if (snapshot === null) {
			return finish("run_missing", input.runId, null, null, startedAt, polls, now, timeoutMs);
		}
		if (isTerminalRunState(snapshot.state)) {
			const kind = await terminalKind(snapshot, deps);
			if (kind !== "wait") {
				return finish(
					kind,
					input.runId,
					snapshot,
					snapshot.prUrl,
					startedAt,
					polls,
					now,
					timeoutMs,
				);
			}
		}
		if (now() >= deadline) {
			return finish(
				"timed_out",
				input.runId,
				snapshot,
				snapshot.prUrl,
				startedAt,
				polls,
				now,
				timeoutMs,
			);
		}
		await sleep(pollMs);
	}
}

/**
 * Which outcome a terminal run row implies, or `wait` when the run finished
 * but its pull request is still open.
 */
async function terminalKind(
	snapshot: SeedDrainRunSnapshot,
	deps: SeedDrainWaitDeps,
): Promise<SeedDrainOutcomeKind | "wait"> {
	if (snapshot.state === "failed") return "run_failed";
	if (snapshot.state === "cancelled") return "run_cancelled";
	if (snapshot.prUrl === null) return "run_succeeded_no_pr";
	const merge = (await deps.mergeState?.(snapshot.prUrl)) ?? "unknown";
	if (merge === "merged") return "merged";
	return merge === "closed_unmerged" ? "pr_closed_unmerged" : "wait";
}

/** Build the terminal outcome, timing and detail included. */
function finish(
	kind: SeedDrainOutcomeKind,
	runId: string,
	snapshot: SeedDrainRunSnapshot | null,
	prUrl: string | null,
	startedAt: number,
	polls: number,
	now: () => number,
	timeoutMs: number,
): SeedDrainOutcome {
	return {
		kind,
		runId,
		state: snapshot !== null && isTerminalRunState(snapshot.state) ? snapshot.state : null,
		failureReason: snapshot?.failureReason ?? null,
		prUrl,
		detail: drainDetail(kind, snapshot, prUrl, timeoutMs),
		waitedMs: Math.max(0, now() - startedAt),
		polls,
	};
}

function drainDetail(
	kind: SeedDrainOutcomeKind,
	snapshot: SeedDrainRunSnapshot | null,
	prUrl: string | null,
	timeoutMs: number,
): string {
	switch (kind) {
		case "merged":
			return "the pull request merged";
		case "run_failed":
			return snapshot?.failureReason == null
				? "the run failed"
				: `the run failed: ${snapshot.failureReason}`;
		case "run_cancelled":
			return "the run was cancelled";
		case "run_succeeded_no_pr":
			return "the run succeeded without a pull request";
		case "pr_closed_unmerged":
			return "the pull request closed without merging";
		case "run_missing":
			return "the run row no longer exists";
		case "timed_out":
			return prUrl === null
				? `the run stayed ${snapshot?.state ?? "unknown"} for the whole wait budget (${timeoutMs}ms)`
				: `pull request ${prUrl} stayed open for the whole wait budget (${timeoutMs}ms)`;
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
