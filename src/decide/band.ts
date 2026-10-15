/**
 * `src/decide/band.ts` — the `answer → band` mapping.
 *
 * ## The contract `bandFor` implements
 *
 * `bandFor(answer, { act = 0.9, deny = 0.1 })` collapses one Jev answer
 * into Warren's three-way action band. Thresholds are read as
 * `{ act: actAt, deny: denyAt }` by `decide`, so a caller that only sets
 * `actAt`/`denyAt` never touches this module directly. Answers are read
 * in a fixed priority order — `noul`, then `choice`, then `score` — and
 * a field that is absent or not finite falls through to the next one.
 * An answer with nothing usable (including `undefined`) is `"ask"`: the
 * engine never *acts* on silence.
 *
 * 1. **`noul`** — already normalized to `[0, 1]`.
 *    `noul >= act` → `act`; `noul <= deny` → `hold`; otherwise `ask`.
 *    Boundaries are inclusive, so the default `0.9` is `act` and the
 *    default `0.1` is `hold`.
 *
 * 2. **`choice`** — the model picked one criterion key. The name is
 *    trimmed and lowercased and, when it is exactly `"act"`, `"ask"` or
 *    `"hold"`, that band is returned directly: the question's criterion
 *    names *are* the bands. Any other criterion (say `"defer"`) is not a
 *    band this engine knows, so it degrades to `ask` — never to `act`.
 *
 * 3. **`score`** — a fractional position on the question's ordered
 *    `criteria` legend, not a `[0, 1]` probability. The band compares the
 *    score against the *criteria median* scaled by the threshold:
 *    `score >= act * SCORE_CRITERIA_MEDIAN` → `act`,
 *    `score <= deny * SCORE_CRITERIA_MEDIAN` → `hold`, else `ask`.
 *    `SCORE_CRITERIA_MEDIAN` is `2`, the median index of Jev's five-point
 *    legend (`0 .. 4`), so with the defaults the act bar sits at `1.8`
 *    and the hold bar at `0.2` — a legend score of `1.76` is "just under
 *    the bar" and bands `ask`. A caller whose legend is not five points
 *    wide normalizes the score onto the five-point legend before calling;
 *    the answer carries no legend, so this is the only reading of
 *    "actAt-scaled criteria median" available at this signature.
 */

import { isFiniteNumber } from "./provider.ts";
import type { Answer, Band, BandOptions } from "./types.ts";

/** Default `act` threshold: at/above 0.9 (or 1.8 for a legend score) the engine acts. */
export const DEFAULT_ACT_AT = 0.9;

/** Default `deny` threshold: at/below 0.1 (or 0.2 for a legend score) the engine holds. */
export const DEFAULT_DENY_AT = 0.1;

/**
 * Median index of Jev's five-point `score` legend (`0 … 4`). `bandFor`
 * scales the `act`/`deny` thresholds by it to turn them into score-space
 * bars — see the header contract above.
 */
export const SCORE_CRITERIA_MEDIAN = 2;

/** The bands a `choice` criterion name is allowed to name directly. */
const CHOICE_BANDS: readonly Band[] = ["act", "ask", "hold"];

/** `noul` arm: inclusive thresholds on an already-normalized probability. */
function bandForNoul(noul: number, act: number, deny: number): Band {
	if (noul >= act) return "act";
	if (noul <= deny) return "hold";
	return "ask";
}

/** `choice` arm: a criterion named exactly `act` / `ask` / `hold` bands directly. */
function bandForChoice(choice: string): Band {
	const normalized = choice.trim().toLowerCase();
	const match = CHOICE_BANDS.find((band) => band === normalized);
	return match ?? "ask";
}

/** `score` arm: thresholds scaled by the criteria median into legend space. */
function bandForScore(score: number, act: number, deny: number): Band {
	if (score >= act * SCORE_CRITERIA_MEDIAN) return "act";
	if (score <= deny * SCORE_CRITERIA_MEDIAN) return "hold";
	return "ask";
}

/**
 * Map one Jev answer to an action band. See the header for the exact
 * rule; `undefined` (a question Jev did not answer) is `"ask"`.
 */
export function bandFor(answer: Answer | undefined, opts?: BandOptions): Band {
	const act = isFiniteNumber(opts?.act) ? opts.act : DEFAULT_ACT_AT;
	const deny = isFiniteNumber(opts?.deny) ? opts.deny : DEFAULT_DENY_AT;
	if (answer === undefined) return "ask";
	if (isFiniteNumber(answer.noul)) return bandForNoul(answer.noul, act, deny);
	if (typeof answer.choice === "string") return bandForChoice(answer.choice);
	if (isFiniteNumber(answer.score)) return bandForScore(answer.score, act, deny);
	return "ask";
}

/**
 * Fold many answers into one band, worst-first: any `hold` wins, then any
 * `ask`, and only an all-`act` set acts. A decision engine that merged a
 * branch because one sub-question said "go" while another said "stop"
 * would be worse than useless, so the aggregation is deliberately
 * conservative. `decide` uses this over every question it asked.
 */
export function foldBands(bands: readonly Band[]): Band {
	if (bands.includes("hold")) return "hold";
	if (bands.includes("ask")) return "ask";
	return bands.length === 0 ? "ask" : "act";
}
