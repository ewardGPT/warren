/**
 * `src/decide/types.ts` — Warren's decision vocabulary over TypeSafe's Jev
 * ("System One") decision model.
 *
 * Jev answers a *set* of named questions about a *state* snapshot in one
 * round-trip. Each question carries its own answer type:
 *
 *   - `noul`   — Jev's continuous judgement in `[0, 1]`
 *                (1 = "yes / certain", 0 = "no / certain").
 *   - `score`  — a position on the question's ordered `criteria` legend
 *                (index 0 .. criteria.length - 1).
 *   - `choice` — exactly one key out of the question's `criteria` map.
 *
 * Everything here is a pure type; the behaviour lives in `band.ts`
 * (band mapping), `provider.ts` (wire protocol), `client.ts` (`decide`),
 * `record.ts` (JSONL audit log) and `budget.ts` (timeout + daily cap).
 *
 * This module deliberately depends on nothing but the other files in
 * `src/decide/` so it stays usable from every layer of Warren.
 */

/** A single named question handed to Jev. */
export type Question =
	| { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: "score"; instructions: string; criteria: string[] }
	| { type: "choice"; instructions: string; criteria: Record<string, string> };

/** Jev's answer to one question. Only the field matching the question's `type` is meaningful. */
export type Answer = {
	noul?: number;
	score?: number;
	choice?: string;
	confidence?: number;
};

/** The three-way action band a single answer (or a whole decision) falls into. */
export type Band = "act" | "ask" | "hold";

/** Token accounting as Jev reports it, renamed to Warren's camelCase spelling. */
export interface DecisionUsage {
	inputTokens?: number;
	outputTokens?: number;
}

/** How the answer was obtained: a real provider call, the in-process cache, or the stub provider. */
export type DecisionVia = "live" | "cache" | "stub";

/** A decision the engine stands behind: every requested question came back and mapped to a band. */
export interface Decided {
	outcome: "decided";
	answers: Record<string, Answer>;
	band: Band;
	provider: string;
	model: string;
	ms: number;
	usage?: DecisionUsage;
	via: DecisionVia;
}

/**
 * A decision the engine refuses to stand behind. `unavailable` = the
 * provider never produced a usable answer (no key, HTTP error, timeout,
 * malformed body); `unsure` = the engine ran but was asked nothing to
 * judge; `over-budget` = the daily call cap for this feature is spent.
 */
export interface Undecided {
	outcome: "unavailable" | "unsure" | "over-budget";
	reason: string;
}

export type Decision = Decided | Undecided;

/** Thresholds `bandFor` uses to separate `hold` / `ask` / `act`. */
export interface BandOptions {
	/** At/above this the answer is `act`. Default 0.9. */
	act?: number;
	/** At/below this the answer is `hold`. Default 0.1. */
	deny?: number;
}

/**
 * The environment shape every module in `src/decide/` reads config from.
 * Injectable so tests never touch `process.env`.
 */
export type Env = Record<string, string | undefined>;
