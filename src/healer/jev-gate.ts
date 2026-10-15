/**
 * `src/healer/jev-gate.ts` — a second look before the healer spends a run.
 *
 * The healer is Warren's reflex: an alert arrives and a run wakes. The guard
 * rails in `dispatch.ts` decide the mechanical part (enabled, cooldown, max
 * retries) and they stay the default. This gate covers what they cannot see:
 * an alert that names nothing we can fix (a quota, a config typo, a scanner),
 * a fingerprint that has already drawn three heals without closing, a body
 * whose whole evidence is one line. Then "may this spend a sandboxed agent
 * run right now?" is a judgement, and `src/decide` answers it in about a
 * second.
 *
 * Two rules keep it safe, the same two as `src/plan-runs/jev-gate.ts`:
 *
 *   1. **Off unless asked.** `WARREN_JEV_HEAL_GATE=1` (or `true`) is the only
 *      way in. Unset means the handler behaves exactly as before.
 *   2. **A veto, not a permission.** The rails have already said this alert
 *      may spend a run, so only a confident no overrides them: `hold` skips,
 *      `act` and `ask` leave the decision standing, and an engine that could
 *      not answer (`unavailable`, `unsure`, `over-budget`) changes nothing,
 *      which is the contract `src/decide` advertises. Every call is logged
 *      either way, band included, so a run that happened on an `ask` is
 *      visible after the fact.
 *
 * The asymmetry with `src/plan-runs/jev-gate.ts` is deliberate. A plan moving
 * on needs a yes from the model; an alert drawing a run needs a no. One
 * continues a long autonomous process, the other spends a sandboxed run on a
 * production repository.
 */

import { bandFor, type Decision, decide, foldBands } from "../decide/index.ts";

/** Env switch that turns the gate on for the alert intake. */
export const HEAL_GATE_ENV = "WARREN_JEV_HEAL_GATE";

/** Feature name every heal-triage record carries in the decision log. */
export const HEAL_GATE_FEATURE = "heal-triage";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const MAX_TITLE = 200;
const MAX_DETAIL = 400;

export interface HealTriageEvidence {
	readonly projectId: string;
	/** Alert fingerprint, the id the cooldown history is kept under. */
	readonly fingerprint: string;
	readonly source: string;
	readonly title: string;
	readonly culprit: string | null;
	readonly detail: string | null;
	readonly linkCount: number;
	/** Heals already dispatched for this fingerprint. */
	readonly attempts: number;
	readonly maxRetries: number;
	readonly cooldownMinutes: number;
	/** Agent role the dispatch would use. */
	readonly role: string;
}

export type HealTriageVerdict =
	| { readonly kind: "dispatch" }
	| { readonly kind: "skip"; readonly reason: string };

/** Injected so a test (or a handler) can drive intake without a provider. */
export type HealTriageJudge = (evidence: HealTriageEvidence) => Promise<HealTriageVerdict>;

export function healGateEnabled(env: Record<string, string | undefined>): boolean {
	return TRUE_VALUES.has((env[HEAL_GATE_ENV] ?? "").toLowerCase());
}

function clip(value: string | null, max: number): string | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Build the evidence snapshot the gate judges. The alert body is clipped
 * because the engine does not need a 40 kB stack trace to classify an alert,
 * and every character is paid for.
 */
export function buildHealTriageEvidence(input: {
	readonly projectId: string;
	readonly fingerprint: string;
	readonly source: string;
	readonly title: string;
	readonly culprit: string | null;
	readonly detail: string | null;
	readonly linkCount: number;
	readonly attempts: number;
	readonly maxRetries: number;
	readonly cooldownMinutes: number;
	readonly role: string;
}): HealTriageEvidence {
	return {
		projectId: input.projectId,
		fingerprint: input.fingerprint,
		source: input.source,
		title: clip(input.title, MAX_TITLE) ?? "",
		culprit: clip(input.culprit, MAX_TITLE),
		detail: clip(input.detail, MAX_DETAIL),
		linkCount: input.linkCount,
		attempts: input.attempts,
		maxRetries: input.maxRetries,
		cooldownMinutes: input.cooldownMinutes,
		role: input.role,
	};
}

/**
 * Map one decision onto a verdict. Exported because this is the rule the gate
 * rests on: only `hold` — a confident no — stops the run, and it carries the
 * band in the reason. `act` and `ask` leave the rails' decision standing, and
 * anything the engine could not answer changes nothing.
 */
export function triageVerdict(decision: Decision): HealTriageVerdict {
	if (decision.outcome !== "decided") return { kind: "dispatch" };
	const band = foldBands(Object.values(decision.answers).map((answer) => bandFor(answer)));
	if (band !== "hold") return { kind: "dispatch" };
	return {
		kind: "skip",
		reason: `jevs_hold: ${decision.provider}/${decision.model} in ${decision.ms}ms`,
	};
}

/** Ask Jev whether this alert may spend a run. */
export async function judgeHealTriage(
	evidence: HealTriageEvidence,
	deps?: { readonly env?: Record<string, string | undefined> },
): Promise<HealTriageVerdict> {
	const decision = await decide(
		{
			feature: HEAL_GATE_FEATURE,
			subject: evidence.fingerprint,
			state: {
				project: evidence.projectId,
				source: evidence.source,
				title: evidence.title,
				culprit: evidence.culprit,
				detail: evidence.detail,
				linkCount: evidence.linkCount,
				attempts: evidence.attempts,
				maxRetries: evidence.maxRetries,
				cooldownMinutes: evidence.cooldownMinutes,
				role: evidence.role,
			},
			questions: {
				spend_run: {
					type: "noul",
					instructions:
						"May Warren spend one sandboxed agent run on this production alert right now, on the evidence above?",
					criteria: {
						true: "the alert names a defect in code this project owns, the evidence is enough to start on, and a run is the right next move",
						false:
							"the alert is noise, quota, credential or configuration trouble, a scanner finding, an attack, or too thin to act on",
					},
				},
			},
		},
		deps?.env === undefined ? undefined : { env: deps.env },
	);
	return triageVerdict(decision);
}

/**
 * The judge the alert intake should use, from the process environment: a real
 * Jev call when the gate is switched on, and `undefined` — meaning "no gate" —
 * when it is not.
 */
export function judgeHealFromEnv(
	env: Record<string, string | undefined>,
): HealTriageJudge | undefined {
	if (!healGateEnabled(env)) return undefined;
	return (evidence) => judgeHealTriage(evidence, { env });
}
