/**
 * `src/plan-runs/jev-gate.ts` — an optional second look before a plan moves on.
 *
 * The coordinator already decides mechanically: a child's PR merged, so the next
 * child dispatches. That is the right default and it stays the default. This
 * gate exists for the case where the mechanical facts are not enough: a plan
 * that has been running for hours, a child that merged after several returns, a
 * diff nobody sized. Then the question "may this plan continue?" is a judgement,
 * and `src/decide` answers it in about a second.
 *
 * Two rules keep it safe:
 *
 *   1. **Off unless asked.** `WARREN_JEV_PLAN_GATE=1` (or `=true`) is the only
 *      way in. Unset means `advancePlanRun` behaves exactly as before.
 *   2. **A stop is loud and terminal.** The only honest place to park is
 *      `failed` with a reason naming the band, because the plan-run states have
 *      no paused arm. A gate that quietly proceeded on `ask` would be worse than
 *      no gate at all.
 *
 * Every failure of the decision engine resolves to `ask`, never to `act`:
 * silence never becomes permission to proceed.
 */

import type { PlanRunChildState } from "../core/wire.ts";
import { bandFor, type Decision, decide, foldBands } from "../decide/index.ts";

export interface PlanContinuationEvidence {
	readonly planRunId: string;
	readonly projectId: string;
	/** Children the coordinator considers finished. */
	readonly completedChildren: number;
	readonly failedChildren: number;
	readonly remainingChildren: number;
	/** The child whose merge triggered this tick, when there was one. */
	readonly mergedChildSeq?: number;
	readonly nextChildSeq: number;
	readonly nextSeedId: string;
	/** How long the plan has been running, when that is known. */
	readonly planAgeMs?: number;
}

export type PlanContinuationVerdict =
	| { readonly kind: "continue" }
	| { readonly kind: "stop"; readonly band: "ask" | "hold"; readonly reason: string };

/** Injected so a test can drive the coordinator without a provider. */
export type PlanContinuationJudge = (
	evidence: PlanContinuationEvidence,
) => Promise<PlanContinuationVerdict>;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function planGateEnabled(env: Record<string, string | undefined>): boolean {
	return TRUE_VALUES.has((env.WARREN_JEV_PLAN_GATE ?? "").toLowerCase());
}

/**
 * Map one decision onto a verdict. Exported because this is the rule the gate
 * rests on: `act` continues, `ask` and `hold` stop with the band in the reason,
 * and anything the engine could not answer also stops.
 */
export function continuationVerdict(decision: Decision): PlanContinuationVerdict {
	if (decision.outcome !== "decided") {
		return {
			kind: "stop",
			band: "ask",
			reason: `decision ${decision.outcome}: ${decision.reason}`,
		};
	}
	const band = foldBands(Object.values(decision.answers).map((answer) => bandFor(answer)));
	if (band === "act") return { kind: "continue" };
	return {
		kind: "stop",
		band,
		reason: `jevs_${band}: ${decision.provider}/${decision.model} in ${decision.ms}ms`,
	};
}

/** Ask Jev whether this plan may move on to the next child. */
export async function judgeContinuation(
	evidence: PlanContinuationEvidence,
	deps?: { readonly env?: Record<string, string | undefined> },
): Promise<PlanContinuationVerdict> {
	const decision = await decide(
		{
			feature: "plan-continuation",
			subject: evidence.planRunId,
			state: {
				project: evidence.projectId,
				completedChildren: evidence.completedChildren,
				failedChildren: evidence.failedChildren,
				remainingChildren: evidence.remainingChildren,
				mergedChildSeq: evidence.mergedChildSeq,
				nextChildSeq: evidence.nextChildSeq,
				nextSeed: evidence.nextSeedId,
				planAgeMinutes:
					evidence.planAgeMs === undefined ? undefined : Math.round(evidence.planAgeMs / 60_000),
			},
			questions: {
				proceed: {
					type: "noul",
					instructions:
						"May this seeds plan dispatch its next child right now, on the evidence above?",
					criteria: {
						true: "the children so far finished their own work and the next child is a sane continuation",
						false:
							"a child stopped without finishing, the plan is drifting from its mission, or the next child looks unrelated",
					},
				},
			},
		},
		deps?.env === undefined ? undefined : { env: deps.env },
	);
	return continuationVerdict(decision);
}

/**
 * The judge `advancePlanRun` should use, from the process environment: a real
 * Jev call when the gate is switched on, and `undefined` — meaning "no gate" —
 * when it is not.
 */
export function judgeContinuationFromEnv(
	env: Record<string, string | undefined>,
): PlanContinuationJudge | undefined {
	if (!planGateEnabled(env)) return undefined;
	return (evidence) => judgeContinuation(evidence, { env });
}

/** The child states that count as finished for the evidence snapshot. */
export function countChildren(states: readonly PlanRunChildState[]): {
	completed: number;
	failed: number;
	remaining: number;
} {
	let completed = 0;
	let failed = 0;
	let remaining = 0;
	for (const state of states) {
		if (state === "merged" || state === "skipped") completed += 1;
		else if (state === "failed") failed += 1;
		else remaining += 1;
	}
	return { completed, failed, remaining };
}
