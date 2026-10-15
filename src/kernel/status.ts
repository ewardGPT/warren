/**
 * Kernel lifecycle: `status` / `start` / `stop` for the OpenRig daemon warren
 * supervises as a child process.
 *
 * Three properties this module is built around:
 *
 *  1. **Never hang.** Every `/healthz` probe is bounded, and readiness is a
 *     bounded poll (20s / 250ms by default). A kernel that never answers ends
 *     as `unhealthy` carrying the last probe error — not as a hung caller.
 *  2. **Never signal a PID warren cannot prove is its kernel child.** The PID
 *     record `./spawn.ts` writes is validated against the live process command
 *     line (it must name the entry the child was started from) before any
 *     SIGTERM/SIGKILL. A recycled PID is dropped, not killed.
 *  3. **Idempotent start.** A kernel that is already `running`, `starting` or
 *     `unhealthy` with a live owned child is never joined by a second child.
 *
 * The clock, sleep, spawn, fetch, signal and filesystem are all injected
 * (`KernelDeps`), so the whole lifecycle is testable without a real daemon.
 */

import { productionKernelDeps } from "./deps.ts";
import { type KernelEntry, pathFinder, resolveKernelEntry } from "./entry.ts";
import { type EnvLike, KernelError, type KernelPaths, kernelPaths } from "./paths.ts";
import {
	clearPidRecord,
	ensureKernelToken,
	type KernelChild,
	type KernelExit,
	type KernelPidRecord,
	type KernelProcessDeps,
	readLogTail,
	readPidRecord,
	spawnKernel,
} from "./spawn.ts";

export type KernelState = "stopped" | "starting" | "running" | "unhealthy" | "failed";

export type KernelStatus = {
	state: KernelState;
	pid?: number;
	url: string;
	home: string;
	version?: string;
	commit?: string;
	since?: string;
	detail?: string;
	entry?: string;
};

/** Everything the lifecycle touches, external to the module. */
export interface KernelDeps extends KernelProcessDeps {
	/** The healthz probe seam: a call signature, not `typeof fetch`, so a test
	 * double does not have to implement Bun’s `preconnect`. */
	readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface KernelOptions {
	/** Per-request `/healthz` timeout. */
	readonly healthTimeoutMs?: number;
	/** How long `start` waits for the first healthy `/healthz` answer. */
	readonly readinessTimeoutMs?: number;
	readonly readinessIntervalMs?: number;
	/** SIGTERM grace before `stop` escalates to SIGKILL. */
	readonly stopGraceMs?: number;
	readonly stopPollIntervalMs?: number;
	/** How long `stop` waits for a SIGKILLed child to disappear. */
	readonly killWaitMs?: number;
}

export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
export const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
export const DEFAULT_READINESS_INTERVAL_MS = 250;
export const DEFAULT_STOP_GRACE_MS = 10_000;
export const DEFAULT_STOP_POLL_INTERVAL_MS = 200;
export const DEFAULT_KILL_WAIT_MS = 2_000;

interface ResolvedKernelOptions {
	readonly healthTimeoutMs: number;
	readonly readinessTimeoutMs: number;
	readonly readinessIntervalMs: number;
	readonly stopGraceMs: number;
	readonly stopPollIntervalMs: number;
	readonly killWaitMs: number;
}

/** The `/healthz` fields warren consumes (`.../daemon/src/server.ts:664-720`). */
interface KernelHealthBody {
	readonly status?: string;
	readonly pid?: number;
	readonly semver?: string;
	readonly commit?: string;
}

interface KernelHealth {
	readonly ok: boolean;
	readonly body?: KernelHealthBody;
	readonly error?: string;
}

/**
 * Observe the current kernel state. Answers from `/healthz`, so it is the only
 * truthful "is it up" signal; the PID record is used for `since`/`pid` identity
 * and to tell a wedged child (`unhealthy`) from no child at all (`stopped`).
 */
export async function kernelStatus(
	env: EnvLike,
	deps: KernelDeps = productionKernelDeps(),
	opts: KernelOptions = {},
): Promise<KernelStatus> {
	const resolved = resolveKernelOptions(opts);
	const paths = kernelPaths(env);
	const entry = resolveKernelEntryOrError(env, deps);
	const base: KernelStatus = {
		state: "stopped",
		url: paths.url,
		home: paths.home,
		...(entry.kind === "ok" ? { entry: entry.entry.source } : {}),
	};
	const health = await probeHealth(deps, paths.url, resolved.healthTimeoutMs);

	if (health.ok) {
		const record = await readPidRecord(paths, deps);
		const body = health.body ?? {};
		return {
			...base,
			state: "running",
			pid: body.pid ?? record?.pid,
			version: body.semver,
			commit: body.commit,
			since: record?.startedAt,
			...(entry.kind === "error" ? { detail: entry.message } : {}),
		};
	}

	const record = await readPidRecord(paths, deps);
	if (record === null) {
		return { ...base, state: "stopped", detail: health.error };
	}
	const ownership = await inspectPid(record, deps);
	if (!ownership.alive) {
		await clearPidRecord(paths, deps);
		return {
			...base,
			state: "stopped",
			detail: `kernel child ${record.pid} is gone (dropped stale pid record): ${health.error}`,
		};
	}
	if (ownership.cmdline === null) {
		return {
			...base,
			state: "unhealthy",
			pid: record.pid,
			since: record.startedAt,
			detail: `pid ${record.pid} is alive but its command line is unreadable; warren will not signal a PID it cannot verify (${health.error})`,
		};
	}
	if (!ownership.matches) {
		await clearPidRecord(paths, deps);
		return {
			...base,
			state: "stopped",
			detail: `dropped a stale kernel pid record: pid ${record.pid} is not the kernel entry (${record.entry}); /healthz last said ${health.error}`,
		};
	}
	const startedAt = Date.parse(record.startedAt);
	const booting =
		Number.isFinite(startedAt) && deps.now() - startedAt < resolved.readinessTimeoutMs;
	return {
		...base,
		state: booting ? "starting" : "unhealthy",
		pid: record.pid,
		since: record.startedAt,
		detail: booting
			? `kernel child ${record.pid} is starting; /healthz has not answered yet: ${health.error}`
			: `kernel child ${record.pid} is alive but /healthz is not answering: ${health.error}`,
	};
}

/**
 * Start the kernel and wait for a healthy `/healthz`. Returns `running` with
 * the daemon's own version/commit, `unhealthy` (with the last probe error) if
 * readiness times out, or `failed` (with the exit code and log tail) if the
 * child dies first. An already-answering kernel is returned untouched — warren
 * never runs two kernels against one home.
 */
export async function kernelStart(
	env: EnvLike,
	deps: KernelDeps = productionKernelDeps(),
	opts: KernelOptions = {},
): Promise<KernelStatus> {
	const resolved = resolveKernelOptions(opts);
	const current = await kernelStatus(env, deps, opts);
	if (current.state !== "stopped" && current.state !== "failed") return current;

	const paths = kernelPaths(env);
	const entry = resolveKernelEntryOrError(env, deps);
	if (entry.kind === "error") {
		return {
			state: "failed",
			url: paths.url,
			home: paths.home,
			detail: [entry.message, entry.detail].filter((part) => part !== undefined).join(" — "),
		};
	}
	const base: KernelStatus = {
		state: "failed",
		url: paths.url,
		home: paths.home,
		entry: entry.entry.source,
	};

	let token: string;
	try {
		token = await ensureKernelToken(paths, deps);
	} catch (error) {
		return { ...base, detail: `kernel token could not be prepared: ${describeError(error)}` };
	}

	let child: KernelChild;
	try {
		child = await spawnKernel({ paths, entry: entry.entry, token, env, deps });
	} catch (error) {
		return { ...base, detail: `kernel spawn failed: ${describeError(error)}` };
	}

	// Track the exit without ever rejecting: a spawn error (ENOENT) is reported
	// exactly like an early exit — the start failed either way.
	const watcher: { exit: KernelExit | null } = { exit: null };
	void child.exited.then((exit) => {
		watcher.exit = exit;
	});

	const startedAt = new Date(deps.now()).toISOString();
	const running: KernelStatus = { ...base, pid: child.pid, since: startedAt };
	const deadline = deps.now() + resolved.readinessTimeoutMs;
	let lastError = "no /healthz answer yet";

	while (true) {
		if (watcher.exit !== null) {
			await clearPidRecord(paths, deps);
			return {
				...base,
				pid: child.pid,
				since: startedAt,
				detail: `kernel child ${child.pid} exited during startup (${describeExit(watcher.exit)}); log tail: ${readLogTail(paths, deps)}`,
			};
		}
		const health = await probeHealth(deps, paths.url, resolved.healthTimeoutMs);
		if (health.ok) {
			return {
				...running,
				state: "running",
				version: health.body?.semver,
				commit: health.body?.commit,
			};
		}
		lastError = health.error ?? "unknown probe failure";
		if (deps.now() >= deadline) {
			return {
				...running,
				state: "unhealthy",
				detail: `kernel did not answer /healthz within ${resolved.readinessTimeoutMs}ms: ${lastError}`,
			};
		}
		await deps.sleep(resolved.readinessIntervalMs);
	}
}

/**
 * Stop the kernel: SIGTERM, up to `stopGraceMs` (10s default) of patience, then
 * SIGKILL. Reports `stopped` whenever the kernel is not running afterwards —
 * including when there was never a kernel to stop. A PID that fails the
 * ownership check is never signalled; that case reports `stopped` with the
 * stale record dropped (or `unhealthy` when something still answers `/healthz`
 * on the kernel URL that warren does not own).
 */
export async function kernelStop(
	env: EnvLike,
	deps: KernelDeps = productionKernelDeps(),
	opts: KernelOptions = {},
): Promise<KernelStatus> {
	const resolved = resolveKernelOptions(opts);
	const paths = kernelPaths(env);
	const base: KernelStatus = { state: "stopped", url: paths.url, home: paths.home };
	const entry = resolveKernelEntryOrError(env, deps);
	if (entry.kind === "ok") base.entry = entry.entry.source;

	const record = await readPidRecord(paths, deps);
	if (record === null) return reportUnstoppable(base, paths, deps, resolved, null);

	const ownership = await inspectPid(record, deps);
	if (!ownership.alive) {
		await clearPidRecord(paths, deps);
		return { ...base, detail: `kernel child ${record.pid} had already exited; record cleared` };
	}
	if (ownership.cmdline === null) {
		return {
			...base,
			state: "unhealthy",
			pid: record.pid,
			since: record.startedAt,
			detail: `pid ${record.pid} is alive but its command line is unreadable; refusing to signal a PID warren cannot verify as its kernel child`,
		};
	}
	if (!ownership.matches) {
		await clearPidRecord(paths, deps);
		return reportUnstoppable(
			base,
			paths,
			deps,
			resolved,
			`refused to signal pid ${record.pid}: its command line is not the kernel entry (${record.entry}) — stale pid record dropped`,
		);
	}

	deps.signal(record.pid, "SIGTERM");
	if (
		!(await waitForPidExit(record.pid, resolved.stopGraceMs, resolved.stopPollIntervalMs, deps))
	) {
		await clearPidRecord(paths, deps);
		return {
			...base,
			since: record.startedAt,
			detail: `kernel child ${record.pid} exited on SIGTERM`,
		};
	}
	deps.signal(record.pid, "SIGKILL");
	const lingering = await waitForPidExit(
		record.pid,
		resolved.killWaitMs,
		resolved.stopPollIntervalMs,
		deps,
	);
	await clearPidRecord(paths, deps);
	return {
		...base,
		since: record.startedAt,
		detail: lingering
			? `kernel child ${record.pid} ignored SIGTERM for ${resolved.stopGraceMs}ms; escalated to SIGKILL (pid still visible)`
			: `kernel child ${record.pid} ignored SIGTERM for ${resolved.stopGraceMs}ms; escalated to SIGKILL`,
	};
}

/**
 * A `stop` that could not signal anything: if nothing answers `/healthz`, the
 * kernel is genuinely stopped (the `refusal` detail explains any stale record);
 * if something does answer, it is not warren's child and warren says so rather
 * than killing an unowned process.
 */
async function reportUnstoppable(
	base: KernelStatus,
	paths: KernelPaths,
	deps: KernelDeps,
	resolved: ResolvedKernelOptions,
	refusal: string | null,
): Promise<KernelStatus> {
	const health = await probeHealth(deps, paths.url, resolved.healthTimeoutMs);
	if (!health.ok) {
		return { ...base, state: "stopped", detail: refusal ?? health.error };
	}
	return {
		...base,
		state: "unhealthy",
		pid: health.body?.pid,
		detail: [
			refusal ??
				`${paths.url}/healthz is answering but no kernel pid record exists, so warren cannot prove it owns pid ${health.body?.pid ?? "?"}`,
			`refusing to signal it; stop it yourself or clear ${paths.pidFile}`,
		].join(" — "),
	};
}

/** Liveness + command-line ownership of a recorded PID. */
async function inspectPid(
	record: KernelPidRecord,
	deps: KernelDeps,
): Promise<{ alive: boolean; cmdline: string | null; matches: boolean }> {
	try {
		deps.signal(record.pid, 0);
	} catch {
		return { alive: false, cmdline: null, matches: false };
	}
	const cmdline = await deps.readCmdline(record.pid);
	return {
		alive: true,
		cmdline,
		matches: cmdline?.includes(record.entry) ?? false,
	};
}

/**
 * Poll until the PID disappears. Returns `true` when it is still alive after
 * `timeoutMs` (the caller then escalates), `false` as soon as it is gone.
 */
async function waitForPidExit(
	pid: number,
	timeoutMs: number,
	intervalMs: number,
	deps: KernelDeps,
): Promise<boolean> {
	const deadline = deps.now() + timeoutMs;
	while (deps.now() < deadline) {
		if (!pidAlive(pid, deps)) return false;
		await deps.sleep(intervalMs);
	}
	return pidAlive(pid, deps);
}

function pidAlive(pid: number, deps: KernelDeps): boolean {
	try {
		deps.signal(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function probeHealth(
	deps: KernelDeps,
	baseUrl: string,
	timeoutMs: number,
): Promise<KernelHealth> {
	const controller = new AbortController();
	let timedOut = false;
	const cancel = deps.schedule(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	try {
		const response = await deps.fetch(`${baseUrl}/healthz`, { signal: controller.signal });
		if (!response.ok) {
			return { ok: false, error: `/healthz answered HTTP ${response.status}` };
		}
		const body = (await response.json()) as KernelHealthBody;
		if (body.status !== undefined && body.status !== "ok") {
			return { ok: false, error: `/healthz reported status=${body.status}`, body };
		}
		return { ok: true, body };
	} catch (error) {
		return {
			ok: false,
			error: timedOut ? `/healthz timed out after ${timeoutMs}ms` : describeError(error),
		};
	} finally {
		cancel();
	}
}

type EntryResolution =
	| { readonly kind: "ok"; readonly entry: KernelEntry }
	| { readonly kind: "error"; readonly message: string; readonly detail?: string };

/** Entry resolution for the lifecycle verbs, which must report rather than throw. */
function resolveKernelEntryOrError(env: EnvLike, deps: KernelDeps): EntryResolution {
	try {
		return {
			kind: "ok",
			entry: resolveKernelEntry({
				env,
				exists: deps.fs.exists,
				findOnPath: pathFinder(env, deps.fs.exists),
				realpath: deps.fs.realpath,
			}),
		};
	} catch (error) {
		if (error instanceof KernelError) {
			return { kind: "error", message: error.message, detail: error.detail };
		}
		throw error;
	}
}

function resolveKernelOptions(opts: KernelOptions): ResolvedKernelOptions {
	return {
		healthTimeoutMs: opts.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
		readinessTimeoutMs: opts.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
		readinessIntervalMs: opts.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS,
		stopGraceMs: opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
		stopPollIntervalMs: opts.stopPollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS,
		killWaitMs: opts.killWaitMs ?? DEFAULT_KILL_WAIT_MS,
	};
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeExit(exit: KernelExit): string {
	const parts = [`code ${exit.code ?? "none"}`];
	if (exit.signal !== null) parts.push(`signal ${exit.signal}`);
	if (exit.error !== undefined) parts.push(exit.error);
	return parts.join(", ");
}
