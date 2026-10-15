/**
 * The `fleet` runtime provider: warren's runs execute on the agentic boxes.
 *
 * WHY A PROVIDER AND NOT A SCHEDULER. Every backend in this repo already
 * implements one 8-method contract (`../contract.ts`), and the domain (runs,
 * watchdog, reap, steering) only ever calls those methods. Placement is the one
 * thing the contract does not express, so the fleet backend adds exactly that —
 * a box choice in `create()` — and delegates everything else to the box's own
 * `LocalProvider`. That is why the boxes behave identically to the self-host
 * backend: same burrow protocol, same sandbox profile, same toolchains, same
 * event stream shape, one host further away.
 *
 * WHAT A BOX NEEDS THAT A LOCAL BURROW DOES NOT.
 *   1. A reachable callback URL. `LocalProvider` computes `WARREN_API_URL` as
 *      `http://localhost:PORT` (a co-tenancy assumption). A box cannot reach
 *      warren's loopback, so the callback must be an address the box can dial —
 *      the tailnet address. That override lives in `./index.ts` (it rewrites the
 *      provider's `serverEnv`), not in the domain, because the provider owns its
 *      own plumbing.
 *   2. Work that lands. `finalize()` is the workspace-dependent half of reap
 *      (commit, push, diff). The workspace is on the box, so this provider hands
 *      each box's `LocalProvider` ssh-backed `fs`/`exec` seams
 *      (`./remote-seams.ts`) — reap itself is unchanged and unaware.
 *
 * ROUTING uses the encoded handle (`./handle.ts`), so a run started before a
 * restart still resolves to its box afterwards.
 */

import type {
	FinalizeIntent,
	FinalizeResult,
	Message,
	NormalizedEvent,
	OutboundMessage,
	RunHandle,
	RunSpec,
	RunStatus,
	RuntimeCapabilities,
	RuntimeProvider,
	StreamOpts,
	TeardownResult,
	WorkspaceInfo,
} from "../../contract.ts";
import { LOCAL_PROVIDER_CAPABILITIES } from "../provider.ts";
import { FleetUnavailableError, FleetUnknownBoxError } from "./errors.ts";
import { decodeProviderRunId, encodeProviderRunId } from "./handle.ts";
import {
	type BoxHealth,
	type FleetBoxRuntime,
	FleetHealthCache,
	type FleetLogger,
} from "./health.ts";
import { ensureProjectClone } from "./materialize.ts";
import { chooseBox, type PlacementOptions } from "./placement.ts";

export interface FleetProviderDeps {
	readonly boxes: readonly FleetBoxRuntime[];
	readonly log?: FleetLogger;
	/** Overrides the probe timeout; tests inject a small one. */
	readonly probeTimeoutMs?: number;
	/** Freshness window for the health cache. */
	readonly healthTtlMs?: number;
	readonly placement?: PlacementOptions;
	/** Clock seam for the health cache. */
	readonly now?: () => number;
	/**
	 * Health seam. Defaults to probing each box's burrow (`FleetHealthCache`);
	 * tests inject a map so placement is exercised without a network.
	 */
	readonly probe?: () => Promise<Map<string, BoxHealth>>;
	/** Env for the box clone root (`WARREN_FLEET_PROJECT_ROOT`). */
	readonly env?: Record<string, string | undefined>;
	/**
	 * Materialization seam: ensure the box holds a clone of the run's origin and
	 * return the BOX path. Defaults to ssh + git (`./materialize.ts`).
	 */
	readonly materialize?: (box: FleetBoxRuntime, spec: RunSpec) => Promise<string>;
}

export class FleetProvider implements RuntimeProvider {
	/** Every box is a burrow box, so the reference backend's capabilities hold. */
	readonly capabilities: RuntimeCapabilities = LOCAL_PROVIDER_CAPABILITIES;

	private readonly byId: Map<string, FleetBoxRuntime>;
	private readonly health: FleetHealthCache;
	/** boxId → runId → projectId. Placement's per-project count, and nothing else. */
	private readonly placementLedger = new Map<string, Map<string, string | undefined>>();

	constructor(private readonly deps: FleetProviderDeps) {
		this.boxes = deps.boxes;
		this.byId = new Map(deps.boxes.map((box) => [box.id, box]));
		const probe: { timeoutMs?: number; log?: FleetLogger; ttlMs?: number; now?: () => number } = {};
		if (deps.probeTimeoutMs !== undefined) probe.timeoutMs = deps.probeTimeoutMs;
		if (deps.log !== undefined) probe.log = deps.log;
		if (deps.healthTtlMs !== undefined) probe.ttlMs = deps.healthTtlMs;
		if (deps.now !== undefined) probe.now = deps.now;
		this.health = new FleetHealthCache(deps.boxes, probe);
	}

	/** The boxes this provider knows, for status surfaces and tests. */
	readonly boxes: readonly FleetBoxRuntime[];

	get boxIds(): readonly string[] {
		return [...this.byId.keys()];
	}

	async create(spec: RunSpec): Promise<RunHandle> {
		const health =
			this.deps.probe !== undefined ? await this.deps.probe() : await this.health.read();
		const boxId = chooseBox(this.candidates(health, spec.projectId), this.deps.placement ?? {});
		if (boxId === null) {
			const detail = [...health.values()]
				.map((entry) => `${entry.id}: ${entry.detail ?? `live=${entry.live}`}`)
				.join("; ");
			throw new FleetUnavailableError(`fleet: no box can take run ${spec.runId}`, {
				recoveryHint: `every box is unhealthy or at its limit — ${detail || "no boxes configured"}`,
			});
		}
		const box = this.boxById(boxId);
		// burrow cuts a worktree off a clone that must already exist ON THE BOX, so
		// the box-side path replaces whatever host path the domain supplied.
		const hostClonePathHint = await this.materialize(box, spec);
		const inner = await box.provider.create({ ...spec, hostClonePathHint });
		this.track(boxId, spec.runId, spec.projectId);
		return {
			runId: inner.runId,
			sandboxId: inner.sandboxId,
			providerRunId: encodeProviderRunId(boxId, inner.providerRunId),
		};
	}

	async *streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent> {
		// A generator, so a routing failure surfaces on iteration — the stream
		// contract — instead of throwing from the call that obtains the iterable.
		const route = this.route(handle);
		yield* route.box.provider.streamEvents(route.handle, opts);
	}

	async status(handle: RunHandle): Promise<RunStatus> {
		const route = this.route(handle);
		return await route.box.provider.status(route.handle);
	}

	async sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message> {
		const route = this.route(handle);
		return await route.box.provider.sendMessage(route.handle, msg);
	}

	async cancel(handle: RunHandle, reason?: string): Promise<void> {
		const route = this.route(handle);
		return await route.box.provider.cancel(route.handle, reason);
	}

	async workspaceInfo(handle: RunHandle): Promise<WorkspaceInfo> {
		// The box's path, which is exactly what its ssh-backed reap seams need.
		const route = this.route(handle);
		return await route.box.provider.workspaceInfo(route.handle);
	}

	async finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult> {
		const route = this.route(handle);
		return await route.box.provider.finalize(route.handle, intent);
	}

	async terminate(handle: RunHandle): Promise<TeardownResult> {
		const route = this.route(handle);
		const result = await route.box.provider.terminate(route.handle);
		this.placementLedger.get(route.box.id)?.delete(handle.runId);
		return result;
	}

	/**
	 * Placement input: health per box, plus how many of THIS project's runs each
	 * box already carries. A run whose box is unknown (a handle from a box that
	 * left the config) counts nowhere — placement must not be blocked by it.
	 *
	 * The load figure is `max(probe, in-flight)`. Health arrives through a short
	 * cache, so a burst of dispatches inside that window would all read the same
	 * number and stack on one box; the provider's own ledger is never stale. It
	 * is `max` and not a sum because the probe already counts the burrows this
	 * provider created, and a sum would push placement away from a free box.
	 */
	private candidates(
		health: Map<string, BoxHealth>,
		projectId: string | undefined,
	): BoxCandidateInput[] {
		const candidates: BoxCandidateInput[] = [];
		for (const box of this.boxes) {
			const entry = health.get(box.id);
			candidates.push({
				id: box.id,
				healthy: entry?.healthy ?? false,
				live: Math.max(entry?.live ?? 0, this.placementLedger.get(box.id)?.size ?? 0),
				projectLive: this.projectLive(box.id, projectId),
			});
		}
		return candidates;
	}

	private projectLive(boxId: string, projectId: string | undefined): number {
		if (projectId === undefined) return 0;
		const ledger = this.placementLedger.get(boxId);
		if (ledger === undefined) return 0;
		let count = 0;
		for (const value of ledger.values()) {
			if (value === projectId) count += 1;
		}
		return count;
	}

	private track(boxId: string, runId: string, projectId: string | undefined): void {
		let ledger = this.placementLedger.get(boxId);
		if (ledger === undefined) {
			ledger = new Map();
			this.placementLedger.set(boxId, ledger);
		}
		ledger.set(runId, projectId);
	}

	/** The box with this id, or a loud error — never a silent wrong box. */
	private boxById(boxId: string): FleetBoxRuntime {
		const box = this.byId.get(boxId);
		if (box === undefined) throw new FleetUnknownBoxError(boxId);
		return box;
	}

	/**
	 * Ensure the project clone exists on the box and return the box path burrow
	 * must cut its worktree from. Injectable so placement/routing tests stay
	 * hermetic; the default is the ssh + git implementation.
	 */
	private async materialize(box: FleetBoxRuntime, spec: RunSpec): Promise<string> {
		if (this.deps.materialize !== undefined) return await this.deps.materialize(box, spec);
		return await ensureProjectClone(
			{
				ssh: box.ssh,
				env: this.deps.env ?? {},
				...(this.deps.log !== undefined ? { log: this.deps.log } : {}),
			},
			{ originUrl: spec.originUrl, baseBranch: spec.baseBranch },
		);
	}

	/**
	 * Resolve a handle to (box, inner handle). The inner handle carries the id
	 * that box's own provider minted: burrow must receive the raw `burrowRunId`,
	 * never the box-encoded form this provider hands the domain.
	 */
	private route(handle: RunHandle): { box: FleetBoxRuntime; handle: RunHandle } {
		const decoded = decodeProviderRunId(handle.providerRunId);
		if (decoded === null) throw new FleetUnknownBoxError(handle.providerRunId);
		const box = this.byId.get(decoded.boxId);
		if (box === undefined) throw new FleetUnknownBoxError(decoded.boxId);
		return { box, handle: { ...handle, providerRunId: decoded.innerRunId } };
	}
}

type BoxCandidateInput = Parameters<typeof chooseBox>[0][number];
