/**
 * Path + endpoint resolution for warren's supervised OpenRig coordination
 * kernel (`src/kernel/`).
 *
 * The "kernel" is the vendored OpenRig daemon (`vendor/openrig/`, upstream
 * github.com/mvschwarz/openrig @ fd097bfdfa) run as a child process warren
 * owns — see `./spawn.ts` for the process seam and `./status.ts` for the
 * lifecycle verbs.
 *
 * ISOLATION (this is the reason the module exists at all). Booting that
 * daemon is NOT side-effect-free against a shared `$HOME`: it writes skill
 * trees into `$HOME/.claude/skills` and `$HOME/.agents/skills`, rewrites
 * `$HOME/.codex/config.toml`, and drops `.claude.json` / `.claude/backups`
 * in there too — observed by booting the daemon against a scratch HOME (the
 * smoke evidence is in this module's hand-off report). So warren never boots
 * the kernel against the operator's HOME. Every kernel child gets BOTH:
 *
 *   - `OPENRIG_HOME` = `<kernel home>`, default `<WARREN_DATA_DIR>/kernel`
 *     — never upstream's `~/.openrig`, so kernel state cannot collide with a
 *     human's own OpenRig install; and
 *   - `HOME` = `<kernel home>/home` (`KernelPaths.privateHome`) — so the
 *     daemon's writes to `~/.claude`, `~/.agents` and `~/.codex` land inside
 *     the kernel home, not in the operator's dotfiles.
 *
 * Both directories are created 0700 on first start (`./spawn.ts`).
 *
 * Endpoint defaults are the kernel-private ones too: loopback bind on the
 * daemon's own default port. `OPENRIG_BIND_HOST` / `OPENRIG_PORT` are honoured
 * verbatim because the child daemon reads exactly those variables
 * (`vendor/openrig/packages/daemon/src/index.ts:277,247`).
 */

import { join } from "node:path";

/** Warren's data root default — mirrors `src/server/config.ts`. */
export const DEFAULT_DATA_DIR = "/data";

/** Directory under the warren data root that holds all kernel state. */
export const DEFAULT_KERNEL_DIRNAME = "kernel";

/** Loopback by default: the kernel is warren's private dependency. */
export const DEFAULT_KERNEL_HOST = "127.0.0.1";

/** The OpenRig daemon's own default port (`.../daemon/src/index.ts:247`). */
export const DEFAULT_KERNEL_PORT = 7433;

/** 0600 bearer token file; its content becomes `OPENRIG_AUTH_BEARER_TOKEN`. */
export const KERNEL_TOKEN_FILENAME = "kernel-token";

/** stdout + stderr sink for the kernel child. */
export const KERNEL_LOG_FILENAME = "kernel.log";

/** 0600 JSON record so `status` / `stop` work across CLI invocations. */
export const KERNEL_PID_FILENAME = "kernel.pid";

/** Kernel-private `$HOME` (see the isolation note in the module header). */
export const KERNEL_PRIVATE_HOME_DIRNAME = "home";

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * `env[key]` unless it is unset or the empty string. An empty env var means
 * "not configured" everywhere in warren; an explicit `undefined` is what
 * `./spawn.ts` uses to scrub an inherited variable from the child env.
 */
export function nonEmpty(value: string | undefined): string | null {
	if (value === undefined || value === "") return null;
	return value;
}

/**
 * Raised for kernel misconfiguration or a failed lifecycle step. Carries a
 * `detail` for the status surface so an operator sees the raw cause.
 */
export class KernelError extends Error {
	constructor(
		message: string,
		readonly detail?: string,
	) {
		super(message);
		this.name = "KernelError";
	}
}

export interface KernelPaths {
	/** `OPENRIG_HOME` for the kernel child — the isolated kernel state root. */
	readonly home: string;
	/** Base URL of the kernel's HTTP surface (loopback by default). */
	readonly url: string;
	/** 0600 file whose content is handed to the child (and to `kernelClient`). */
	readonly tokenFile: string;
	/** stdout+stderr sink for the kernel child. */
	readonly logFile: string;
	/** 0600 record of the child warren spawned, with the entry it was started from. */
	readonly pidFile: string;
	/** Kernel-private `$HOME`; see the isolation note above. */
	readonly privateHome: string;
	/** Bind host passed to the child as `OPENRIG_BIND_HOST`. */
	readonly host: string;
	/** Port passed to the child as `OPENRIG_PORT`. */
	readonly port: number;
}

/**
 * The warren data root: `WARREN_DATA_DIR` (default `/data`, matching
 * `src/server/config.ts` and the `/data` volume in `docker-compose.yml`).
 */
export function kernelDataDir(env: EnvLike): string {
	return nonEmpty(env.WARREN_DATA_DIR) ?? DEFAULT_DATA_DIR;
}

/**
 * Resolve every path the kernel lifecycle needs. Pure: no directory is
 * created here (that is `./spawn.ts`'s job), so this is cheap to call from
 * `status` on a box where the kernel was never started.
 */
export function kernelPaths(env: EnvLike): KernelPaths {
	const home = nonEmpty(env.OPENRIG_HOME) ?? join(kernelDataDir(env), DEFAULT_KERNEL_DIRNAME);
	const host = nonEmpty(env.OPENRIG_BIND_HOST) ?? DEFAULT_KERNEL_HOST;
	const rawPort = nonEmpty(env.OPENRIG_PORT);
	const port = rawPort === null ? DEFAULT_KERNEL_PORT : parseKernelPort(rawPort);
	// A wildcard bind is not a dialable address, so probes dial the matching
	// loopback address; an IPv6 literal needs brackets or the URL will not parse.
	const dialHost =
		host === "0.0.0.0" ? "127.0.0.1" : host === "::" || host === "::0" ? "::1" : host;
	const formatted =
		dialHost.includes(":") && !dialHost.startsWith("[") ? `[${dialHost}]` : dialHost;
	return {
		home,
		url: `http://${formatted}:${port}`,
		tokenFile: join(home, KERNEL_TOKEN_FILENAME),
		logFile: join(home, KERNEL_LOG_FILENAME),
		pidFile: join(home, KERNEL_PID_FILENAME),
		privateHome: join(home, KERNEL_PRIVATE_HOME_DIRNAME),
		host,
		port,
	};
}

function parseKernelPort(raw: string): number {
	const port = Number.parseInt(raw, 10);
	if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== raw.trim()) {
		throw new KernelError(`OPENRIG_PORT must be an integer 1..65535 (got ${JSON.stringify(raw)})`);
	}
	return port;
}
