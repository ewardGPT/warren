/**
 * Shared test rig for `src/decide/*.test.ts`. Everything here is a seam,
 * not a reimplementation: a recording `fetch`, a harness that assembles
 * `DecideDeps` with a fake fetch/clock/sleep/cache and an env pointed at
 * a throwaway log file, plus the canonical question set and the real 200
 * body the engine is expected to parse.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CacheEntry } from "./cache.ts";
import type { DecideDeps, FetchLike } from "./client.ts";
import type { DecisionRecord } from "./record.ts";
import type { Env, Question } from "./types.ts";

export interface RecordedCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
	signal: AbortSignal | null;
}

/**
 * A canned response: a `Response`, or a factory that may throw (dropped
 * connection) or hang — it receives the `RequestInit` so a factory can
 * wire itself to the abort signal the way a real socket does.
 */
export type Canned = Response | ((init?: RequestInit) => Response | Promise<Response>);

export function recordingFetch(responses: ReadonlyArray<Canned>): {
	fetch: FetchLike;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	let index = 0;
	const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		// Test seam: our own code always passes a plain string map of headers.
		const headers = (init?.headers ?? {}) as Record<string, string>;
		calls.push({
			url,
			method: (init?.method ?? "GET").toUpperCase(),
			headers,
			body: typeof init?.body === "string" ? init.body : null,
			signal: init?.signal ?? null,
		});
		const next = responses[index];
		index += 1;
		if (next === undefined) throw new Error("recordingFetch: ran out of canned responses");
		return typeof next === "function" ? next(init) : next;
	};
	return { fetch: fn, calls };
}

/** A canned response that hangs until aborted, the way a real socket does. */
export function abortableResponse(): (init?: RequestInit) => Promise<Response> {
	return (init) => {
		const { promise, reject } = Promise.withResolvers<Response>();
		init?.signal?.addEventListener("abort", () => {
			reject(new DOMException("The operation was aborted.", "AbortError"));
		});
		return promise;
	};
}

export function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

export function textResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "text/html" } });
}

export interface HarnessInput {
	responses?: ReadonlyArray<Canned>;
	env?: Env;
	now?: () => number;
	fetch?: FetchLike;
}

export interface Harness {
	/** Overrides for `decide`'s second argument. */
	deps: Partial<DecideDeps>;
	env: Env;
	calls: RecordedCall[];
	sleeps: number[];
	records: DecisionRecord[];
	logPath: string;
	cache: Map<string, CacheEntry>;
}

/**
 * Assemble an offline `decide` environment. The default env carries a fake
 * typesafe key and a temp `WARREN_DECISION_LOG`; the default `append`
 * collects records in memory (a test that wants the real file drops the
 * override and reads `harness.logPath`).
 */
export function makeHarness(input: HarnessInput = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "warren-decide-"));
	const logPath = join(dir, "decisions.jsonl");
	const env: Env = {
		HOME: dir,
		TYPESAFE_API_KEY: "test-key",
		WARREN_DECISION_LOG: logPath,
		...input.env,
	};
	const recorded = recordingFetch(input.responses ?? []);
	const calls = recorded.calls;
	const sleeps: number[] = [];
	const records: DecisionRecord[] = [];
	const cache: Map<string, CacheEntry> = new Map();
	const deps: Partial<DecideDeps> = {
		env,
		fetch: input.fetch ?? recorded.fetch,
		now: input.now ?? (() => Date.now()),
		sleep: (ms: number) => {
			sleeps.push(ms);
			return Promise.resolve();
		},
		append: (record: DecisionRecord) => {
			records.push(record);
		},
		cache,
	};
	return { deps, env, calls, sleeps, records, logPath, cache };
}

/** A fixed clock, so `ms` and the cache TTL are deterministic. */
export const FIXED_NOW = 1_760_000_000_000;

export const NOUL_QUESTION: Question = {
	type: "noul",
	instructions: "Is it safe to merge this branch without human review?",
	criteria: { true: "safe to merge", false: "not safe" },
};

export const SCORE_QUESTION: Question = {
	type: "score",
	instructions: "Rate the risk of this change",
	criteria: ["untested path", "low risk", "moderate risk", "high risk", "critical"],
};

export const CHOICE_QUESTION: Question = {
	type: "choice",
	instructions: "What should Warren do next?",
	criteria: { act: "merge now", ask: "ask a human", hold: "stop" },
};

/** The canonical question set: one of each type, named for the sample 200 body. */
export const QUESTION_SET: Record<string, Question> = {
	merge_ok: NOUL_QUESTION,
	risk: SCORE_QUESTION,
	band: CHOICE_QUESTION,
};

/** The real 200 body logged from api.typesafe.ai (138 ms, 502/69 tokens). */
export const SAMPLE_RESPONSE = {
	model: "jev-1.13.0",
	answers: {
		merge_ok: { type: "noul", noul: 0.81, confidence: 0.79 },
		band: {
			type: "choice",
			choice: "act",
			confidence: 0.79,
			probabilities: { act: 0.86, ask: 0.05, hold: 0.09 },
		},
		risk: {
			type: "score",
			score: 1.76,
			confidence: 0.62,
			legend: { 0: "untested path", 4: "critical" },
		},
	},
	usage: { input_tokens: 502, output_tokens: 69 },
} as const;

/** The three answers of `SAMPLE_RESPONSE`, as `decide` normalizes them. */
export const SAMPLE_ANSWERS = {
	merge_ok: { noul: 0.81, confidence: 0.79 },
	risk: { score: 1.76, confidence: 0.62 },
	band: { choice: "act", confidence: 0.79 },
};
