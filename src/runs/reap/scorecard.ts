/**
 * Verified run scorecard (ubuntu-c929 / TTC phase 1).
 *
 * A deterministic, machine-readable terminal summary emitted as a
 * `run.scorecard` event by reap. Every field comes from facts reap already
 * holds — the finalize result, the run row, and the persisted event log.
 * No model-judged fields: budget triage, goal-loop forcing, and best-of-N
 * winner selection consume the scorecard because nothing in it is an
 * opinion about the run.
 *
 * One schema version rides on the payload so consumers can branch before
 * the shape drifts under them.
 */

import type { EventRow, RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import type { ReapExec } from "./types.ts";

/** Payload version; bump when a field is removed or re-meant. */
export const RUN_SCORECARD_SCHEMA = 1;

/** The scorecard payload. All fields are JSON-serializable primitives. */
export interface RunScorecard {
	readonly schema: number;
	readonly outcome: RunTerminalState;
	readonly failureReason: RunFailureReason | null;
	readonly noChanges: boolean;
	readonly pushProtection: boolean;
	readonly providerError: boolean;
	readonly branchPushed: boolean;
	readonly commitsAhead: number | null;
	readonly diffFiles: number | null;
	readonly diffLines: number | null;
	readonly prUrl: string | null;
	readonly salvageRef: string | null;
	readonly salvageBundlePath: string | null;
	readonly costUsd: number | null;
	readonly tokensInput: number | null;
	readonly tokensOutput: number | null;
	readonly tokensCacheRead: number | null;
	readonly tokensCacheWrite: number | null;
	readonly turns: number;
	readonly mulchUpdated: number;
	readonly mulchAppended: number;
	readonly seedsClosed: number;
	readonly seedsCreated: number;
}

/** Finalize-result facts the scorecard mirrors (see reap/pipeline.ts). */
export interface ScorecardReapFacts {
	readonly noChanges: boolean;
	readonly branchPushed: boolean;
	readonly commitsAhead: number | null;
	readonly prUrl: string | null;
	readonly pushProtection: unknown;
	readonly mulchUpdated: number;
	readonly mulchAppended: number;
	readonly seedsClosed: number;
	readonly seedsCreated: number;
}

/** Usage columns of the run row (warren-a7dc). */
export interface ScorecardRunRow {
	readonly costUsd: number | null;
	readonly tokensInput: number | null;
	readonly tokensOutput: number | null;
	readonly tokensCacheRead: number | null;
	readonly tokensCacheWrite: number | null;
}

export interface BuildRunScorecardInput {
	readonly outcome: RunTerminalState;
	readonly failureReason: RunFailureReason | null;
	readonly state: ScorecardReapFacts;
	readonly run: ScorecardRunRow;
	readonly salvageRef: string | null;
	readonly salvageBundlePath: string | null;
	readonly providerError: boolean;
	readonly events: readonly EventRow[];
	readonly workspacePath: string | null;
	readonly baseBranch: string | null;
	readonly exec: ReapExec;
}

interface DiffStats {
	readonly files: number;
	readonly lines: number;
}

/**
 * Count files and changed lines in base..HEAD from the workspace. Binary
 * rows ("-") count as files with zero lines; unparseable cells count as
 * zero. Always resolves: an unreadable workspace or a failed git call
 * yields null so the scorecard degrades field-by-field.
 */
async function collectDiffStats(
	exec: ReapExec,
	workspacePath: string | null,
	baseBranch: string | null,
): Promise<DiffStats | null> {
	if (workspacePath === null || baseBranch === null || baseBranch === "") return null;
	try {
		const result = await exec.run("git", ["diff", "--numstat", `${baseBranch}..HEAD`], {
			cwd: workspacePath,
		});
		let files = 0;
		let lines = 0;
		for (const row of result.stdout.split("\n")) {
			const cells = row.split("\t");
			if (cells.length < 3 || row.trim() === "") continue;
			files += 1;
			const added = Number(cells[0]);
			const deleted = Number(cells[1]);
			lines += (Number.isFinite(added) ? added : 0) + (Number.isFinite(deleted) ? deleted : 0);
		}
		return { files, lines };
	} catch {
		return null;
	}
}

/**
 * Assemble the scorecard. Reads nothing but the supplied facts: turn count
 * comes from the persisted event log, diff stats from one guarded git call.
 * Never throws.
 */
export async function buildRunScorecard(input: BuildRunScorecardInput): Promise<RunScorecard> {
	let turns = 0;
	for (const event of input.events) {
		const payload = event.payloadJson;
		if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
		if ((payload as Record<string, unknown>).type === "turn_end") turns += 1;
	}
	const diff = await collectDiffStats(input.exec, input.workspacePath, input.baseBranch);
	return {
		schema: RUN_SCORECARD_SCHEMA,
		outcome: input.outcome,
		failureReason: input.failureReason,
		noChanges: input.state.noChanges,
		pushProtection: input.state.pushProtection !== null,
		providerError: input.providerError,
		branchPushed: input.state.branchPushed,
		commitsAhead: input.state.commitsAhead,
		diffFiles: diff?.files ?? null,
		diffLines: diff?.lines ?? null,
		prUrl: input.state.prUrl,
		salvageRef: input.salvageRef,
		salvageBundlePath: input.salvageBundlePath,
		costUsd: input.run.costUsd,
		tokensInput: input.run.tokensInput,
		tokensOutput: input.run.tokensOutput,
		tokensCacheRead: input.run.tokensCacheRead,
		tokensCacheWrite: input.run.tokensCacheWrite,
		turns,
		mulchUpdated: input.state.mulchUpdated,
		mulchAppended: input.state.mulchAppended,
		seedsClosed: input.state.seedsClosed,
		seedsCreated: input.state.seedsCreated,
	};
}
