/**
 * The kernel process + kernel-home state seams.
 *
 * This file owns everything that touches the kernel's home directory and the
 * child process itself:
 *
 *   - the 0600 bearer token (`ensureKernelToken`), generated once and reused;
 *   - the child env (`kernelChildEnv`): the isolated `OPENRIG_HOME` + private
 *     `HOME` from `./paths.ts`, the kernel's bind endpoint, and the token the
 *     daemon expects as `OPENRIG_AUTH_BEARER_TOKEN`
 *     (`vendor/openrig/packages/daemon/src/index.ts:290`);
 *   - the spawn itself, with the child's stdout+stderr appended to
 *     `KernelPaths.logFile`;
 *   - the PID record (`{pid, entry, startedAt}`) written to
 *     `KernelPaths.pidFile`, which is what lets `status` and `stop` in a
 *     *later* CLI invocation find the kernel — and what `./status.ts` validates
 *     against the live process command line before signalling anything.
 *
 * Every seam is injectable (`KernelFs`, `SpawnProcessFn`, `KernelProcessDeps`)
 * so tests never start a real process or touch the real filesystem.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { KernelEntry } from "./entry.ts";
import { type EnvLike, KernelError, type KernelPaths } from "./paths.ts";

/** Bytes of entropy behind the bearer token (32 bytes → 64 hex chars). */
export const KERNEL_TOKEN_BYTES = 32;

/** Read size for the startup-failure log tail. */
export const KERNEL_LOG_TAIL_BYTES = 4_000;

/** Modes re-asserted after every write: kernel state is owner-only. */
export const KERNEL_DIR_MODE = 0o700;
export const KERNEL_FILE_MODE = 0o600;

export interface KernelFs {
	/** File content, or `null` when the file is missing/unreadable. */
	readFile(path: string): Promise<string | null>;
	writeFile(path: string, content: string, mode: number): Promise<void>;
	mkdir(path: string, mode: number): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	/** Remove if present; never throws for a missing path. */
	remove(path: string): Promise<void>;
	/** Existence check, also used for entry/PATH vetting — so NOT the exec bit. */
	exists(path: string): boolean;
	realpath(path: string): string | null;
	/** Open a file for append, returning a raw fd the child can own as stdio. */
	openAppend(path: string, mode: number): number;
	close(fd: number): void;
	/** Last `maxBytes` of a file as UTF-8 ("" when missing/empty). */
	readTail(path: string, maxBytes: number): string;
}

/** Terminal state of a kernel child. `exited` never rejects: spawn failures land in `error`. */
export interface KernelExit {
	readonly code: number | null;
	readonly signal: string | null;
	readonly error?: string;
}

export interface KernelChild {
	readonly pid: number | undefined;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
	readonly exited: Promise<KernelExit>;
}

export interface SpawnProcessInput {
	readonly argv: readonly string[];
	readonly env: Record<string, string>;
	readonly cwd: string;
	/** Append-mode fd the child's stdout+stderr are wired to; closed by the caller. */
	readonly logFd: number;
}

export type SpawnProcessFn = (input: SpawnProcessInput) => KernelChild;

export interface KernelProcessDeps {
	readonly fs: KernelFs;
	readonly spawn: SpawnProcessFn;
	/** Signal a PID — `0` probes liveness without delivering anything. */
	readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL" | 0) => void;
	/** The PID's command line, or `null` when it cannot be read / the PID is gone. */
	readonly readCmdline: (pid: number) => Promise<string | null>;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	/**
	 * Run `fn` after `ms`, returning a canceller — calling it before the timer
	 * fires prevents the call. One seam instead of a setTimeout/clearTimeout
	 * pair keeps the opaque timer handle out of every signature.
	 */
	readonly schedule: (fn: () => void, ms: number) => () => void;
	readonly randomBytes: (size: number) => Uint8Array;
}

/** What `KernelPaths.pidFile` holds — enough to prove ownership before signalling. */
export interface KernelPidRecord {
	readonly pid: number;
	/** The daemon entry the child was started from; checked against its cmdline. */
	readonly entry: string;
	readonly startedAt: string;
}

export interface SpawnKernelInput {
	readonly paths: KernelPaths;
	readonly entry: KernelEntry;
	readonly token: string;
	readonly env: EnvLike;
	readonly deps: KernelProcessDeps;
}

/**
 * The child env. Starts from the caller's env (PATH so the daemon can find
 * `claude`/`codex`/`git`, plus whatever else the operator configured), then
 * pins the kernel-private values and drops upstream's legacy `RIGGED_*`
 * aliases — an inherited `RIGGED_HOME`/`RIGGED_DB`/`RIGGED_PORT` must never be
 * able to redirect the kernel's state root, database or endpoint.
 */
export function kernelChildEnv(input: SpawnKernelInput): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(input.env)) {
		if (value !== undefined && !key.startsWith("RIGGED_")) out[key] = value;
	}
	out.OPENRIG_HOME = input.paths.home;
	out.HOME = input.paths.privateHome;
	out.OPENRIG_BIND_HOST = input.paths.host;
	out.OPENRIG_PORT = String(input.paths.port);
	// The daemon's bearer-token env: `.../daemon/src/index.ts:290` reads
	// OPENRIG_AUTH_BEARER_TOKEN for Mission Control write verbs.
	out.OPENRIG_AUTH_BEARER_TOKEN = input.token;
	return out;
}

/**
 * The kernel's bearer token, generated once (32 random bytes, hex) and reused
 * afterwards. Always left 0600 — the file is re-chmodded on reuse so a token
 * written under a looser umask cannot stay world-readable.
 */
export async function ensureKernelToken(
	paths: KernelPaths,
	deps: KernelProcessDeps,
): Promise<string> {
	await deps.fs.mkdir(paths.home, KERNEL_DIR_MODE);
	const existing = (await deps.fs.readFile(paths.tokenFile))?.trim();
	if (existing !== undefined && existing !== "") {
		await deps.fs.chmod(paths.tokenFile, KERNEL_FILE_MODE);
		return existing;
	}
	const token = Buffer.from(deps.randomBytes(KERNEL_TOKEN_BYTES)).toString("hex");
	await deps.fs.writeFile(paths.tokenFile, `${token}\n`, KERNEL_FILE_MODE);
	await deps.fs.chmod(paths.tokenFile, KERNEL_FILE_MODE);
	return token;
}

/**
 * Spawn the kernel daemon and record its PID. Throws `KernelError` if the
 * spawn yields no PID — a child warren cannot name is a child warren cannot
 * supervise.
 */
export async function spawnKernel(input: SpawnKernelInput): Promise<KernelChild> {
	const { paths, entry, deps } = input;
	await deps.fs.mkdir(paths.home, KERNEL_DIR_MODE);
	await deps.fs.mkdir(paths.privateHome, KERNEL_DIR_MODE);
	const logFd = deps.fs.openAppend(paths.logFile, KERNEL_FILE_MODE);
	let child: KernelChild;
	try {
		child = deps.spawn({
			argv: entry.argv,
			env: kernelChildEnv(input),
			cwd: paths.home,
			logFd,
		});
	} finally {
		deps.fs.close(logFd);
	}
	if (child.pid === undefined || child.pid <= 0) {
		throw new KernelError(`kernel spawn returned no PID (${entry.argv.join(" ")})`);
	}
	await writePidRecord(
		paths,
		{ pid: child.pid, entry: entry.entry, startedAt: new Date(deps.now()).toISOString() },
		deps,
	);
	return child;
}

/** The PID record, or `null` when absent/garbage (a stale file is not an error). */
export async function readPidRecord(
	paths: KernelPaths,
	deps: KernelProcessDeps,
): Promise<KernelPidRecord | null> {
	const raw = await deps.fs.readFile(paths.pidFile);
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<KernelPidRecord>;
		if (
			typeof parsed.pid !== "number" ||
			!Number.isSafeInteger(parsed.pid) ||
			parsed.pid <= 0 ||
			typeof parsed.entry !== "string" ||
			parsed.entry === ""
		) {
			return null;
		}
		return {
			pid: parsed.pid,
			entry: parsed.entry,
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
		};
	} catch {
		return null;
	}
}

export async function writePidRecord(
	paths: KernelPaths,
	record: KernelPidRecord,
	deps: KernelProcessDeps,
): Promise<void> {
	await deps.fs.writeFile(paths.pidFile, `${JSON.stringify(record)}\n`, KERNEL_FILE_MODE);
}

export async function clearPidRecord(paths: KernelPaths, deps: KernelProcessDeps): Promise<void> {
	await deps.fs.remove(paths.pidFile);
}

/** Tail of the kernel log, for a failed-start detail. */
export function readLogTail(paths: KernelPaths, deps: KernelProcessDeps): string {
	return deps.fs.readTail(paths.logFile, KERNEL_LOG_TAIL_BYTES).trim();
}

// ---------------------------------------------------------------------------
// Production seams.

/** Real-filesystem `KernelFs`. */
export function createKernelFs(): KernelFs {
	return {
		readFile: async (path) => {
			try {
				return await readFile(path, "utf8");
			} catch {
				return null;
			}
		},
		writeFile: (path, content, mode) => writeFile(path, content, { encoding: "utf8", mode }),
		mkdir: async (path, mode) => {
			await mkdir(path, { recursive: true, mode });
		},
		chmod: (path, mode) => chmod(path, mode),
		remove: (path) => rm(path, { force: true }),
		exists: (path) => {
			try {
				accessSync(path, constants.F_OK);
				return true;
			} catch {
				return false;
			}
		},
		realpath: (path) => {
			try {
				return realpathSync(path);
			} catch {
				return null;
			}
		},
		openAppend: (path, mode) => openSync(path, "a", mode),
		close: (fd) => closeSync(fd),
		readTail: (path, maxBytes) => {
			let fd: number;
			try {
				fd = openSync(path, "r");
			} catch {
				return "";
			}
			try {
				const size = fstatSync(fd).size;
				const length = Math.min(size, maxBytes);
				if (length <= 0) return "";
				const buffer = Buffer.alloc(length);
				readSync(fd, buffer, 0, length, size - length);
				return buffer.toString("utf8");
			} catch {
				return "";
			} finally {
				closeSync(fd);
			}
		},
	};
}

/**
 * Real child process: `node:child_process` with the log fd as stdio. Exit
 * codes and signals both come out, and a spawn failure (`ENOENT`) is reported
 * through `exited` rather than thrown, so `./status.ts` can report it as a
 * failed start instead of an exception.
 */
export const defaultSpawnProcess: SpawnProcessFn = (input) => {
	const [bin, ...args] = input.argv;
	if (bin === undefined) throw new KernelError("kernel spawn argv is empty");
	const child = spawn(bin, args, {
		cwd: input.cwd,
		env: input.env,
		stdio: ["ignore", input.logFd, input.logFd],
	});
	const { promise: exited, resolve: resolveExit } = Promise.withResolvers<KernelExit>();
	child.once("error", (error) => resolveExit({ code: null, signal: null, error: error.message }));
	child.once("exit", (code, signal) => resolveExit({ code, signal }));
	return {
		pid: child.pid,
		kill: (signal) => {
			try {
				child.kill(signal);
			} catch {
				// Raced its exit — nothing left to signal.
			}
		},
		exited,
	};
};

/**
 * The PID's command line. `/proc/<pid>/cmdline` first (NUL-separated, so
 * joined with spaces for a substring check); `ps` as the fallback for
 * non-Linux hosts.
 */
export async function defaultReadCmdline(pid: number): Promise<string | null> {
	try {
		const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
		const text = raw.replace(/\0/g, " ").trim();
		if (text !== "") return text;
	} catch {
		// Not Linux, or the PID is gone/unreadable — fall through to ps.
	}
	try {
		const result = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
		const text = (result.stdout ?? "").trim();
		return text === "" ? null : text;
	} catch {
		return null;
	}
}

export function defaultSleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}
