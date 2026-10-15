/**
 * Liveness and load for every fleet box.
 *
 * Two calls per box, both cheap and both against the box's own burrow:
 *
 *   1. `probe()` → `GET /healthz` with a timeout. This says the box answers at
 *      all. It is auth-EXEMPT by burrow's contract, so it proves reachability
 *      and nothing about the token.
 *   2. `burrows.list()` → the live workspaces on that box. This is auth-checked,
 *      so it doubles as the token check, and it is the load number placement
 *      ranks on (`state === "active"`; a stopped burrow holds a workspace but
 *      runs nothing).
 *
 * A box that fails EITHER call is unhealthy, and unhealthy boxes are skipped by
 * placement rather than retried: a dispatch into an unreachable box produces a
 * run that dies at its first call, which is worse than not starting it.
 *
 * Results are cached for a short window (`healthTtlMs`) because a burst of
 * dispatches must not probe every box per run, while placement still wants a
 * number that is seconds fresh.
 */

import type { BurrowClient } from "../../../burrow-client/index.ts";
import type { RuntimeProvider } from "../../contract.ts";
import type { SshRunner } from "./remote-seams.ts";

export interface FleetBoxRuntime {
	readonly id: string;
	readonly client: BurrowClient;
	readonly provider: RuntimeProvider;
	/** The box's shell, used to materialize the project clone burrow cuts from. */
	readonly ssh: SshRunner;
}

export interface BoxHealth {
	readonly id: string;
	readonly healthy: boolean;
	/** Live (`state: "active"`) workspaces on the box, or 0 when unreadable. */
	readonly live: number;
	/** Why the box is unhealthy, for a log line. Never a token or a full url. */
	readonly detail: string | null;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
export const DEFAULT_HEALTH_TTL_MS = 5_000;

export interface FleetLogger {
	warn(obj: object, msg?: string): void;
	info?(obj: object, msg?: string): void;
}

export interface ProbeDeps {
	readonly timeoutMs?: number;
	readonly log?: FleetLogger;
}

export async function probeBoxes(
	boxes: readonly FleetBoxRuntime[],
	deps: ProbeDeps = {},
): Promise<Map<string, BoxHealth>> {
	const timeoutMs = deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const results = await Promise.all(boxes.map((box) => probeBox(box, timeoutMs)));
	const health = new Map<string, BoxHealth>();
	for (const result of results) {
		health.set(result.id, result);
		if (!result.healthy) {
			deps.log?.warn({ box: result.id, detail: result.detail }, "fleet: box unhealthy");
		}
	}
	return health;
}

async function probeBox(box: FleetBoxRuntime, timeoutMs: number): Promise<BoxHealth> {
	const unhealthy = (detail: string): BoxHealth => ({
		id: box.id,
		healthy: false,
		live: 0,
		detail,
	});
	try {
		await box.client.probe(timeoutMs);
	} catch (error) {
		return unhealthy(`healthz: ${describe(error)}`);
	}
	try {
		const burrows = await box.client.http.burrows.list({});
		return {
			id: box.id,
			healthy: true,
			live: burrows.filter((burrow) => burrow.state === "active").length,
			detail: null,
		};
	} catch (error) {
		return unhealthy(`burrows.list: ${describe(error)}`);
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Health with a short freshness window. `now` is injected so a test can advance
 * the clock instead of sleeping, and so the cache cannot hide a box's recovery
 * for longer than the window.
 */
export class FleetHealthCache {
	private cached: { at: number; health: Map<string, BoxHealth> } | null = null;

	constructor(
		private readonly boxes: readonly FleetBoxRuntime[],
		private readonly deps: ProbeDeps & {
			readonly ttlMs?: number;
			readonly now?: () => number;
		} = {},
	) {}

	async read(): Promise<Map<string, BoxHealth>> {
		const now = this.deps.now?.() ?? Date.now();
		const ttl = this.deps.ttlMs ?? DEFAULT_HEALTH_TTL_MS;
		const cached = this.cached;
		if (cached !== null && now - cached.at < ttl) return cached.health;
		const probeDeps: ProbeDeps = {};
		if (this.deps.timeoutMs !== undefined)
			Object.assign(probeDeps, { timeoutMs: this.deps.timeoutMs });
		if (this.deps.log !== undefined) Object.assign(probeDeps, { log: this.deps.log });
		const health = await probeBoxes(this.boxes, probeDeps);
		this.cached = { at: now, health };
		return health;
	}
}
