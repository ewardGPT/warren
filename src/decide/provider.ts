/**
 * `src/decide/provider.ts` — the Jev wire protocol: which provider to hit,
 * how to authenticate, what to POST, and how to read the answer back.
 *
 * Three hosted routes speak the same `POST <url>` JSON contract:
 *
 *   | name         | url                                            | model            | key env                                |
 *   |--------------|------------------------------------------------|------------------|----------------------------------------|
 *   | `typesafe`   | https://api.typesafe.ai/v1/systemone           | jev-1.13.0       | TYPESAFE_API_KEY, JEV_API_KEY          |
 *   | `openrouter` | https://openrouter.ai/api/alpha/decisions      | typesafe/jev-1.13| OPENROUTER_API_KEY                     |
 *   | `vercel`     | https://ai-gateway.vercel.sh/typesafe/v1/systemone | typesafe-ai/jev | AI_GATEWAY_API_KEY                  |
 *   | `laya`       | http://172.17.0.1:18091/v1/systemone (LAYA_URL) | typed-decisions | LAYA_API_KEY (optional)                |
 *
 * plus the offline `stub` provider (`WARREN_JEV_STUB=1` or
 * `JEV_PROVIDER=stub`), which answers from a fixture instead of the
 * network. Precedence: an explicit `JEV_PROVIDER` (an unknown value is
 * reported, never silently ignored), else the first of `typesafe` /
 * `openrouter` whose key is present, else `typesafe` so the caller gets a
 * "key is not set" reason naming the env vars it needs. `JEV_MODEL`
 * overrides the model for any hosted route. `laya` is deliberately absent
 * from that order, so no call reaches it by accident: only an explicit
 * `JEV_PROVIDER=laya`, or the cascade in `cascade.ts`, selects it.
 *
 * Request: `Authorization: Bearer <key>`, `Content-Type: application/json`,
 * `X-Title: <title>`; body `{ "model", "state", "questions" }`.
 * Response 200: `{ "model", "answers": { <name>: { type, noul|score|choice,
 * confidence } }, "usage": { "input_tokens", "output_tokens" } }`.
 *
 * `parseJevResponse` is strict on purpose: every requested question must
 * come back with a usable payload, because a partially answered set is
 * worse than no answer at all — `decide` turns it into `unavailable`
 * rather than silently acting on the subset that arrived.
 */

import type { Answer, DecisionUsage, Env, Question } from "./types.ts";

export interface ProviderSpec {
	readonly name: string;
	readonly url: string;
	readonly model: string;
	readonly keyEnvs: readonly string[];
	/**
	 * Env var holding the full endpoint, overriding `url`. A self-hosted
	 * route lives at an address only its operator knows, so its URL cannot
	 * be a constant in this table.
	 */
	readonly urlEnv?: string;
	/**
	 * `true` when the route authenticates on its own side and a client key
	 * is therefore not required. The `laya` relay injects the key it holds,
	 * so demanding a key env would report a missing key for a working route.
	 */
	readonly keyOptional?: boolean;
	/**
	 * `true` when the route also serves `<url>/batch`, which answers many
	 * states in one forward pass. The batch address is derived from the
	 * resolved endpoint, so an override moves both routes together.
	 */
	readonly batches?: boolean;
}

export const PROVIDERS = {
	typesafe: {
		name: "typesafe",
		url: "https://api.typesafe.ai/v1/systemone",
		model: "jev-1.13.0",
		keyEnvs: ["TYPESAFE_API_KEY", "JEV_API_KEY"],
	},
	openrouter: {
		name: "openrouter",
		url: "https://openrouter.ai/api/alpha/decisions",
		model: "typesafe/jev-1.13",
		keyEnvs: ["OPENROUTER_API_KEY"],
	},
	vercel: {
		name: "vercel",
		url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
		model: "typesafe-ai/jev",
		keyEnvs: ["AI_GATEWAY_API_KEY"],
	},
	/**
	 * The self-hosted System-1 lane. This is a *second* opinion beside
	 * Jev, never a substitute for it, so it stays out of
	 * `DEFAULT_PROVIDER_ORDER` and is reached only on purpose.
	 */
	laya: {
		name: "laya",
		url: "http://172.17.0.1:18091/v1/systemone",
		// The checkpoint the lane must serve, named explicitly. This was "laya",
		// which is not a checkpoint -- the lane maps it elsewhere (measured: it
		// answers byte-identically to `english`), so every production decision was
		// read from the wrong model. `typed-decisions` is the fine-tune.
		model: "typed-decisions",
		keyEnvs: ["LAYA_API_KEY"],
		urlEnv: "LAYA_URL",
		keyOptional: true,
		batches: true,
	},
	stub: { name: "stub", url: "", model: "jev-stub", keyEnvs: [] },
} as const satisfies Record<string, ProviderSpec>;

export type ProviderName = keyof typeof PROVIDERS;

/** Providers tried in order when `JEV_PROVIDER` is unset. */
const DEFAULT_PROVIDER_ORDER: readonly ProviderName[] = ["typesafe", "openrouter"];

/** Provider used to phrase the "no key anywhere" reason. */
const FALLBACK_PROVIDER: ProviderName = "typesafe";

/** Env var that forces the offline provider. */
export const STUB_ENV = "WARREN_JEV_STUB";

export const PROVIDER_ENV = "JEV_PROVIDER";
export const MODEL_ENV = "JEV_MODEL";
export const TITLE_ENV = "JEV_TITLE";
export const DEFAULT_TITLE = "warren";

export interface ProviderChoice {
	name: string;
	url: string;
	model: string;
	/** Empty for `stub`, which never authenticates. */
	key: string;
	/** The batch endpoint, present only when the route serves one. */
	batchUrl?: string;
}

export type ProviderResult = { ok: true; provider: ProviderChoice } | { ok: false; reason: string };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Finite-number guard shared by the wire parser and the band mapper. */
export function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return isFiniteNumber(value) ? value : undefined;
}

/** Trimmed value of `env[name]`, or `undefined` when unset/blank. */
export function envString(env: Env, name: string): string | undefined {
	const raw = env[name];
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Positive integer out of `env[name]` — used for the numeric knobs
 * (timeout, daily cap, cache TTL). Unset, blank, `0`, negative,
 * fractional or unparseable all read as `undefined` so every caller
 * treats "junk in the env" as "feature off" instead of guessing.
 */
export function readPositiveInt(env: Env, name: string): number | undefined {
	const raw = envString(env, name);
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) return undefined;
	return parsed;
}

/** First key present among `spec.keyEnvs`, or `undefined`. */
export function resolveKey(spec: ProviderSpec, env: Env): string | undefined {
	for (const name of spec.keyEnvs) {
		const key = envString(env, name);
		if (key !== undefined) return key;
	}
	return undefined;
}

function readProviderName(env: Env): { name: ProviderName; explicit: boolean } | { error: string } {
	const raw = envString(env, PROVIDER_ENV)?.toLowerCase();
	if (raw === undefined) {
		if (envString(env, STUB_ENV) !== undefined && envString(env, STUB_ENV) !== "0") {
			return { name: "stub", explicit: true };
		}
		for (const candidate of DEFAULT_PROVIDER_ORDER) {
			if (resolveKey(PROVIDERS[candidate], env) !== undefined) {
				return { name: candidate, explicit: false };
			}
		}
		return { name: FALLBACK_PROVIDER, explicit: false };
	}
	if (raw in PROVIDERS) return { name: raw as ProviderName, explicit: true };
	return {
		error: `unknown ${PROVIDER_ENV} "${raw}" (expected ${Object.keys(PROVIDERS).join(", ")})`,
	};
}

/**
 * Pick the provider + key for this call. Reports an explicit unknown
 * `JEV_PROVIDER`, and reports the missing key env vars when the selected
 * provider has no key — both as data, never as a throw.
 */
export function resolveProvider(env: Env): ProviderResult {
	const picked = readProviderName(env);
	if ("error" in picked) return { ok: false, reason: picked.error };
	const spec: ProviderSpec = PROVIDERS[picked.name];
	const url = endpointFor(spec, env);
	if (spec.name === "stub") {
		return { ok: true, provider: { name: spec.name, url, model: spec.model, key: "" } };
	}
	const key = resolveKey(spec, env);
	if (key === undefined && spec.keyOptional !== true) {
		return {
			ok: false,
			reason: `${spec.name} provider has no API key (set ${spec.keyEnvs.join(" or ")})`,
		};
	}
	const model = envString(env, MODEL_ENV) ?? spec.model;
	const batch = spec.batches === true ? { batchUrl: `${url}/batch` } : {};
	return { ok: true, provider: { name: spec.name, url, model, key: key ?? "", ...batch } };
}

/** The provider's endpoint: `urlEnv` when it is set, else the table's constant. */
function endpointFor(spec: ProviderSpec, env: Env): string {
	if (spec.urlEnv === undefined) return spec.url;
	return envString(env, spec.urlEnv) ?? spec.url;
}

/** Headers for a Jev POST. `X-Title` is openrouter's app-attribution header. */
export function buildHeaders(key: string, title: string): Record<string, string> {
	return {
		authorization: `Bearer ${key}`,
		"content-type": "application/json",
		"x-title": title,
	};
}

/** The POST body. `questions` is forwarded verbatim — Jev speaks Warren's `Question` shape. */
export function buildRequestBody(
	model: string,
	state: Record<string, unknown>,
	questions: Record<string, Question>,
): string {
	return JSON.stringify({ model, state, questions });
}

/** Read `usage` from either the snake_case wire spelling or Warren's camelCase. */
export function readUsage(value: unknown): DecisionUsage | undefined {
	if (!isRecord(value)) return undefined;
	const inputTokens = readNumber(value.input_tokens) ?? readNumber(value.inputTokens);
	const outputTokens = readNumber(value.output_tokens) ?? readNumber(value.outputTokens);
	if (inputTokens === undefined && outputTokens === undefined) return undefined;
	return { inputTokens, outputTokens };
}

/**
 * Normalize one wire answer into an `Answer` carrying only the fields
 * that were actually present (so a caller can `toEqual` an answer without
 * spelling out three `undefined`s). `null` means "no usable payload" — an
 * entry carrying only `confidence` is not an answer.
 */
export function readAnswer(value: unknown): Answer | null {
	if (!isRecord(value)) return null;
	const noul = readNumber(value.noul);
	const score = readNumber(value.score);
	const choice = readString(value.choice);
	if (noul === undefined && score === undefined && choice === undefined) return null;
	const answer: Answer = {};
	if (noul !== undefined) answer.noul = noul;
	if (score !== undefined) answer.score = score;
	if (choice !== undefined) answer.choice = choice;
	const confidence = readNumber(value.confidence);
	if (confidence !== undefined) answer.confidence = confidence;
	return answer;
}

export interface ParsedResponse {
	model?: string;
	usage?: DecisionUsage;
	answers: Record<string, Answer>;
}

export type ParseResult = { ok: true; value: ParsedResponse } | { ok: false; reason: string };

/** Require an answer for every requested question; anything short of that is a parse failure. */
export function parseJevResponse(raw: unknown, questions: Record<string, Question>): ParseResult {
	if (!isRecord(raw)) return { ok: false, reason: "response body was not a JSON object" };
	if (!isRecord(raw.answers)) return { ok: false, reason: 'response had no "answers" object' };
	const answers: Record<string, Answer> = {};
	const missing: string[] = [];
	for (const name of Object.keys(questions)) {
		const answer = readAnswer(raw.answers[name]);
		if (answer === null) missing.push(name);
		else answers[name] = answer;
	}
	if (missing.length > 0) {
		return { ok: false, reason: `response carried no usable answer for: ${missing.join(", ")}` };
	}
	return {
		ok: true,
		value: { model: readString(raw.model), usage: readUsage(raw.usage), answers },
	};
}

/**
 * Parse a `Retry-After` header into milliseconds. Only the delta-seconds
 * form is honoured — the HTTP-date form would need a shared clock, and a
 * mis-parsed date would be a retry storm. Absent, fractional or
 * unparseable values return `null` so the caller falls back to its own
 * delay instead of retrying immediately.
 */
export function parseRetryAfterMs(header: string | null): number | null {
	if (header === null) return null;
	const trimmed = header.trim();
	if (!/^\d+$/.test(trimmed)) return null;
	return Number.parseInt(trimmed, 10) * 1000;
}

/**
 * Best-effort human message out of an error body — openrouter answers
 * `{"error":{"message":"…"}}`, others a bare `message`. Clipped so a
 * verbose body never lands whole in a decision reason or the log.
 */
export function extractErrorMessage(raw: unknown, limit = 200): string | undefined {
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		return trimmed.length === 0 ? undefined : trimmed.slice(0, limit);
	}
	if (!isRecord(raw)) return undefined;
	const nested = isRecord(raw.error) ? readString(raw.error.message) : undefined;
	const message = nested ?? readString(raw.message) ?? readString(raw.detail);
	return message === undefined ? undefined : message.slice(0, limit);
}
