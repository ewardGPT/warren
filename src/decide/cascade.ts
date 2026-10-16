/**
 * `src/decide/cascade.ts` — the Laya → Jev tandem.
 *
 * Two System-1 models, one verdict. Laya is the cheap first opinion and
 * Jev is the arbiter.
 *
 * ## Why two
 *
 * Laya is self-hosted. It costs nothing per call and answers in about
 * 40 ms on a kept-alive connection, so it can carry volume that would be
 * wasteful to send to a hosted route. Jev is sharper and carries the
 * stakes. Running both is the point: the free layer absorbs the easy
 * states and the arbiter still sees everything that is not easy.
 *
 * ## The four rules
 *
 * 1. **Laya speaks first.** Always, when it is configured at all.
 * 2. **A block is final.** When Laya holds, the verdict is `hold` and Jev
 *    is never asked to lift it. A second look may add a block and may
 *    never remove one, so escalation only ever happens from `act` or
 *    `ask`.
 * 3. **Confidence decides the escalation.** A Laya verdict whose weakest
 *    answer confidence is at or above the bar stands on its own, and Jev
 *    is not called. Below the bar the state is a gray zone and Jev gets
 *    the call. This is why the bar is the real tuning lever: raising
 *    Laya's calibration on labelled data is what shrinks the Jev bill.
 * 4. **Degrade, never block.** Laya unreachable turns the cascade into a
 *    plain Jev call. Jev unreachable in the gray zone leaves Laya's own
 *    verdict standing, which is at worst `ask`.
 *
 * ## What comes back
 *
 * The two verdicts fold worst-first (`foldBands`), and the returned
 * decision is whichever stage landed on the folded band, with `provider`
 * naming both stages (`laya+typesafe`). The verdict came from the pair,
 * so naming one of them would misreport it.
 *
 * Each stage writes its own line to the decision log through `decide`, so
 * an audit shows the two opinions separately, and the daily cap counts
 * the two calls it actually made.
 */

import { foldBands } from "./band.ts";
import { type DecideDeps, type DecideRequest, decide } from "./client.ts";
import { envString, PROVIDER_ENV, STUB_ENV } from "./provider.ts";
import type { Answer, Decided, Decision, Env } from "./types.ts";

/** Provider name of the self-hosted first opinion. */
export const LAYA_PROVIDER = "laya";

/** Env var that turns the tandem on for `warren decide`. */
export const CASCADE_ENV = "WARREN_JEV_CASCADE";

/** Env var holding the escalation bar, overriding `LAYA_CONFIDENT_AT`. */
export const CONFIDENCE_ENV = "WARREN_JEV_CASCADE_CONFIDENCE";

/** Default escalation bar: a Laya verdict at/above this stands without Jev. */
export const LAYA_CONFIDENT_AT = 0.7;

/** Whether the tandem is switched on in this environment. */
export function cascadeEnabled(env: Env): boolean {
	const raw = envString(env, CASCADE_ENV)?.toLowerCase();
	return raw !== undefined && raw !== "0" && raw !== "false";
}

/** Whether the offline stub is in play, by either switch. */
function stubForced(env: Env): boolean {
	const bySwitch = envString(env, STUB_ENV);
	if (bySwitch !== undefined && bySwitch !== "0") return true;
	return envString(env, PROVIDER_ENV)?.toLowerCase() === "stub";
}

/**
 * The escalation bar out of the environment. Junk, a value outside `[0, 1]`
 * and an unset var all fall back to `LAYA_CONFIDENT_AT`, so a typo narrows
 * nothing and widens nothing.
 */
function confidenceBar(env: Env): number {
	const raw = envString(env, CONFIDENCE_ENV);
	if (raw === undefined) return LAYA_CONFIDENT_AT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return LAYA_CONFIDENT_AT;
	return parsed;
}

/**
 * The weakest confidence among the answers that carry one, or `0` when
 * none does. Worst-first, like `foldBands`: one unsure answer is enough to
 * hand the state to Jev, and a set that reports no confidence at all is
 * treated as unsure rather than as certain.
 */
export function weakestConfidence(answers: Record<string, Answer>): number {
	let weakest: number | undefined;
	for (const answer of Object.values(answers)) {
		const confidence = answer.confidence;
		if (typeof confidence !== "number" || !Number.isFinite(confidence)) continue;
		if (weakest === undefined || confidence < weakest) weakest = confidence;
	}
	return weakest ?? 0;
}

/**
 * Whether Jev should look at a state Laya has already judged. A `hold` is
 * never escalated, and everything else escalates only when Laya is unsure.
 */
export function needsEscalation(first: Decided, confidentAt: number): boolean {
	if (first.band === "hold") return false;
	return weakestConfidence(first.answers) < confidentAt;
}

/**
 * Fold the two verdicts worst-first. The stage that landed on the folded
 * band supplies the answers, and `provider` names both stages.
 */
export function foldCascade(first: Decided, second: Decided): Decided {
	const band = foldBands([first.band, second.band]);
	const chosen = first.band === band ? first : second;
	return { ...chosen, band, provider: `${first.provider}+${second.provider}` };
}

/**
 * Ask Laya, then ask Jev when the answer is not confident enough. Resolves
 * to a `Decision` for every input and never rejects, exactly like `decide`.
 */
export async function decideWithCascade(
	req: DecideRequest,
	overrides?: Partial<DecideDeps>,
): Promise<Decision> {
	const env = overrides?.env ?? process.env;
	const single = () => decide(req, overrides);

	// One opinion is the right answer when the tandem is off, when the
	// offline stub is forced, or when the caller already pointed the engine
	// at Laya itself.
	const aimedAtLaya = envString(env, PROVIDER_ENV)?.toLowerCase() === LAYA_PROVIDER;
	if (!cascadeEnabled(env) || stubForced(env) || aimedAtLaya) return single();

	const first = await decide(req, {
		...overrides,
		env: { ...env, [PROVIDER_ENV]: LAYA_PROVIDER },
	});
	if (first.outcome !== "decided") return single();
	if (!needsEscalation(first, confidenceBar(env))) return first;

	const arbiter = await single();
	if (arbiter.outcome !== "decided") return first;
	return foldCascade(first, arbiter);
}
