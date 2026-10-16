/**
 * Retention CLI commands for `warren db` (ubuntu-4f98 / ubuntu-057f).
 *
 * Split out of `db.ts` so neither module trips the file-size budget: this file
 * owns `prune` (the transient `never_started` sweep) and `prune-events` (the
 * `events` sweep), plus the option parsing both share; `db.ts` owns
 * `migrate-to-postgres` and registers this group alongside it.
 */

import type { Command } from "commander";
import { parseDurationMs } from "../../preview/duration.ts";
import {
	DEFAULT_EVENTS_RETENTION_BATCH,
	DEFAULT_EVENTS_RETENTION_DAYS,
	MIN_EVENTS_RETENTION_MS,
	type PruneRunEventsInput,
	type PruneRunEventsResult,
	pruneRunEvents,
} from "../../runs/events-retention.ts";
import {
	DEFAULT_RETENTION_BATCH,
	DEFAULT_RETENTION_DAYS,
	type PruneNeverStartedResult,
	pruneNeverStartedRuns,
	type RetentionRunsRepo,
} from "../../runs/retention.ts";
import { withCliDb } from "../context.ts";
import { type CliContext, formatError, writeJsonLine } from "../output.ts";

export interface PruneRunsInput {
	readonly runs: RetentionRunsRepo;
	readonly olderThanMs: number;
	readonly batchSize?: number;
	readonly maxBatches?: number;
	readonly now?: () => Date;
}

export interface PruneRunsResult extends PruneNeverStartedResult {
	readonly exitCode: number;
}

/**
 * `warren db prune` — age-based retention for transient `never_started` runs,
 * the rows the scheduler mints one-per-tick while the runtime is unreachable
 * and the bounded-retry GC (warren-a0a2) only removes one at a time
 * (ubuntu-4f98).
 *
 * The sweep itself is `pruneNeverStartedRuns`; this function is the operator
 * surface: it runs it against the local warren DB's `runs`/`events` repos and
 * emits one JSON line on stdout, the same shape contract
 * `migrate-to-postgres` uses, so a run can be logged or piped:
 *
 *   {"ok":true,"cutoff":"...","batches":119,"runs":59341,"events":148955,
 *    "exhausted":true}
 *
 * `exhausted:false` means the sweep stopped at `maxBatches` (or lost a page to
 * a concurrent dispatch) and there is more to reclaim — re-run it. Nothing is
 * deleted that the guard does not re-check inside its own transaction, and
 * deleting rows does NOT shrink the file: the freed pages are reused, and
 * reclaiming them on disk needs an offline `VACUUM` the operator must run.
 */
export async function runPruneRuns(
	context: CliContext,
	input: PruneRunsInput,
): Promise<PruneRunsResult> {
	const sweep = await pruneNeverStartedRuns(input);
	writeJsonLine(context.stdio.stdout, { ok: true, ...sweep });
	return { ...sweep, exitCode: 0 };
}

export interface PruneEventsResult extends PruneRunEventsResult {
	readonly exitCode: number;
}

/**
 * `warren db prune-events` — age-based retention for the `events` table, the
 * half of the database that grows without bound (ubuntu-057f).
 *
 * The sweep itself is `pruneRunEvents`; this function is the operator
 * surface: it runs it against the local warren DB's `events` repo and emits
 * one JSON line on stdout, the same shape contract `prune` uses, so a run can
 * be logged or piped:
 *
 *   {"ok":true,"cutoff":"...","dryRun":true,"batches":0,"runs":306,
 *    "events":1396293,"bytes":...,"exhausted":true}
 *
 * Dry-run is the default and deletes nothing; `apply` must be set to delete.
 * The window is floored at seven days (7d) — see `pruneRunEvents`. Deleting
 * event rows does NOT shrink the file: freed pages are reused and reclaiming
 * them on disk needs an offline `VACUUM` the operator must run.
 */
export async function runPruneEvents(
	context: CliContext,
	input: PruneRunEventsInput,
): Promise<PruneEventsResult> {
	const sweep = await pruneRunEvents(input);
	writeJsonLine(context.stdio.stdout, { ok: true, ...sweep });
	return { ...sweep, exitCode: 0 };
}

/**
 * The `--older-than` / `--batch` / `--max-batches` knobs shared by `db prune`
 * and `db prune-events` (ubuntu-4f98 / ubuntu-057f).
 */
export interface RetentionCliOptions {
	readonly olderThan: string;
	readonly batch: string;
	readonly maxBatches: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse the shared retention knobs. `floorMs` is the command's own minimum
 * window (0 = no floor); `usage` is that command's exit-2 reporter, so a bad
 * value fails loudly instead of degenerating into an unbounded or too-recent
 * sweep.
 */
export function parseRetentionCliOptions(
	opts: RetentionCliOptions,
	floorMs: number,
	usage: (detail: string) => never,
): { olderThanMs: number; batchSize: number; maxBatches: number } {
	let olderThanMs: number;
	try {
		olderThanMs = parseDurationMs(opts.olderThan);
	} catch (err) {
		return usage(`--older-than ${formatError(err)}`);
	}
	if (olderThanMs < floorMs) {
		return usage(
			`--older-than must be at least ${floorMs / DAY_MS}d ` +
				`(got ${JSON.stringify(opts.olderThan)}); a shorter window can drop the events of a run ` +
				"an operator is looking at",
		);
	}
	const batchSize = Number.parseInt(opts.batch, 10);
	if (!Number.isInteger(batchSize) || batchSize <= 0 || String(batchSize) !== opts.batch.trim()) {
		return usage(`--batch must be a positive integer, got ${JSON.stringify(opts.batch)}`);
	}
	const maxBatches = Number.parseInt(opts.maxBatches, 10);
	if (
		!Number.isInteger(maxBatches) ||
		maxBatches < 0 ||
		String(maxBatches) !== opts.maxBatches.trim()
	) {
		return usage(
			`--max-batches must be zero or a positive integer, got ${JSON.stringify(opts.maxBatches)}`,
		);
	}
	return { olderThanMs, batchSize, maxBatches };
}

/**
 * Register `prune` and `prune-events` under the `warren db` group. `usage` is
 * the group's shared exit-2 reporter (defined in `db.ts`).
 */
export function registerRetentionCommands(
	dbGroup: Command,
	context: CliContext,
	usage: (detail: string) => never,
): void {
	dbGroup
		.command("prune")
		.description("delete transient never_started runs older than a cutoff, with their events")
		.option(
			"--older-than <duration>",
			"age cutoff as a duration (ms|s|m|h|d, e.g. 7d, 36h)",
			`${DEFAULT_RETENTION_DAYS}d`,
		)
		.option("--batch <n>", "runs per delete transaction", String(DEFAULT_RETENTION_BATCH))
		.option("--max-batches <n>", "stop after N batches (0 sweeps until exhausted)", "0")
		.action(async (opts: RetentionCliOptions) => {
			const { olderThanMs, batchSize, maxBatches } = parseRetentionCliOptions(opts, 0, usage);
			// Same lifecycle as `doctor`: the local warren DB (WARREN_DB_URL,
			// else WARREN_DB_PATH, else <WARREN_DATA_DIR>/warren.db), opened and
			// closed by `withCliDb`. Running this inside the warren container
			// against the supervised data volume is the intended invocation.
			const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
				const result = await runPruneRuns(context, {
					runs: repos.runs,
					olderThanMs,
					batchSize,
					maxBatches,
				});
				return result.exitCode;
			});
			process.exit(exitCode);
		});
	dbGroup
		.command("prune-events")
		.description("delete events of old terminal runs; dry-run unless --apply is set")
		.option(
			"--older-than <duration>",
			"age cutoff as a duration (ms|s|m|h|d, e.g. 30d, 60d); floored at 7d",
			`${DEFAULT_EVENTS_RETENTION_DAYS}d`,
		)
		.option("--dry-run", "report the rows and bytes in the window without deleting (default)")
		.option("--apply", "actually delete; without this flag the command only reports")
		.option("--batch <n>", "runs per delete transaction", String(DEFAULT_EVENTS_RETENTION_BATCH))
		.option("--max-batches <n>", "stop after N batches (0 sweeps until exhausted)", "0")
		.action(
			async (opts: RetentionCliOptions & { dryRun?: boolean; apply?: boolean }): Promise<void> => {
				if (opts.dryRun === true && opts.apply === true) {
					return usage("--dry-run and --apply are mutually exclusive");
				}
				const { olderThanMs, batchSize, maxBatches } = parseRetentionCliOptions(
					opts,
					MIN_EVENTS_RETENTION_MS,
					usage,
				);
				const exitCode = await withCliDb({ env: context.env }, async ({ repos }) => {
					const result = await runPruneEvents(context, {
						events: repos.events,
						olderThanMs,
						apply: opts.apply === true,
						batchSize,
						maxBatches,
					});
					return result.exitCode;
				});
				process.exit(exitCode);
			},
		);
}
