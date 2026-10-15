/**
 * Age-based retention for transient `never_started` runs (ubuntu-4f98).
 *
 * When the runtime is unreachable, the scheduler mints a run row per tick and
 * fails it as `never_started`; its bounded-retry GC (`RunsRepo.deleteNeverStarted`,
 * warren-a0a2) drops those rows one at a time, but only for the trigger that
 * minted them, and only while the retry tracker still holds them. A long
 * outage — or a lane that keeps posting to a dead box — leaves the backlog on
 * disk: on the live instance this is ~59k rows and their events, i.e. the
 * bulk of both tables.
 *
 * This module is the age-based half of that cleanup. Nothing here is wired
 * into boot: an operator runs it, decides the cutoff, and sees the counts.
 * The guard is the same one the single-row path enforces (the select *and*
 * the delete re-check `state=failed` + `failure_reason=never_started`), so a
 * page that raced a real dispatch is skipped rather than deleted.
 *
 * Batching is the point of the loop, not an optimisation detail: one
 * transaction over ~59k rows would hold the write lock for the whole sweep,
 * and the WAL would grow by the size of the delete before any of it is
 * reclaimable. Each batch is one transaction holding at most `batchSize`
 * run rows and their events; the caller caps the sweep with `maxBatches`.
 */

import { ValidationError } from "../core/errors.ts";

/** Default age cutoff — a fortnight is comfortably past any retry window. */
export const DEFAULT_RETENTION_DAYS = 14;
/** Default rows per delete transaction. */
export const DEFAULT_RETENTION_BATCH = 500;

/**
 * The `RunsRepo` surface retention needs. Declared structurally so the sweep
 * can be exercised against a stub, and so a future Postgres-backed repo plugs
 * in unchanged.
 */
export interface RetentionRunsRepo {
	listExpiredNeverStartedIds(opts: { cutoff: string; limit: number }): Promise<string[]>;
	deleteNeverStartedBatch(ids: readonly string[]): Promise<{ runs: number; events: number }>;
}

export interface PruneNeverStartedInput {
	readonly runs: RetentionRunsRepo;
	/** Age cutoff in ms before `now`; rows terminal on or after it are kept. */
	readonly olderThanMs: number;
	readonly batchSize?: number;
	/** Stop after this many batches. `0` (default) sweeps until exhausted. */
	readonly maxBatches?: number;
	readonly now?: () => Date;
}

export interface PruneNeverStartedResult {
	/** The resolved cutoff, echoed so the operator can audit what it kept. */
	readonly cutoff: string;
	readonly batches: number;
	readonly runs: number;
	readonly events: number;
	/**
	 * True when the last page came back short — every eligible row at the
	 * cutoff was handled. False means the sweep stopped early (the batch cap,
	 * or a page the guard rejected) and there is more to reclaim.
	 */
	readonly exhausted: boolean;
}

/**
 * Default + validate the sweep's knobs. Malformed input fails loudly here
 * rather than degenerating into an unbounded sweep or a busy loop.
 */
function resolveSweepBounds(input: PruneNeverStartedInput): {
	batchSize: number;
	maxBatches: number;
} {
	const batchSize = input.batchSize ?? DEFAULT_RETENTION_BATCH;
	if (!Number.isInteger(batchSize) || batchSize <= 0) {
		throw new ValidationError(`batchSize must be a positive integer, got ${batchSize}`);
	}
	const maxBatches = input.maxBatches ?? 0;
	if (!Number.isInteger(maxBatches) || maxBatches < 0) {
		throw new ValidationError(`maxBatches must be zero or a positive integer, got ${maxBatches}`);
	}
	if (!Number.isFinite(input.olderThanMs) || input.olderThanMs < 0) {
		throw new ValidationError(`olderThanMs must be zero or a positive number`);
	}
	return { batchSize, maxBatches };
}

/**
 * Sweep `failed`/`never_started` runs older than `olderThanMs`, oldest first,
 * deleting each page with its events. Returns what it reclaimed.
 */
export async function pruneNeverStartedRuns(
	input: PruneNeverStartedInput,
): Promise<PruneNeverStartedResult> {
	const { batchSize, maxBatches } = resolveSweepBounds(input);
	const cutoff = new Date(
		(input.now?.() ?? new Date()).getTime() - input.olderThanMs,
	).toISOString();

	let batches = 0;
	let runs = 0;
	let events = 0;
	let exhausted = false;
	while (maxBatches === 0 || batches < maxBatches) {
		const ids = await input.runs.listExpiredNeverStartedIds({ cutoff, limit: batchSize });
		if (ids.length === 0) {
			exhausted = true;
			break;
		}
		const deleted = await input.runs.deleteNeverStartedBatch(ids);
		batches += 1;
		runs += deleted.runs;
		events += deleted.events;
		// The page was selected outside the delete's transaction, so the guard
		// can reject all of it (a row dispatched in between). Retrying would
		// re-select the same page forever; stop and let the operator re-run.
		if (deleted.runs === 0) break;
		if (ids.length < batchSize) {
			exhausted = true;
			break;
		}
	}
	return { cutoff, batches, runs, events, exhausted };
}
