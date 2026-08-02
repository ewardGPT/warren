/**
 * Small env/process/db helpers used by `bootServer` (warren-8d3d /
 * pl-9088 step 10). Kept in a sibling module so the orchestrator in
 * `index.ts` stays under the 500-line per-file budget.
 */

import { type AnyWarrenDb, WARREN_DB_POOL_MAX_ENV } from "../../db/client.ts";
import { parseDatabaseUrl } from "../../db/url.ts";
import { defaultSpawn } from "../../projects/clone.ts";
import type { EnvLike } from "../config.ts";

/**
 * The production `Bun.spawn` adaptor, re-exported so `bootServer` keeps
 * importing its process helpers from one module.
 */
export { defaultSpawn };

export async function closeDatabase(db: AnyWarrenDb): Promise<void> {
	try {
		await db.close();
	} catch {
		// Closing twice during a panicked shutdown is fine.
	}
}

/**
 * Read `WARREN_DB_POOL_MAX` (pg pool max). Undefined / blank → use the
 * `openDatabase` default. The pool size only matters on the postgres
 * branch; the sqlite branch ignores it.
 */
export function resolvePgPoolMax(env: EnvLike): number | undefined {
	return parseIntEnv(env, WARREN_DB_POOL_MAX_ENV, undefined);
}

/**
 * Strip the userinfo (`user:password@`) from a postgres URL before
 * logging. sqlite URLs and bare sentinels pass through unchanged.
 * Defensive: any URL-parse failure falls back to the dialect-and-scheme
 * shorthand so a malformed URL never leaks creds into the log.
 */
export function redactDbUrl(url: string): string {
	const parsed = parseDatabaseUrl(url);
	if (parsed.dialect === "sqlite") return url;
	try {
		const u = new URL(parsed.connectionString);
		if (u.username !== "" || u.password !== "") {
			u.username = "";
			u.password = "";
			return u.toString();
		}
		return parsed.connectionString;
	} catch {
		return "postgres://<unparseable>";
	}
}

export function parseTrueEnv(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const t = raw.trim().toLowerCase();
	return t === "1" || t === "true" || t === "yes" || t === "on";
}

export function parseIntEnv<F extends number | undefined>(
	env: EnvLike,
	name: string,
	fallback: F,
): number | F {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n <= 0 || String(n) !== raw) {
		throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
	}
	return n;
}
