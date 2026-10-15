/**
 * Fleet health checks: whether warren can still reach the peer kernels it
 * coordinates with (the agentic boxes), and how each one is doing.
 *
 * The registry is the kernel's OWN connection list — `hosts.yaml` under
 * `kernelPaths().home` — so this reads the same file the kernel CLI reads and
 * never invents a second source of truth. Only `transport: http` entries are
 * probed: `ssh` entries carry no HTTP surface, and their posture belongs to
 * `rig host doctor`, not to warren's readiness.
 *
 * READINESS IS NOT COUPLED TO A PEER. A peer box is not a dependency of any
 * warren request path, so a peer's outage must not make warren look unhealthy:
 * the readyz surface gets ONE aggregate line that is always `ok`, and the
 * per-host verdicts go to `warren doctor`, where an operator reads them. This
 * is the same call `burrowReadyzChecks` makes under k8s (warren-c128) — a
 * probe that is not a dependency must not degrade readiness.
 *
 * Both foreign documents (the registry, a peer's `/healthz`) are parsed ONCE at
 * the boundary with a zod schema, so a hand-edited registry or a peer running a
 * different build degrades to a dropped entry or an `unknown` field rather than
 * a throw. The bearer token never leaves this module: it is read, sent, and
 * dropped. Messages name hosts, never tokens, and the readyz line names host
 * ids only (no tailnet addresses on the wire — see `./redact.ts` for that split).
 */

import { readFile as defaultReadFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { kernelPaths } from "../kernel/paths.ts";
import type { DiagnosticCheck, DiagnosticLogger, EnvLike } from "./checks.ts";

export const FLEET_REGISTRY_FILENAME = "hosts.yaml";
export const FLEET_PROBE_TIMEOUT_MS = 2500;

/** One dialable peer kernel, as the registry describes it. */
export interface KernelFleetHost {
	readonly id: string;
	readonly url: string;
	readonly bearerFile: string | null;
}

export type ReadTextFn = (path: string) => Promise<string>;

const RegistryHostSchema = z.object({
	id: z.string().min(1),
	transport: z.string().optional(),
	url: z.string().min(1).optional(),
	bearer_file: z.string().min(1).optional(),
});
const RegistrySchema = z.object({ hosts: z.array(z.unknown()).optional() });

/**
 * The subset of `GET /healthz` this surface reports, loose on purpose: a peer
 * that is mid-upgrade may answer with a shape warren does not know yet.
 */
const PeerHealthSchema = z.object({
	status: z.string().optional(),
	semver: z.string().optional(),
	pid: z.number().optional(),
	stuckSweep: z.object({ lastOutcome: z.string().optional() }).optional(),
	eventLoop: z.object({ healthy: z.boolean().optional() }).optional(),
});

interface FleetHealth {
	readonly status: string;
	readonly semver: string | null;
	readonly sweep: string | null;
	readonly loopHealthy: boolean | null;
	readonly pid: number | null;
}

interface FleetProbe {
	readonly host: KernelFleetHost;
	readonly ok: boolean;
	readonly health: FleetHealth | null;
	/** Failure reason for the log; never placed on the wire verbatim. */
	readonly detail: string | null;
	/** Stable, wire-safe short reason for a failed probe. */
	readonly reason: string | null;
}

/**
 * Read `hosts.yaml` into the dialable hosts it lists. Pure and total: a
 * malformed document, a missing `hosts` list, a non-mapping entry or a
 * non-string field all yield a dropped entry rather than a throw, because a
 * hand-edited registry must not be able to break `warren doctor`.
 */
export function parseFleetRegistry(text: string): KernelFleetHost[] {
	const parsed = RegistrySchema.safeParse(parseYaml(text));
	if (!parsed.success) return [];
	const hosts: KernelFleetHost[] = [];
	for (const row of parsed.data.hosts ?? []) {
		const entry = RegistryHostSchema.safeParse(row);
		if (!entry.success) continue;
		const { id, transport, url, bearer_file: bearerFile } = entry.data;
		if (transport !== "http" || url === undefined) continue;
		hosts.push({ id, url: url.replace(/\/+$/, ""), bearerFile: bearerFile ?? null });
	}
	return hosts;
}

/** `GET <host>/healthz` with that host's bearer, bounded by a timeout. */
export async function probeFleetHost(
	host: KernelFleetHost,
	deps: {
		readonly fetch: typeof fetch;
		readonly readFile: ReadTextFn;
		readonly timeoutMs: number;
	},
): Promise<FleetProbe> {
	const failed = (reason: string, detail: string): FleetProbe => ({
		host,
		ok: false,
		health: null,
		reason,
		detail,
	});
	let token: string | null = null;
	if (host.bearerFile !== null) {
		try {
			token = (await deps.readFile(host.bearerFile)).trim();
		} catch (error) {
			return failed("bearer-unreadable", `${host.bearerFile}: ${describe(error)}`);
		}
		if (token === "") return failed("bearer-empty", `${host.bearerFile} is empty`);
	}
	const headers: Record<string, string> = { accept: "application/json" };
	if (token !== null) headers.authorization = `Bearer ${token}`;
	try {
		const response = await deps.fetch(`${host.url}/healthz`, {
			headers,
			signal: AbortSignal.timeout(deps.timeoutMs),
		});
		if (!response.ok) {
			return failed(
				`http-${response.status}`,
				`${host.url}/healthz answered ${response.status} ${response.statusText}`.trim(),
			);
		}
		const body: unknown = await response.json();
		return { host, ok: true, health: readHealth(body), reason: null, detail: null };
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return failed(timedOut ? "timeout" : "unreachable", describe(error));
	}
}

function readHealth(body: unknown): FleetHealth {
	const parsed = PeerHealthSchema.safeParse(body);
	if (!parsed.success) {
		return { status: "unknown", semver: null, sweep: null, loopHealthy: null, pid: null };
	}
	const health = parsed.data;
	return {
		status: health.status ?? "unknown",
		semver: health.semver ?? null,
		sweep: health.stuckSweep?.lastOutcome ?? null,
		loopHealthy: health.eventLoop?.healthy ?? null,
		pid: health.pid ?? null,
	};
}

function describe(error: unknown): string {
	if (error instanceof Error) {
		const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
		return `${error.message}${cause}`;
	}
	return String(error);
}

/**
 * `0.6.10 · sweep clean · loop ok · pid 173114` for a healthy peer, and
 * `status degraded · …` for one that answers with a non-ok status, so a
 * degraded box is visible in the line and not only in the exit code.
 */
function healthSummary(health: FleetHealth): string {
	const parts = [
		health.status === "ok" ? (health.semver ?? health.status) : `status ${health.status}`,
	];
	if (health.sweep !== null) parts.push(`sweep ${health.sweep}`);
	if (health.loopHealthy !== null) parts.push(health.loopHealthy ? "loop ok" : "loop lagging");
	if (health.pid !== null) parts.push(`pid ${health.pid}`);
	return parts.join(" · ");
}

export interface KernelFleetDeps {
	readonly env: EnvLike;
	/**
	 * `doctor` reports one check per host, with the host's address and the real
	 * verdict. `readyz` reports one aggregate line that is always `ok`, because
	 * a peer outage is not warren's unavailability (warren-c128 precedent).
	 */
	readonly mode: "doctor" | "readyz";
	readonly readFile?: ReadTextFn;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	readonly log?: DiagnosticLogger;
}

/** Where the kernel registry lives — `$OPENRIG_HOME`, else `$WARREN_DATA_DIR/kernel`. */
export function fleetRegistryPath(env: EnvLike): string {
	return join(kernelPaths(env).home, FLEET_REGISTRY_FILENAME);
}

/** One informational line, so `doctor` explains the absence instead of staying silent. */
function unconfigured(
	mode: "doctor" | "readyz",
	registryPath: string,
	why: string,
): DiagnosticCheck[] {
	if (mode === "readyz") return [];
	return [
		{
			name: "kernel-fleet",
			ok: true,
			message: `no peer kernels reported: ${why}`,
			hint: `register one with the kernel CLI, or set OPENRIG_HOME (looked at ${registryPath})`,
		},
	];
}

export async function kernelFleetChecks(deps: KernelFleetDeps): Promise<DiagnosticCheck[]> {
	const registryPath = fleetRegistryPath(deps.env);
	const readFile = deps.readFile ?? ((path: string) => defaultReadFile(path, "utf8"));
	let text: string;
	try {
		text = await readFile(registryPath);
	} catch (error) {
		return unconfigured(
			deps.mode,
			registryPath,
			`no registry at ${registryPath} (${describe(error)})`,
		);
	}
	let hosts: KernelFleetHost[];
	try {
		hosts = parseFleetRegistry(text);
	} catch (error) {
		return unconfigured(
			deps.mode,
			registryPath,
			`${registryPath} does not parse (${describe(error)})`,
		);
	}
	if (hosts.length === 0) {
		return unconfigured(deps.mode, registryPath, `${registryPath} lists no http hosts`);
	}

	const probes = await Promise.all(
		hosts.map((host) =>
			probeFleetHost(host, {
				fetch: deps.fetch ?? fetch,
				readFile,
				timeoutMs: deps.timeoutMs ?? FLEET_PROBE_TIMEOUT_MS,
			}),
		),
	);
	for (const probe of probes) {
		if (!probe.ok) {
			deps.log?.warn(
				{ host: probe.host.id, url: probe.host.url, reason: probe.reason },
				`kernel fleet probe failed: ${probe.detail ?? "unknown"}`,
			);
		}
	}
	const down = probes.filter((probe) => !probe.ok);
	if (deps.mode === "readyz") {
		const summary =
			down.length === 0
				? `${probes.length}/${probes.length} reachable`
				: `${probes.length - down.length}/${probes.length} reachable (${down
						.map((probe) => probe.host.id)
						.join(", ")} down)`;
		return [
			{
				name: "kernel-fleet",
				// Always ok: a peer is not a dependency of warren's own readiness.
				ok: true,
				message: summary,
				...(down.length === 0
					? {}
					: {
							hint: "a peer outage never fails this endpoint; `warren doctor` reports each host",
						}),
			},
		];
	}
	return probes.map((probe) => {
		if (!probe.ok || probe.health === null) {
			return {
				name: `kernel:${probe.host.id}`,
				ok: false,
				message: `${probe.host.url} unreachable (${probe.reason ?? "unknown"})`,
				hint: "check the box's openrig-kernel.service and the tailnet route to it",
			};
		}
		return {
			name: `kernel:${probe.host.id}`,
			ok: probe.health.status === "ok",
			message: `${probe.host.url} ${healthSummary(probe.health)}`,
		};
	});
}
