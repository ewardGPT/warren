/**
 * Kernel entry resolution: WHICH OpenRig daemon program warren spawns.
 *
 * Resolution order — first hit wins, and the caller reports which one was
 * used (the resolved `KernelEntry.source` says so verbatim):
 *
 *   1. `WARREN_KERNEL_ENTRY`  — explicit operator override (an absolute path).
 *   2. the vendored build     — `<repo>/vendor/openrig/packages/daemon/dist/index.js`.
 *   3. `rig` on `PATH`        — the daemon bundled next to the resolved `rig`
 *      binary: `<cli>/daemon/dist/index.js` in an npm-install layout, or
 *      `packages/daemon/dist/index.js` in a monorepo layout. Those are the two
 *      candidates upstream's own `resolveDaemonPath` probes
 *      (`vendor/openrig/packages/cli/src/daemon-lifecycle.ts:352-363`).
 *
 * WHY THE DAEMON ENTRY, NOT `rig daemon start`: that command spawns the daemon
 * detached — `detached: true` plus `child.unref()`, then it publishes
 * `daemon.json` and exits (`.../cli/src/daemon-lifecycle.ts:685-731`). The
 * daemon is reparented out of warren's process tree, so warren could not own
 * it, watch its exit, or validate its PID against a child it spawned
 * (`./status.ts` refuses to signal a PID it cannot prove it owns). Spawning
 * the daemon entry itself keeps the kernel a real child of warren. The
 * daemon's own boot path is complete without the CLI: it reconciles state,
 * anchors its sqlite db under `OPENRIG_HOME`, and serves `/healthz` — verified
 * against a scratch home in this module's hand-off report.
 *
 * A JS entry runs under the kernel runtime (`WARREN_KERNEL_RUNTIME`, default
 * `node` — the OpenRig daemon is a Node package and warren's image installs
 * real Node, see `Dockerfile`). Any other entry is executed as-is.
 */

import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { type EnvLike, KernelError, nonEmpty } from "./paths.ts";

export const KERNEL_ENTRY_ENV = "WARREN_KERNEL_ENTRY";
export const KERNEL_RUNTIME_ENV = "WARREN_KERNEL_RUNTIME";
export const DEFAULT_KERNEL_RUNTIME = "node";

/** Vendored build entry, relative to the repo root. Optional: absent until built. */
export const VENDORED_KERNEL_ENTRY = "vendor/openrig/packages/daemon/dist/index.js";

/** The upstream CLI whose install carries the daemon in an npm layout. */
export const RIG_BINARY = "rig";

export type KernelEntryKind = "env" | "vendored" | "rig";

export interface KernelEntry {
	/** Which of the three resolution arms produced this entry. */
	readonly kind: KernelEntryKind;
	/** The daemon entry file (absolute). */
	readonly entry: string;
	/** argv to spawn: `[runtime, entry]` for a JS entry, else `[entry]`. */
	readonly argv: readonly string[];
	/** Human-readable provenance, surfaced on `KernelStatus.entry`/log lines. */
	readonly source: string;
}

export interface ResolveKernelEntryInput {
	readonly env: EnvLike;
	/** Repo root for the vendored candidate; defaults to this file's `../..`. */
	readonly repoRoot?: string;
	readonly exists?: (path: string) => boolean;
	readonly findOnPath?: (binary: string) => string | null;
	readonly realpath?: (path: string) => string | null;
}

/**
 * Resolve the daemon entry to spawn, or throw `KernelError` when nothing
 * resolves (an operator-visible misconfiguration: every arm was tried).
 */
export function resolveKernelEntry(input: ResolveKernelEntryInput): KernelEntry {
	const exists = input.exists ?? existsSync;
	const runtime = nonEmpty(input.env[KERNEL_RUNTIME_ENV]) ?? DEFAULT_KERNEL_RUNTIME;
	const argvFor = (entry: string): string[] =>
		/\.[mc]?js$/.test(entry) ? [runtime, entry] : [entry];

	const explicit = nonEmpty(input.env[KERNEL_ENTRY_ENV]);
	if (explicit !== null) {
		if (!exists(explicit)) {
			throw new KernelError(
				`${KERNEL_ENTRY_ENV} points at a file that does not exist: ${explicit}`,
			);
		}
		return {
			kind: "env",
			entry: explicit,
			argv: argvFor(explicit),
			source: `${KERNEL_ENTRY_ENV}=${explicit}`,
		};
	}

	const vendored = join(input.repoRoot ?? defaultRepoRoot(), VENDORED_KERNEL_ENTRY);
	if (exists(vendored)) {
		return {
			kind: "vendored",
			entry: vendored,
			argv: argvFor(vendored),
			source: `vendored build (${vendored})`,
		};
	}

	const rig = (input.findOnPath ?? pathFinder(input.env))(RIG_BINARY);
	if (rig === null) {
		throw new KernelError(
			`no OpenRig kernel entry found: ${KERNEL_ENTRY_ENV} is unset, the vendored build is not present (${vendored}), and no ${RIG_BINARY} binary is on PATH`,
			`Install @openrig/cli, set ${KERNEL_ENTRY_ENV}=<path to the daemon entry>, or build the vendored tree`,
		);
	}
	const rigReal = (input.realpath ?? realpathOrNull)(rig) ?? rig;
	const cliBaseDir = dirname(rigReal);
	// Upstream's order: monorepo sibling first, then the bundled copy that an
	// npm install ships inside the cli package.
	const candidates = [
		resolve(cliBaseDir, "..", "..", "daemon"),
		resolve(cliBaseDir, "..", "daemon"),
	];
	for (const candidate of candidates) {
		const entry = join(candidate, "dist", "index.js");
		if (exists(entry)) {
			return {
				kind: "rig",
				entry,
				argv: argvFor(entry),
				source: `${RIG_BINARY} at ${rig} → ${entry}`,
			};
		}
	}
	throw new KernelError(
		`${RIG_BINARY} at ${rig} has no bundled daemon: no dist/index.js under ${candidates.join(" or ")}`,
		`Set ${KERNEL_ENTRY_ENV}=<path to the daemon entry>, or reinstall @openrig/cli`,
	);
}

/** The repo root, derived from this file's location (`src/kernel/` → `../..`). */
export function defaultRepoRoot(): string {
	return resolve(import.meta.dir, "..", "..");
}

/**
 * Look a binary up on `PATH`. Existence (not the exec bit) is the test, so the
 * same injected predicate can also vet plain entry files; a non-executable hit
 * surfaces later as a spawn error naming the path.
 */
export function pathFinder(
	env: EnvLike,
	exists: (path: string) => boolean = existsSync,
): (binary: string) => string | null {
	const pathValue = env.PATH ?? "";
	return (binary) => {
		for (const dir of pathValue.split(delimiter)) {
			if (dir === "") continue;
			const candidate = join(dir, binary);
			if (exists(candidate)) return candidate;
		}
		return null;
	};
}

function realpathOrNull(path: string): string | null {
	try {
		return realpathSync(path);
	} catch {
		return null;
	}
}
