/**
 * `src/decide/internal.ts` — helpers shared by the live path, the cache and the
 * stub provider. Split out of `client.ts` so no single file carries the whole
 * engine; nothing here is public beyond the barrel in `index.ts`.
 */

import { bandFor, foldBands } from "./band.ts";
import type { Answer, Band, BandOptions, Decided, Decision } from "./types.ts";

export function unavailable(reason: string): Decision {
	return { outcome: "unavailable", reason };
}

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

interface SettledInput {
	started: number;
	now: number;
	provider: string;
	model: string;
	via: Decided["via"];
	usage: Decided["usage"];
	answers: Record<string, Answer>;
	thresholds: BandOptions;
}

export function settled(input: SettledInput): Decided {
	return {
		outcome: "decided",
		answers: input.answers,
		band: bandOf(input.answers, input.thresholds),
		provider: input.provider,
		model: input.model,
		ms: Math.max(0, Math.round(input.now - input.started)),
		usage: input.usage,
		via: input.via,
	};
}

/** An answer to a question named `band` wins; otherwise fold worst-first. */
export function bandOf(answers: Record<string, Answer>, thresholds: BandOptions): Band {
	const explicit = answers.band;
	if (explicit !== undefined) return bandFor(explicit, thresholds);
	return foldBands(Object.values(answers).map((answer) => bandFor(answer, thresholds)));
}
