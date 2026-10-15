/**
 * Public surface for warren's OpenRig kernel supervision (`src/kernel/`).
 *
 * `kernelPaths` / `kernelStatus` / `kernelStart` / `kernelStop` /
 * `kernelClient` are the sealed contract; everything else here is the seam set
 * the tests and the (future) CLI verbs need to drive them without a real
 * daemon. See `./paths.ts` for the isolation rationale (private
 * `OPENRIG_HOME` + private `HOME`) and `./status.ts` for the lifecycle rules.
 */

export {
	DEFAULT_KERNEL_CLIENT_TIMEOUT_MS,
	type KernelClient,
	type KernelClientDeps,
	kernelClient,
} from "./client.ts";
export { productionKernelDeps } from "./deps.ts";
export {
	DEFAULT_KERNEL_RUNTIME,
	defaultRepoRoot,
	KERNEL_ENTRY_ENV,
	KERNEL_RUNTIME_ENV,
	type KernelEntry,
	type KernelEntryKind,
	pathFinder,
	type ResolveKernelEntryInput,
	RIG_BINARY,
	resolveKernelEntry,
	VENDORED_KERNEL_ENTRY,
} from "./entry.ts";
export {
	DEFAULT_DATA_DIR,
	DEFAULT_KERNEL_DIRNAME,
	DEFAULT_KERNEL_HOST,
	DEFAULT_KERNEL_PORT,
	type EnvLike,
	KERNEL_LOG_FILENAME,
	KERNEL_PID_FILENAME,
	KERNEL_PRIVATE_HOME_DIRNAME,
	KERNEL_TOKEN_FILENAME,
	KernelError,
	type KernelPaths,
	kernelDataDir,
	kernelPaths,
	nonEmpty,
} from "./paths.ts";
export {
	clearPidRecord,
	createKernelFs,
	defaultReadCmdline,
	defaultSleep,
	defaultSpawnProcess,
	ensureKernelToken,
	KERNEL_DIR_MODE,
	KERNEL_FILE_MODE,
	KERNEL_LOG_TAIL_BYTES,
	KERNEL_TOKEN_BYTES,
	type KernelChild,
	type KernelExit,
	type KernelFs,
	type KernelPidRecord,
	type KernelProcessDeps,
	kernelChildEnv,
	readLogTail,
	readPidRecord,
	type SpawnKernelInput,
	type SpawnProcessFn,
	type SpawnProcessInput,
	spawnKernel,
	writePidRecord,
} from "./spawn.ts";
export {
	DEFAULT_HEALTH_TIMEOUT_MS,
	DEFAULT_KILL_WAIT_MS,
	DEFAULT_READINESS_INTERVAL_MS,
	DEFAULT_READINESS_TIMEOUT_MS,
	DEFAULT_STOP_GRACE_MS,
	DEFAULT_STOP_POLL_INTERVAL_MS,
	type KernelDeps,
	type KernelOptions,
	type KernelState,
	type KernelStatus,
	kernelStart,
	kernelStatus,
	kernelStop,
} from "./status.ts";
