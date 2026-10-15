/**
 * `src/decide/budget.ts` — the two brakes on `decide`: a per-feature
 * wall-clock timeout and an optional daily call cap.
 *
 * ## Timeout
 *
 * `resolveTimeoutMs` is per-feature: `WARREN_JEV_TIMEOUT_MS_<FEATURE>`
 * (feature uppercased, non-alphanumerics collapsed to `_`) wins, then the
 * request's own `timeoutMs`, then the global `WARREN_JEV_TIMEOUT_MS`, then
 * `DEFAULT_TIMEOUT_MS` (4000). The result is clamped to
 * `[MIN_TIMEOUT_MS, MAX_TIMEOUT_MS]` so neither a stray `0` nor a stray
 * `999999999` env value can turn the engine into a hang or a no-op.
 *
 * The budget is a *whole-call* deadline: `client.ts` spends it across the
 * first attempt and its one retry, so a decision can never outlive it.
 *
 * ## Daily cap
 *
 * `WARREN_JEV_DAILY_CAP` (default off) is a per-feature ceiling on live
 * provider calls for the current UTC day, counted from the decision log —
 * the log is the only durable record of what was actually spent, so the
 * cap survives a restart and needs no counter file. A record counts when
 * `feature` matches and `via` is `"live"`: `stub` calls are free and
 * `cache` hits cost nothing, so neither may exhaust the budget. Unset,
 * `0`, negative or unparseable all mean "no cap".
 */

import { envString, isRecord, readPositiveInt } from "./provider.ts";
import type { Env } from "./types.ts";

/** Default whole-call wall clock when nothing overrides it. */
export const DEFAULT_TIMEOUT_MS = 4000;

export const MIN_TIMEOUT_MS = 10;
export const MAX_TIMEOUT_MS = 120_000;

export const TIMEOUT_ENV = "WARREN_JEV_TIMEOUT_MS";
export const DAILY_CAP_ENV = "WARREN_JEV_DAILY_CAP";

/**
 * The per-feature timeout env var for `feature`. Exported (and not
 * inlined at the call site) because the key mangling is part of the
 * documented contract — `merge-guard` → `WARREN_JEV_TIMEOUT_MS_MERGE_GUARD`.
 */
export function featureTimeoutEnv(feature: string): string {
	return `${TIMEOUT_ENV}_${feature.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;
}

function clampTimeout(ms: number): number {
	return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)));
}

export interface TimeoutInput {
	feature: string;
	timeoutMs?: number;
	env: Env;
}

/** Resolve the whole-call deadline in milliseconds. */
export function resolveTimeoutMs(input: TimeoutInput): number {
	const perFeature = readPositiveInt(input.env, featureTimeoutEnv(input.feature));
	if (perFeature !== undefined) return clampTimeout(perFeature);
	if (
		typeof input.timeoutMs === "number" &&
		Number.isFinite(input.timeoutMs) &&
		input.timeoutMs > 0
	) {
		return clampTimeout(input.timeoutMs);
	}
	return clampTimeout(readPositiveInt(input.env, TIMEOUT_ENV) ?? DEFAULT_TIMEOUT_MS);
}

/** The daily live-call ceiling for a feature, or `null` when the cap is off. */
export function dailyCap(env: Env): number | null {
	return readPositiveInt(env, DAILY_CAP_ENV) ?? null;
}

/** `2026-10-15` — the UTC day a record belongs to. */
export function utcDay(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

/**
 * Count today's live calls for `feature` in a raw JSONL log body.
 * Malformed lines and records for other days/features are skipped, never
 * thrown over — a corrupt log must not wedge the engine.
 */
export function countLiveCalls(text: string, feature: string, day: string): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed)) continue;
		if (parsed.feature !== feature) continue;
		if (parsed.via !== "live") continue;
		if (typeof parsed.ts !== "string" || !parsed.ts.startsWith(day)) continue;
		count += 1;
	}
	return count;
}

export type CapResult = { ok: true; used: number; cap: number } | { ok: false; reason: string };

export interface CapInput {
	feature: string;
	env: Env;
	logText: string;
	now: number;
}

/** Decide whether this feature may make one more live call today. */
export function checkDailyCap(input: CapInput): CapResult {
	const cap = dailyCap(input.env);
	if (cap === null) return { ok: true, used: 0, cap: 0 };
	const used = countLiveCalls(input.logText, input.feature, utcDay(input.now));
	if (used < cap) return { ok: true, used, cap };
	return {
		ok: false,
		reason: `daily call cap reached for "${input.feature}": ${used}/${cap} live calls on ${utcDay(input.now)} (${DAILY_CAP_ENV}=${envString(input.env, DAILY_CAP_ENV)})`,
	};
}
