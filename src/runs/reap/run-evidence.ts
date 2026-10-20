/**
 * Final run evidence and forced continuation (ubuntu-c929 / ubuntu-d8c3).
 *
 * FinalizeRunEvidence is the single terminal step the reap pipeline calls
 * after the result is settled: it emits the verified run scorecard and —
 * when the forcing switch is on and the terminal is evidence-empty — spawns
 * ONE continuation seeded from the parent's pushed branch.
 *
 * Evidence-empty means the run produced no committed work: a succeeded
 * no-op, or a failure with a dropped commit. Infrastructure failures
 * (provider errors, crashes) are the healers' job, not this loop's. The
 * continuation carries the parent's effective USD cap, so the bridge
 * enforces the same budget on the second chance.
 *
 * Everything is best-effort: any failure logs a warning and leaves the
 * reap result untouched.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { EventRow, RunFailureReason, RunRow, RunTerminalState } from "../../db/schema.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import { resolveCostCapUsd } from "../cost-cap.ts";
import { spawnRun } from "../spawn/index.ts";
import { buildRunScorecard, type RunScorecard, type ScorecardReapFacts } from "./scorecard.ts";
import type { ReapExec } from "./types.ts";

/** Trigger tag stamped on forced-continuation runs. */
export const FORCE_CONTINUE_TRIGGER = "scorecard_force_continue";
/** How many forced continuations one lineage may produce. */
export const MAX_FORCED_CONTINUATIONS = 1;
/** Ancestry walk bound; a longer chain is treated as capped. */
const LINEAGE_MAX_HOPS = 5;

export interface RunEvidenceInput {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly outcome: RunTerminalState;
	readonly failureReason: RunFailureReason | null;
	readonly state: ScorecardReapFacts;
	readonly run: RunRow;
	readonly salvageRef: string | null;
	readonly salvageBundlePath: string | null;
	readonly providerError: boolean;
	readonly events: readonly EventRow[];
	readonly workspacePath: string | null;
	readonly baseBranch: string | null;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly log: {
		info(obj: object, msg?: string): void;
		warn(obj: object, msg?: string): void;
	};
	/** Forcing switch; defaults to env `WARREN_FORCE_CONTINUE=1`. */
	readonly forceContinuation?: { readonly enabled: boolean };
}

export interface ForceDecisionInput {
	readonly enabled: boolean;
	readonly outcome: RunTerminalState;
	readonly failureReason: RunFailureReason | null;
	readonly noChanges: boolean;
	readonly costUsd: number | null;
	readonly budgetCapUsd: number | null;
	readonly existingForcedContinuations: number;
	readonly maxContinuations: number;
}

export interface ForceDecision {
	readonly force: boolean;
	readonly reason: string | null;
}

/** Decide whether an evidence-empty terminal earns one forced continuation. */
export function decideForcedContinuation(input: ForceDecisionInput): ForceDecision {
	if (!input.enabled) return { force: false, reason: "disabled" };
	const evidenceEmpty =
		(input.outcome === "succeeded" && input.noChanges) ||
		(input.outcome === "failed" && input.failureReason === "dropped_commit");
	if (!evidenceEmpty) return { force: false, reason: "evidence_nonempty" };
	if (input.existingForcedContinuations >= input.maxContinuations) {
		return { force: false, reason: "lineage_capped" };
	}
	if (
		input.costUsd !== null &&
		input.budgetCapUsd !== null &&
		input.costUsd >= input.budgetCapUsd
	) {
		return { force: false, reason: "budget_exhausted" };
	}
	return { force: true, reason: null };
}

/**
 * True when the run or any ancestor carries the forced-continuation trigger
 * (ubuntu-d8c3). Consumers such as stall pruning must not touch such a
 * lineage as if it were a fresh run.
 */
export async function isForcedContinuationLineage(repos: Repos, run: RunRow): Promise<boolean> {
	let current: RunRow | null = run;
	for (let hops = 0; current !== null && hops < LINEAGE_MAX_HOPS; hops += 1) {
		if (current.trigger === FORCE_CONTINUE_TRIGGER) return true;
		current = current.parentRunId !== null ? await repos.runs.get(current.parentRunId) : null;
	}
	return false;
}

/**
 * Count forced-continuation runs across the run's ancestry. Siblings from
 * the same parent count against the cap, and a run that IS a forced
 * continuation counts itself, so a lineage can never farm unlimited
 * chances.
 */
async function countForcedLineage(repos: Repos, run: RunRow): Promise<number> {
	let forced = run.trigger === FORCE_CONTINUE_TRIGGER ? 1 : 0;
	const nodeIds: string[] = [];
	let current: RunRow | null = run;
	for (let hops = 0; current !== null && hops < LINEAGE_MAX_HOPS; hops += 1) {
		nodeIds.push(current.id);
		current = current.parentRunId !== null ? await repos.runs.get(current.parentRunId) : null;
	}
	for (const nodeId of nodeIds) {
		for (const child of await repos.runs.listByParentRunId(nodeId)) {
			if (child.id !== run.id && child.trigger === FORCE_CONTINUE_TRIGGER) forced += 1;
		}
	}
	return forced;
}

/** Spawn one continuation seeded from the parent's pushed branch. */
async function dispatchForcedContinuation(
	input: RunEvidenceInput,
	budgetCapUsd: number | null,
): Promise<string> {
	const prompt = [
		`The previous run ${input.run.id} ended without verified work.`,
		input.outcome === "succeeded"
			? "It made no changes at all."
			: `It failed (${input.failureReason ?? "unknown"}) without producing committed work.`,
		"Continue from the pushed branch, run the project quality gate, and finish with real changes.",
		"Original prompt:",
		"---",
		input.run.prompt,
	].join("\n");
	const spawned = await spawnRun({
		repos: input.repos,
		runtimeProvider: input.runtimeProvider,
		agentName: input.run.agentName,
		projectId: input.run.projectId ?? "",
		prompt,
		...(input.run.seedId !== null && input.run.seedId !== "" ? { seedId: input.run.seedId } : {}),
		parentRunId: input.run.id,
		cloneKind: "continue",
		trigger: FORCE_CONTINUE_TRIGGER,
		...(budgetCapUsd !== null ? { maxCostUsdOverride: budgetCapUsd } : {}),
	});
	return spawned.run.id;
}

/**
 * Emit the verified scorecard and, when the forcing switch is on and the
 * terminal is evidence-empty, spawn ONE continuation. Never throws.
 */
export async function finalizeRunEvidence(input: RunEvidenceInput): Promise<void> {
	try {
		const scorecard: RunScorecard = await buildRunScorecard({
			outcome: input.outcome,
			failureReason: input.failureReason,
			state: input.state,
			run: input.run,
			salvageRef: input.salvageRef,
			salvageBundlePath: input.salvageBundlePath,
			providerError: input.providerError,
			events: input.events,
			workspacePath: input.workspacePath,
			baseBranch: input.baseBranch,
			exec: input.exec,
		});
		await input.emit("run.scorecard", scorecard);
		if (input.run.projectId === null) return;
		const enabled = input.forceContinuation?.enabled ?? process.env.WARREN_FORCE_CONTINUE === "1";
		const budgetCapUsd = resolveCostCapUsd(input.run.renderedAgentJson);
		const decision = decideForcedContinuation({
			enabled,
			outcome: input.outcome,
			failureReason: input.failureReason,
			noChanges: input.state.noChanges,
			costUsd: input.run.costUsd,
			budgetCapUsd,
			existingForcedContinuations: await countForcedLineage(input.repos, input.run),
			maxContinuations: MAX_FORCED_CONTINUATIONS,
		});
		if (!decision.force) {
			if (enabled) {
				input.log.info(
					{ event: "run.evidence", reason: decision.reason, runId: input.run.id },
					"forced continuation skipped",
				);
			}
			return;
		}
		const continuationRunId = await dispatchForcedContinuation(input, budgetCapUsd);
		input.log.info(
			{ event: "run.evidence", runId: input.run.id, continuationRunId },
			"forced continuation dispatched",
		);
	} catch (err) {
		input.log.warn(
			{ event: "run.evidence", err: err instanceof Error ? err.message : String(err) },
			"run evidence emit failed",
		);
	}
}
