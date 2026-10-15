/**
 * `warren fleet <status|dispatch>` — the operator surface for the remote
 * execution lane (ubuntu-cf02).
 *
 * `status` answers "can warren place work, and who is busy" without making
 * anything happen: it probes every configured box's burrow and prints its state
 * and load. `dispatch` places ONE run on a chosen box and can wait for it to
 * finish, which is also the way to smoke the lane after a change.
 *
 * Both read the same fleet config the runtime backend reads, so what this prints
 * is exactly what a run would use — no second code path to drift.
 *
 * Exit codes: 0 ok, 1 failure (no box, dispatch failed, run failed), 3 no box is
 * reachable. A missing or unusable fleet config is a plain failure with the
 * loader's recovery hint, not a stack trace.
 */

import type { RunHandle, RunSpec } from "../../runtime/contract.ts";
import type { FleetBoxRuntime } from "../../runtime/local/fleet/index.ts";
import {
	buildFleetProvider,
	FleetConfigError,
	fleetPlacementFromEnv,
	probeBoxes,
} from "../../runtime/local/fleet/index.ts";
import type { CliContext } from "../output.ts";

export type FleetAction = "status" | "dispatch";

export interface FleetArgs {
	readonly action: FleetAction;
	/** dispatch: the git origin to work on. */
	readonly repo?: string;
	readonly branch?: string;
	readonly baseBranch?: string;
	readonly prompt?: string;
	readonly runtime?: string;
	/** dispatch: agent provider override (pi's `--provider` vocabulary). */
	readonly provider?: string;
	/** dispatch: agent model override (pi's `--model` value). */
	readonly model?: string;
	/** dispatch: poll until the run reaches a terminal phase. */
	readonly wait?: boolean;
	readonly json?: boolean;
}

export interface FleetReport {
	readonly lines: readonly string[];
	readonly exitCode: number;
}

/** Wiring for tests: a provider plus the boxes it holds. */
export interface FleetCliDeps {
	readonly provider?: {
		readonly boxes: readonly FleetBoxRuntime[];
		create(spec: RunSpec): Promise<RunHandle>;
		status(handle: RunHandle): Promise<{ phase: string; exitCode: number | null; exists: boolean }>;
		terminate(handle: RunHandle): Promise<unknown>;
	};
	readonly env?: Record<string, string | undefined>;
	/** Poll interval + cap for `dispatch --wait`. */
	readonly pollMs?: number;
	readonly maxPolls?: number;
}

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_POLLS = 150;

export async function runFleet(
	args: FleetArgs,
	context: CliContext,
	deps: FleetCliDeps = {},
): Promise<FleetReport> {
	const env = deps.env ?? (context.env as Record<string, string | undefined>);
	let provider: NonNullable<FleetCliDeps["provider"]>;
	try {
		provider = deps.provider ?? buildFleetProvider({ env, placement: fleetPlacementFromEnv(env) });
	} catch (error) {
		if (error instanceof FleetConfigError) {
			return {
				lines: [error.message, ...(error.recoveryHint === undefined ? [] : [error.recoveryHint])],
				exitCode: 1,
			};
		}
		throw error;
	}
	if (provider.boxes.length === 0) {
		return { lines: ["fleet: no boxes configured"], exitCode: 1 };
	}
	return args.action === "status"
		? await statusReport(provider.boxes, args)
		: await dispatchReport(provider, args, deps);
}

async function statusReport(
	boxes: readonly FleetBoxRuntime[],
	args: FleetArgs,
): Promise<FleetReport> {
	const health = await probeBoxes(boxes);
	const rows = boxes.map((box) => {
		const entry = health.get(box.id);
		return {
			id: box.id,
			url: describeUrl(box),
			healthy: entry?.healthy ?? false,
			live: entry?.live ?? 0,
			detail: entry === undefined ? "not probed" : entry.detail,
		};
	});
	const up = rows.filter((row) => row.healthy).length;
	if (args.json === true) {
		return { lines: [JSON.stringify({ boxes: rows, healthy: up })], exitCode: up === 0 ? 3 : 0 };
	}
	const lines = [`fleet: ${up}/${rows.length} boxes reachable`];
	for (const row of rows) {
		const state = row.healthy ? "ok" : `down (${row.detail})`;
		lines.push(
			`${row.healthy ? " " : "!"} ${row.id.padEnd(16)} ${state} · ${row.live} live · ${row.url}`,
		);
	}
	return { lines, exitCode: up === 0 ? 3 : 0 };
}

/**
 * The spec a `fleet dispatch` sends. Extracted so the command stays simple, and
 * so the two decisions it encodes are visible in one place.
 */
function buildDispatchSpec(args: FleetArgs, repo: string, prompt: string): RunSpec {
	const spec: RunSpec = {
		runId: `fleet-${Date.now().toString(36)}`,
		originUrl: repo,
		branch: args.branch ?? "warren/fleet-run",
		baseBranch: args.baseBranch ?? "main",
		runtimeId: args.runtime ?? "pi",
		prompt,
		mode: "batch",
		// The agent calls a model gateway, so the sandbox must share the host
		// network namespace. bwrap drops the namespace on `--unshare-all`, and it
		// only adds `--share-net` for `open` or for `restricted` with a proxy
		// address. `restricted` without one is deny-all, which leaves the agent
		// unable to reach any model.
		network: "open",
		seedFiles: [],
		env: {},
	};
	if (args.provider === undefined && args.model === undefined) return spec;
	// burrow reads run metadata's frontmatter and turns it into the agent's
	// `--provider`/`--model` flags, which is how a box's own gateway is chosen.
	const frontmatter: Record<string, unknown> = { source: "builtin" };
	if (args.provider !== undefined) frontmatter.provider = args.provider;
	if (args.model !== undefined) frontmatter.model = args.model;
	return { ...spec, metadata: { frontmatter } };
}

async function dispatchReport(
	provider: NonNullable<FleetCliDeps["provider"]>,
	args: FleetArgs,
	deps: FleetCliDeps,
): Promise<FleetReport> {
	if (args.repo === undefined || args.prompt === undefined) {
		return { lines: ["fleet dispatch needs --repo and --prompt"], exitCode: 1 };
	}
	const spec = buildDispatchSpec(args, args.repo, args.prompt);
	const lines: string[] = [];
	try {
		const handle = await provider.create(spec);
		lines.push(`dispatched ${handle.runId} on ${handle.providerRunId.split("/")[0] ?? "?"}`);
		lines.push(`  sandbox ${handle.sandboxId}`);
		if (args.wait !== true) return { lines, exitCode: 0 };
		const status = await waitForTerminal(provider, handle, deps);
		lines.push(`  ${status.phase}${status.exitCode === null ? "" : ` (exit ${status.exitCode})`}`);
		await provider.terminate(handle);
		return { lines, exitCode: status.phase === "succeeded" ? 0 : 1 };
	} catch (error) {
		lines.push(`fleet dispatch failed: ${describe(error)}`);
		return { lines, exitCode: 1 };
	}
}

async function waitForTerminal(
	provider: NonNullable<FleetCliDeps["provider"]>,
	handle: RunHandle,
	deps: FleetCliDeps,
): Promise<{ phase: string; exitCode: number | null; exists: boolean }> {
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const maxPolls = deps.maxPolls ?? DEFAULT_MAX_POLLS;
	let status = await provider.status(handle);
	for (let i = 0; i < maxPolls; i += 1) {
		if (isTerminal(status.phase)) return status;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
		status = await provider.status(handle);
	}
	return status;
}

function isTerminal(phase: string): boolean {
	return phase === "succeeded" || phase === "failed" || phase === "cancelled";
}

/** `http://host:port` for the box, rendered from its burrow transport. */
function describeUrl(box: FleetBoxRuntime): string {
	const transport = box.client.config.transport;
	return transport.kind === "tcp" ? `http://${transport.hostname}:${transport.port}` : "unix";
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
