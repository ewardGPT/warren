/**
 * Retention data access for the runs/events tables (ubuntu-4f98).
 *
 * Two functions, both guarded to the transient row class the scheduler's
 * bounded-retry GC already owns (`failed` + `never_started`, warren-a0a2):
 *
 *   - {@link listExpiredNeverStartedIds} — the age-based page selection.
 *   - {@link deleteNeverStartedBatch} — one page's rows + events, in one
 *     transaction.
 *
 * They live here rather than in `runs.ts` / `runs-queries.ts` so the sweep
 * (`src/runs/retention.ts`) reads as one feature, and so the write repo keeps
 * its file-size budget. `RunsRepo` delegates both, so callers never touch the
 * adapter directly. See `src/runs/retention.ts` for why the sweep is batched
 * and why it is operator-driven rather than part of boot.
 */

import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { SqliteDrizzleDb } from "../client.ts";
import type { DrizzleAdapter } from "./drizzle-adapter.ts";
import { EventsRepo } from "./events.ts";

/**
 * Ids of `failed`/`never_started` runs that went terminal before `cutoff`,
 * oldest first, capped at `limit`.
 *
 * A row with no `ended_at` never aged out — it is not a completed attempt —
 * and the guard leaves it alone. The predicate matches the one
 * {@link deleteNeverStartedBatch} re-checks inside its transaction, so a page
 * can be stale without being dangerous.
 */
export async function listExpiredNeverStartedIds(
	adapter: DrizzleAdapter,
	opts: { cutoff: string; limit: number },
): Promise<string[]> {
	if (opts.limit <= 0) return [];
	const db = adapter.drizzle as SqliteDrizzleDb;
	const runs = adapter.schema.runs;
	const rows = await adapter.pickAll<{ id: string }>(
		db
			.select({ id: runs.id })
			.from(runs)
			.where(
				and(
					eq(runs.state, "failed"),
					eq(runs.failureReason, "never_started"),
					isNotNull(runs.endedAt),
					lt(runs.endedAt, opts.cutoff),
				),
			)
			.orderBy(asc(runs.endedAt))
			.limit(opts.limit),
	);
	return rows.map((row) => row.id);
}

/**
 * Delete the eligible runs among `ids` and their events, in one transaction.
 *
 * The guard is re-checked against the ids handed in, so a run that dispatched
 * between the select and the delete survives — the caller's page is a hint,
 * not a decision — and rows the guard rejects are simply absent from the
 * counts. Events go first (`events.run_id` carries no cascade on the write
 * path's schema contract), then the run rows.
 */
export async function deleteNeverStartedBatch(
	adapter: DrizzleAdapter,
	ids: readonly string[],
): Promise<{ runs: number; events: number }> {
	if (ids.length === 0) return { runs: 0, events: 0 };
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
						eq(runs.state, "failed"),
						eq(runs.failureReason, "never_started"),
					),
				),
		);
		const runIds = eligible.map((row) => row.id);
		if (runIds.length === 0) return { runs: 0, events: 0 };
		const eventsBefore = await new EventsRepo(tx).countByRunIds(runIds);
		await tx.runWrite(txDb.delete(events).where(inArray(events.runId, runIds)));
		await tx.runWrite(txDb.delete(runs).where(inArray(runs.id, runIds)));
		return { runs: runIds.length, events: eventsBefore };
	});
}
