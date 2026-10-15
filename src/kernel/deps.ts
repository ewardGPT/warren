/**
 * `src/kernel/deps.ts` — the production wiring for the kernel supervisor.
 *
 * Every seam the supervisor touches is injectable so its tests never spawn a
 * process; this module is the one place that binds those seams to the real
 * filesystem, the real clock, real signals and the global fetch. Split out of
 * `status.ts` to keep both files reviewable.
 */

import { randomBytes } from "node:crypto";
import { createKernelFs, defaultReadCmdline, defaultSleep, defaultSpawnProcess } from "./spawn.ts";
import type { KernelDeps } from "./status.ts";

/** Production wiring: real fs, real signals, real clock, global fetch. */
export function productionKernelDeps(overrides: Partial<KernelDeps> = {}): KernelDeps {
	return {
		fs: createKernelFs(),
		spawn: defaultSpawnProcess,
		signal: (pid, signal) => {
			process.kill(pid, signal);
		},
		readCmdline: defaultReadCmdline,
		now: () => Date.now(),
		sleep: defaultSleep,
		schedule: (fn, ms) => {
			const handle = setTimeout(fn, ms);
			return () => clearTimeout(handle);
		},
		randomBytes: (size) => randomBytes(size),
		fetch: (input, init) => fetch(input, init),
		...overrides,
	};
}
