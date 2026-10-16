/**
 * Event retention for old terminal runs (ubuntu-057f).
 *
 * `/data/warren.db` was 14.7 GB and the growth was the `events` table: ~1.4M
 * rows across 306 runs, the largest single run owning ~98k events. Rows had
 * been deleted before, but nothing expires them on a schedule, and
 * `auto_vacuum=0` means the freed pages stay in the file until an offline
 * VACUUM.
 *
 * This module is the age-based half of that cleanup, and it is deliberately
 * two-mode:
 *
 *   - **Dry-run is the default.** `apply` must be set explicitly to delete
 *     anything; a dry-run reads the window and reports rows and estimated
 *     bytes without touching a row.
 *   - **The window is floored at seven days.** A fat-fingered `--older-than`
 *     cannot drop the audit trail of the run an operator is currently
 *     looking at.
 *
 * The scope is events of runs that reached a terminal state
 * (`succeeded`/`failed`/`cancelled`) and ended before the cutoff. A run that
 * has not reached a terminal state is never touched, and run rows are never
 * deleted — only their event transcripts. `never_started` rows belong to
 * `warren db prune` (ubuntu-4f98), not here, and this sweep never VACUUMs.
 *
 * Batching is the point of the loop, not an optimisation detail: one
 * transaction over a whole window would hold the write lock for the sweep and
 * grow the WAL by the size of the delete before any of it is reclaimable.
 * Each batch is one transaction holding at most `batchSize` run rows' events;
 * the caller caps the sweep with `maxBatches`, and the selection skips runs
 * whose events are already gone, so a re-run resumes rather than repeating.
 */

import { ValidationError } from "../core/errors.ts";

/** Default age cutoff — a month keeps a comfortable audit window. */
export const DEFAULT_EVENTS_RETENTION_DAYS = 30;
/** Default runs per delete transaction. */
export const DEFAULT_EVENTS_RETENTION_BATCH = 200;
/**
 * Hard floor on the window (7 days). Below this the operator is far more
 * likely to be fat-fingering than to have a legitimate need, and the cost of
 * being wrong is the transcript of a run under investigation.
 */
export const MIN_EVENTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The `EventsRepo` surface events retention needs. Declared structurally so
 * the sweep can be exercised against a stub, and so a future Postgres-backed
 * repo plugs in unchanged.
 */
export interface EventsRetentionRepo {
	listExpiredTerminalRunIds(opts: { cutoff: string; limit: number }): Promise<string[]>;
	estimateEventsForWindow(opts: { cutoff: string }): Promise<{
		runs: number;
		events: number;
		bytes: number;
	}>;
	deleteEventsBatch(
		ids: readonly string[],
	): Promise<{ runs: number; events: number; bytes: number }>;
}

export interface PruneRunEventsInput {
	readonly events: EventsRetentionRepo;
	/** Age cutoff in ms before `now`; runs terminal on or after it are kept. */
	readonly olderThanMs: number;
	/** Delete. Omitted / false is a dry-run, which reports but changes nothing. */
	readonly apply?: boolean;
	readonly batchSize?: number;
	/** Stop after this many batches. `0` (default) sweeps until exhausted. */
	readonly maxBatches?: number;
	readonly now?: () => Date;
}

export interface PruneRunEventsResult {
	/** The resolved cutoff, echoed so the operator can audit what it kept. */
	readonly cutoff: string;
	readonly dryRun: boolean;
	readonly batches: number;
	/** Terminal runs whose events were pruned (or would be). */
	readonly runs: number;
	readonly events: number;
	/** Estimated stored bytes of those event rows. See `events-retention.ts`. */
	readonly bytes: number;
	/**
	 * True when the sweep covered the whole window (the last page came back
	 * short). False means it stopped early — the batch cap, or a page the
	 * guard rejected — and there is more to reclaim, so re-run it. A dry-run
	 * always reports `true`: the estimate covers the entire window and carries
	 * no batching meaning.
	 */
	readonly exhausted: boolean;
}

/**
 * Default + validate the sweep's knobs. Malformed input fails loudly here
 * rather than degenerating into an unbounded sweep, a busy loop, or a delete
 * of too-recent events.
 */
function resolveSweepBounds(input: PruneRunEventsInput): {
	batchSize: number;
	maxBatches: number;
} {
	const batchSize = input.batchSize ?? DEFAULT_EVENTS_RETENTION_BATCH;
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
	if (input.olderThanMs < MIN_EVENTS_RETENTION_MS) {
		throw new ValidationError(
			`olderThanMs must be at least ${MIN_EVENTS_RETENTION_MS} (7 days), got ${input.olderThanMs}`,
			{
				recoveryHint:
					"a window below 7 days can drop the events of the run an operator is looking at; pass a duration of 7d or more",
			},
		);
	}
	return { batchSize, maxBatches };
}

/**
 * Prune the events of terminal runs older than `olderThanMs`. Dry-run unless
 * `apply` is set. Returns what it touched (or would touch).
 */
export async function pruneRunEvents(input: PruneRunEventsInput): Promise<PruneRunEventsResult> {
	const { batchSize, maxBatches } = resolveSweepBounds(input);
	const cutoff = new Date(
		(input.now?.() ?? new Date()).getTime() - input.olderThanMs,
	).toISOString();

	if (input.apply !== true) {
		const window = await input.events.estimateEventsForWindow({ cutoff });
		return {
			cutoff,
			dryRun: true,
			batches: 0,
			runs: window.runs,
			events: window.events,
			bytes: window.bytes,
			exhausted: true,
		};
	}

	let batches = 0;
	let runs = 0;
	let events = 0;
	let bytes = 0;
	let exhausted = false;
	while (maxBatches === 0 || batches < maxBatches) {
		const ids = await input.events.listExpiredTerminalRunIds({ cutoff, limit: batchSize });
		if (ids.length === 0) {
			exhausted = true;
			break;
		}
		const deleted = await input.events.deleteEventsBatch(ids);
		batches += 1;
		runs += deleted.runs;
		events += deleted.events;
		bytes += deleted.bytes;
		// The page was selected outside the delete's transaction, so the guard
		// can reject all of it (a run removed in between). Retrying would
		// re-select the same page forever; stop and let the operator re-run.
		if (deleted.runs === 0) break;
		if (ids.length < batchSize) {
			exhausted = true;
			break;
		}
	}
	return { cutoff, dryRun: false, batches, runs, events, bytes, exhausted };
}
