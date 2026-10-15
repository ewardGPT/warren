/**
 * The `fleet` backend's entry point: build the provider the registry hands the
 * domain when `WARREN_RUNTIME=fleet`.
 *
 * Composition, per box, is deliberately the SAME object graph the self-host
 * backend uses — a `LocalProvider` over a burrow client — with three things
 * swapped for the fact that the box is not this host:
 *
 *   1. the burrow client's transport is TCP to that box's tailnet address, with
 *      that box's token;
 *   2. `fs`/`exec` for the reap half are ssh-backed, so `finalize()` commits and
 *      pushes from the box that holds the commits;
 *   3. the callback URL comes from `WARREN_CALLBACK_URL` (see
 *      `../../runs/spawn/callback-env.ts`), because a box cannot reach this
 *      host's loopback.
 *
 * Everything else — sandbox profile, event stream mapping, status table,
 * steering, teardown — is the existing local implementation, untouched. That is
 * the whole point: a fleet box is a burrow host that happens to be far away.
 *
 * Boot-time failure is intentional. A fleet with no usable box throws
 * `FleetConfigError` instead of booting into a state where every dispatch fails.
 */

import { BurrowClient } from "../../../burrow-client/index.ts";
import type { EnvLike } from "../../../runs/spawn/callback-env.ts";
import { LocalProvider } from "../provider.ts";
import { type FleetEndpoint, fleetPlacementLogPath, loadFleetEndpoints } from "./config.ts";
import type { FleetBoxRuntime, FleetLogger } from "./health.ts";
import type { PlacementOptions } from "./placement.ts";
import { PlacementLog } from "./placement-log.ts";
import { FleetProvider } from "./provider.ts";
import { createRemoteReapExec, createRemoteReapFs } from "./remote-seams.ts";
import { createSshRunner } from "./ssh-runner.ts";

export const DEFAULT_FLEET_SSH_USER = "ubuntu";

export interface BuildFleetOptions {
	readonly env: EnvLike;
	readonly log?: FleetLogger;
	/** Injected by tests; defaults to reading the token files off disk. */
	readonly load?: (env: EnvLike) => {
		endpoints: readonly FleetEndpoint[];
		invalid: readonly { id: string; reason: string }[];
	};
	readonly placement?: PlacementOptions;
	readonly healthTtlMs?: number;
	readonly probeTimeoutMs?: number;
}

/** `user@host` for a box: tailnet hostname from its url, user from env. */
export function fleetSshTarget(endpoint: FleetEndpoint, env: EnvLike): string {
	const user = env.WARREN_FLEET_SSH_USER ?? DEFAULT_FLEET_SSH_USER;
	const hostname = endpoint.transport.kind === "tcp" ? endpoint.transport.hostname : "localhost";
	return `${user}@${hostname}`;
}

export function buildFleetProvider(options: BuildFleetOptions): FleetProvider {
	const env = options.env;
	const loaded = options.load !== undefined ? options.load(env) : loadFleetEndpoints({ env });
	for (const rejected of loaded.invalid) {
		options.log?.warn({ box: rejected.id, reason: rejected.reason }, "fleet: box skipped");
	}
	const boxes: FleetBoxRuntime[] = loaded.endpoints.map((endpoint) => boxRuntime(endpoint, env));
	return new FleetProvider({
		boxes,
		env: env as Record<string, string | undefined>,
		placementLog: new PlacementLog({ path: fleetPlacementLogPath(env) }),
		...(options.placement !== undefined ? { placement: options.placement } : {}),
		...(options.healthTtlMs !== undefined ? { healthTtlMs: options.healthTtlMs } : {}),
		...(options.probeTimeoutMs !== undefined ? { probeTimeoutMs: options.probeTimeoutMs } : {}),
		...(options.log !== undefined ? { log: options.log } : {}),
	});
}

function boxRuntime(endpoint: FleetEndpoint, env: EnvLike): FleetBoxRuntime {
	const client = new BurrowClient({
		config: { transport: endpoint.transport, token: endpoint.token },
	});
	const ssh = createSshRunner({ target: fleetSshTarget(endpoint, env) });
	return {
		id: endpoint.id,
		client,
		ssh,
		provider: new LocalProvider({
			burrowClient: () => client,
			serverEnv: env,
			fs: createRemoteReapFs(ssh),
			exec: createRemoteReapExec(ssh),
		}),
	};
}

/** Placement limits from env, when set. Absent = no limit. */
export function fleetPlacementFromEnv(env: EnvLike): PlacementOptions {
	const placement: { boxLimit?: number; projectLimit?: number } = {};
	const boxLimit = positiveInt(env.WARREN_FLEET_BOX_LIMIT);
	if (boxLimit !== undefined) placement.boxLimit = boxLimit;
	const projectLimit = positiveInt(env.WARREN_FLEET_PROJECT_LIMIT);
	if (projectLimit !== undefined) placement.projectLimit = projectLimit;
	return placement;
}

function positiveInt(raw: string | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

export {
	FLEET_CONFIG_FILENAME,
	type FleetBox,
	type FleetEndpoint,
	fleetConfigPath,
	fleetPlacementLogPath,
	parseBurrowUrl,
	parseFleetConfig,
} from "./config.ts";
export { FleetConfigError, FleetUnavailableError, FleetUnknownBoxError } from "./errors.ts";
export { decodeProviderRunId, encodeProviderRunId } from "./handle.ts";
export type { BoxHealth, FleetBoxRuntime, FleetLogger } from "./health.ts";
export { DEFAULT_HEALTH_TTL_MS, FleetHealthCache, probeBoxes } from "./health.ts";
export { type BoxCandidate, chooseBox, type PlacementOptions } from "./placement.ts";
export { FleetProvider } from "./provider.ts";
export {
	createRemoteReapExec,
	createRemoteReapFs,
	type SshRunner,
	type SshRunOptions,
	type SshRunResult,
	shellCommand,
	shellQuote,
} from "./remote-seams.ts";
export { createSshRunner, DEFAULT_SSH_TIMEOUT_MS } from "./ssh-runner.ts";
