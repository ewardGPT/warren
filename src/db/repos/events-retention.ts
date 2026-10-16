/**
 * Event-retention data access (ubuntu-057f).
 *
 * Three functions, all scoped to the events of runs that have reached a
 * terminal state (`succeeded` / `failed` / `cancelled`) and ended before a
 * cutoff:
 *
 *   - {@link listExpiredTerminalRunIds} — the age-based page selection.
 *   - {@link estimateEventsForWindow} — the dry-run sizing scan.
 *   - {@link deleteEventsBatch} — one page's events, in one transaction.
 *
 * They live here rather than in `events.ts` so the sweep
 * (`src/runs/events-retention.ts`) reads as one feature and `EventsRepo`
 * keeps its file-size budget. `EventsRepo` delegates all three, so callers
 * never touch the adapter directly.
 *
 * The sweep deletes EVENTS ONLY — the run rows stay, so the run's outcome and
 * cost remain auditable long after its transcript of `stdout`/`thinking`
 * frames is gone. `queued` / `running` runs are never touched: an in-flight
 * run's transcript is the one an operator is most likely to be reading, and
 * every read path (`GET /runs/:id/events`, the bridge replay) coalesces the
 * persisted transcript with the live stream. `never_started` rows are the
 * existing `warren db prune`'s job (ubuntu-4f98), not this one's.
 */

import { and, asc, eq, inArray, isNotNull, lt, type SQL, sql } from "drizzle-orm";
import type { RunState } from "../../core/wire.ts";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter, WarrenSchema } from "./drizzle-adapter.ts";

/**
 * The terminal run states whose events this sweep may reclaim. Mirrors
 * `GC_TERMINAL_RUN_STATES` (`src/runs/reap/gc.ts`); duplicated here because
 * the repo layer must not import from the run-domain modules.
 */
const TERMINAL_RUN_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled"];

/**
 * Fixed per-row overhead (rowid varint + record header + the integer
 * `burrow_event_seq` column) added to the stored text lengths so the dry-run's
 * byte figure is not a lower bound. It is still an ESTIMATE: the on-disk cost
 * also includes the `events_run_seq_idx` / `events_run_ts_idx` entries and
 * page slack, and SQLite reuses freed pages without shrinking the file — see
 * the command docs.
 */
const ROW_OVERHEAD_BYTES = 32;

/** Stored-length estimate for one events row, in bytes. */
function eventRowBytes(events: WarrenSchema["events"]): SQL<number> {
	return sql<number>`(length(${events.runId}) + length(${events.ts}) + length(${events.kind}) + COALESCE(length(${events.stream}), 0) + length(${events.payloadJson}) + ${ROW_OVERHEAD_BYTES})`;
}

/**
 * Ids of terminal runs that ended before `cutoff` and still have at least one
 * event row, oldest first, capped at `limit`.
 *
 * The `EXISTS` predicate is what makes the sweep resumable: pruning a run's
 * events leaves the run row in place (the run stays auditable), so without it
 * every page would re-select the same oldest runs forever and never advance.
 * A terminal row's `ended_at` is immutable, so a page selected outside the
 * delete's transaction only goes stale if the run row itself was removed or
 * another sweeper emptied it; the delete re-checks the terminal-state guard
 * regardless (a page is a hint, not a decision). A row with no `ended_at` is
 * not a finished attempt and is left alone.
 */
export async function listExpiredTerminalRunIds(
	adapter: DrizzleAdapter,
	opts: { cutoff: string; limit: number },
): Promise<string[]> {
	if (opts.limit <= 0) return [];
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const events = adapter.schema.events;
	const rows = await adapter.pickAll<{ id: string }>(
		db
			.select({ id: runs.id })
			.from(runs)
			.where(
				and(
					inArray(runs.state, [...TERMINAL_RUN_STATES]),
					isNotNull(runs.endedAt),
					lt(runs.endedAt, opts.cutoff),
					sql`EXISTS (SELECT 1 FROM ${events} WHERE ${events.runId} = ${runs.id})`,
				),
			)
			.orderBy(asc(runs.endedAt))
			.limit(opts.limit),
	);
	return rows.map((row) => row.id);
}

/**
 * Size the whole window in one query: how many terminal runs ended before
 * `cutoff`, how many event rows they own, and those rows' estimated stored
 * bytes. Used by the dry-run, which must report without deleting.
 */
export async function estimateEventsForWindow(
	adapter: DrizzleAdapter,
	opts: { cutoff: string },
): Promise<{ runs: number; events: number; bytes: number }> {
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const events = adapter.schema.events;
	const row = await adapter.pickOne<{
		runs: number | string;
		n: number | string;
		bytes: number | string;
	}>(
		db
			.select({
				runs: sql<number>`count(DISTINCT ${events.runId})`,
				n: sql<number>`count(*)`,
				bytes: sql<number>`COALESCE(SUM(${eventRowBytes(events)}), 0)`,
			})
			.from(events)
			.innerJoin(runs, eq(runs.id, events.runId))
			.where(
				and(
					inArray(runs.state, [...TERMINAL_RUN_STATES]),
					isNotNull(runs.endedAt),
					lt(runs.endedAt, opts.cutoff),
				),
			),
	);
	return {
		runs: Number(row?.runs ?? 0),
		events: Number(row?.n ?? 0),
		bytes: Number(row?.bytes ?? 0),
	};
}

/**
 * Delete the events belonging to the eligible runs among `ids`, in one
 * transaction, without removing the run rows.
 *
 * The guard is re-checked against the ids handed in, so a page that raced a
 * concurrent delete simply reports fewer runs — the caller's page is a hint,
 * not a decision. Events for runs the guard rejects are untouched.
 */
export async function deleteEventsBatch(
	adapter: DrizzleAdapter,
	ids: readonly string[],
): Promise<{ runs: number; events: number; bytes: number }> {
	if (ids.length === 0) return { runs: 0, events: 0, bytes: 0 };
	return adapter.runInTransaction(async (tx) => {
		const txDb = tx.drizzle as SqliteDrizzleDb;
		const runs = tx.schema.runs;
		const events = tx.schema.events;
		const eligible = await tx.pickAll<{ id: string }>(
			txDb
				.select({ id: runs.id })
				.from(runs)
				.where(
					and(
						inArray(runs.id, [...ids]),
						inArray(runs.state, [...TERMINAL_RUN_STATES]),
						isNotNull(runs.endedAt),
					),
				),
		);
		const runIds = eligible.map((row) => row.id);
		if (runIds.length === 0) return { runs: 0, events: 0, bytes: 0 };
		const before = await tx.pickOne<{ n: number | string; bytes: number | string }>(
			txDb
				.select({
					n: sql<number>`count(*)`,
					bytes: sql<number>`COALESCE(SUM(${eventRowBytes(events)}), 0)`,
				})
				.from(events)
				.where(inArray(events.runId, runIds)),
		);
		await tx.runWrite(txDb.delete(events).where(inArray(events.runId, runIds)));
		return {
			runs: runIds.length,
			events: Number(before?.n ?? 0),
			bytes: Number(before?.bytes ?? 0),
		};
	});
}
