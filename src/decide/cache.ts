/**
 * `src/decide/cache.ts` — the in-process decision cache.
 *
 * A hit is a decision with `via: "cache"`, so a caller can tell a reused answer
 * from a fresh one. The TTL is opt-in through `WARREN_JEV_CACHE_TTL_MS`; unset
 * or `0` disables the cache, which is the default, because a cached judgement
 * about state that has since changed is worse than no judgement.
 */

import type { DecideDeps, DecideRequest } from "./client.ts";
import { type ProviderChoice, readPositiveInt } from "./provider.ts";
import { hashJson } from "./record.ts";
import type { Decided, Env } from "./types.ts";

/** In-process decision cache TTL; unset or `0` disables the cache. */
export const CACHE_TTL_ENV = "WARREN_JEV_CACHE_TTL_MS";

/** Cache ceiling; hitting it clears the cache rather than growing without bound. */
export const CACHE_MAX_ENTRIES = 256;

export interface CacheEntry {
	decision: Decided;
	at: number;
}

/* ----------------------------------------------------------------------- */
/* Cache                                                                   */
/* ----------------------------------------------------------------------- */

export function cacheTtlMs(env: Env): number {
	return readPositiveInt(env, CACHE_TTL_ENV) ?? 0;
}

export function cacheKey(provider: ProviderChoice, req: DecideRequest): string {
	return hashJson({
		provider: provider.name,
		model: provider.model,
		state: req.state,
		questions: req.questions,
	});
}

export function readCache(deps: DecideDeps, key: string, started: number): Decided | null {
	const ttl = cacheTtlMs(deps.env);
	if (ttl === 0) return null;
	const hit = deps.cache.get(key);
	if (hit === undefined) return null;
	if (started - hit.at > ttl) {
		deps.cache.delete(key);
		return null;
	}
	return { ...hit.decision, via: "cache", ms: Math.max(0, Math.round(deps.now() - started)) };
}

export function writeCache(deps: DecideDeps, key: string, decision: Decided, at: number): void {
	if (cacheTtlMs(deps.env) === 0) return;
	if (deps.cache.size >= CACHE_MAX_ENTRIES) deps.cache.clear();
	deps.cache.set(key, { decision, at });
}
