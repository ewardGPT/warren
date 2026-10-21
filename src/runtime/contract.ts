/**
 * The `RuntimeProvider` contract — the seam that decouples warren's domain from
 * its execution backend (burrow today, Kubernetes next).
 *
 * Authoritative spec: `docs/design/runtime-provider-contract.md` (sections 1–2,
 * with the §4 finalize seam and §6 corrections baked in). This file is
 * types-only; the LocalProvider implementation lands in a later step.
 *
 * The invariant the contract exists to protect: the domain must never leak a
 * burrow-id, a pod name, a socket, a host path, or a `SandboxProfile` across the
 * seam. Everything here is warren's *need*; providers satisfy it.
 */

import type {
	EventOrigin,
	EventStream,
	InboxPriority,
	InboxState,
	RunState,
} from "../core/wire.ts";
import type { ReapExec, ReapFs } from "../runs/reap/types.ts";
import type { FinalizeIntent, FinalizeResult } from "./finalize-contract.ts";

/**
 * Filesystem + exec seams for a provider-owned workspace (ubuntu-c929).
 *
 * The same shape `finalize` runs against, exposed so a domain step outside
 * `finalize` can read the workspace the provider owns. `LocalProvider` answers
 * with the seams it was built with — the host's own under the local backend,
 * ssh-backed under the fleet backend.
 */
export interface WorkspaceSeams {
	readonly fs?: ReapFs;
	readonly exec?: ReapExec;
}

/**
 * Opaque handle — the only run reference that crosses the seam. Providers map
 * `runId` → native ids internally; the domain treats `sandboxId`/`providerRunId`
 * as opaque.
 */
export interface RunHandle {
	/** warren domain id — the identity, generated pre-dispatch */
	runId: string;
	/** provider workspace/sandbox id (burrowId | pod name) */
	sandboxId: string;
	/** provider run/dispatch id (burrowRunId | pod uid) */
	providerRunId: string;
}

/**
 * Provider-neutral INTENT. No `SandboxProfile`, no host paths, no callback URL —
 * the provider owns its own plumbing (§6.3: the callback URL is provider-owned,
 * not domain env).
 */
export interface RunSpec {
	runId: string;

	// Workspace materialization INPUTS (never a pre-built result — the provider
	// materializes: burrow internally, K8s in an init container).
	originUrl: string;
	branch: string;
	/**
	 * PROMOTED to first-class (§6.2) — burrow resolved it internally
	 * (`default_branch ?? "main"`); the K8s init container needs it explicit.
	 */
	baseBranch: string;
	/** optional burrow worktree optimization; K8s ignores it. */
	hostClonePathHint?: string;

	/**
	 * OPTIONAL project identity (the warren `projects.id`). K8s stamps it onto the
	 * pod (`warren.io/project`) and counts by it for the per-project admission cap
	 * (warren-b6f2); LocalProvider ignores it.
	 */
	projectId?: string;
	/**
	 * OPTIONAL per-project concurrency cap — max simultaneous non-terminal run
	 * pods for this project, from `.warren/config.yaml` `admission.maxConcurrentRuns`
	 * (warren-b6f2). K8s enforces it; LocalProvider ignores it.
	 */
	maxProjectConcurrency?: number;

	// Agent.
	/** claude-code | pi | codex | sapling — selects image/toolchain */
	runtimeId: string;
	/** system section already prepended by the domain */
	prompt: string;
	/** e.g. `{ frontmatter }` — provider carries to runtime */
	metadata?: Record<string, unknown>;
	mode: "batch" | "conversation";

	// Isolation INTENT (provider maps to SandboxProfile | pod securityContext+resources).
	network: "none" | "restricted" | "open";
	resources?: { memoryMiB?: number; cpuMillicores?: number; ephemeralStorageMiB?: number };
	/**
	 * OPTIONAL per-project pod resource defaults from `.warren/config.yaml`
	 * `resources` (warren-aedd) — the dispatch path reads the project config once
	 * and carries the subset here because the provider is built at boot and can't
	 * re-read it per run (same pattern as `maxProjectConcurrency`). Precedence:
	 * per-run `resources` limit > `projectResources` > env defaults. K8s only.
	 */
	projectResources?: {
		requests?: { memoryMiB?: number; cpuMillicores?: number; ephemeralStorageMiB?: number };
		limits?: { memoryMiB?: number; cpuMillicores?: number; ephemeralStorageMiB?: number };
		network?: "none" | "restricted" | "open";
	};
	timeoutMs?: number;

	/** Context drops written into the workspace (.canopy/.mulch/.seeds/.pi). */
	seedFiles: ReadonlyArray<{ path: string; contents: string; encoding?: string; mode?: number }>;

	/**
	 * DOMAIN env only — coordination + secrets: WARREN_QUALITY_GATE,
	 * WARREN_API_TOKEN. The provider ADDS its own plumbing (WARREN_API_URL
	 * callback, BUN_INSTALL_CACHE_DIR, …); the domain must NOT set those.
	 */
	env: Record<string, string>;
}

/**
 * One event off the ordered, resumable, lossless stream. `payload` is passed
 * through verbatim (§6.6) — providers MUST NOT summarize it; the budget/cost
 * extractor reads `total_cost_usd`/`usage` out of these payloads. Provenance
 * (`origin`) is classified at the parse boundary, never self-declared.
 */
export interface NormalizedEvent {
	/** Monotonic per run — burrow server-assigns, K8s synthesizes a cursor over pod logs (§6.4). */
	seq: number;
	/** ISO-8601 */
	ts: string;
	/**
	 * OPEN string. Terminal envelopes ride `kind="state_change"`, discriminated
	 * by `payload.type` (`"result"` | `"agent_end"`) — do NOT lift them into a
	 * typed terminal event or `detectRuntimeTerminal` breaks.
	 */
	kind: string;
	/** unknown coerces to `null`. Derived from `EVENT_STREAMS` (`src/core/wire.ts`). */
	stream: EventStream | null;
	/** warren-6646, see `src/core/wire.ts`: only `"warren"` keeps system authority. */
	origin?: EventOrigin;
	/** LOSSLESS — see interface doc; typed `unknown` deliberately. */
	payload: unknown;
}

/** Resume cursor — dedup: the domain skips `seq <= sinceSeq`. */
export interface StreamOpts {
	sinceSeq?: number;
}

/** Provider run phase — canonical `RUN_STATES` (`src/core/wire.ts`), warren-7b7a. */
export type RunPhase = RunState;

/**
 * Coarse terminal reason — the only terminal classification that is a provider
 * concern (fine-grained `failure_reason` stays in the domain, §3).
 *
 * - `completed` — agent finished normally.
 * - `error` — agent/runtime failed.
 * - `oom_killed` — killed by the cgroup/OOM killer (§6.5): burrow's oomKilled()
 *   probe + `oom_killed` event; K8s `terminated.reason=="OOMKilled"`.
 * - `evicted` — the kubelet evicted the pod (K8s `status.reason=="Evicted"`)
 *   under node pressure, usually ephemeral-storage exhaustion (warren-c0cd).
 *   K8s-only, and distinct from `oom_killed` (a container cgroup kill) and
 *   `error` (an agent fault): an eviction is an infra-capacity signal.
 * - `cancelled` — graceful stop via `cancel()`.
 * - `lost` — run vanished (burrow 404 / pod GC'd); pairs with `exists:false`.
 */
export type TerminalReason =
	| "completed"
	| "error"
	| "oom_killed"
	| "evicted"
	| "cancelled"
	| "lost";

/**
 * Out-of-band reconcile/recovery snapshot — what the watchdog/recovery/pod-watcher
 * read. `status()` NEVER throws on a missing run; it returns `exists:false` (§6.7).
 */
export interface RunStatus {
	phase: RunPhase;
	exitCode: number | null;
	terminalReason?: TerminalReason;
	/** Provider detail behind a terminal classification (warren-4a95), e.g. the kubelet's eviction message. */
	terminalDetail?: string | null;
	/** collapses the separate `maxSeqForRun` query */
	lastEventSeq: number;
	/** heartbeat anchor (the domain still owns the watchdog decision) */
	lastEventTs: string | null;
	/** `false` ⇒ run_lost (burrow 404 / pod GC'd) — a value, not a throw */
	exists: boolean;
}

/** Steering priority — canonical `INBOX_PRIORITIES` (`src/core/wire.ts`), warren-7b7a. */
export type MessagePriority = InboxPriority;

export interface OutboundMessage {
	body: string;
	priority?: MessagePriority;
	fromActor?: string;
}

/** The persisted row returned to the domain. */
export interface Message {
	id: string;
	runId: string | null;
	body: string;
	priority: MessagePriority;
	fromActor: string;
	/** Delivery lifecycle — canonical `INBOX_STATES` (`src/core/wire.ts`). */
	state: InboxState;
	createdAt: string;
	deliveredAt: string | null;
}

/**
 * What a provider can and can't do — the domain branches on these, it does not
 * assume (§5). K8s v1 degrades several of them relative to LocalProvider.
 */
export interface RuntimeCapabilities {
	/** inbound port exposure supported */
	previewPorts: boolean;
	/** burrow: domain-allowlist; K8s v1: coarse */
	networkPolicy: "none" | "coarse" | "domain-allowlist";
	/** conversation / holdStdin streaming */
	longLived: boolean;
	/** deliver mid-turn vs next-spawn only */
	midRunSteering: boolean;
	/** cgroup memory/cpu + oomKilled */
	enforcedResourceLimits: boolean;
	/** terminate returns an archive handle */
	workspaceArchive: boolean;
	/**
	 * Fallback garbage collection of stranded run workspaces is a backend concern
	 * the control plane can drive (warren-e24d). `true` for LocalProvider — reap's
	 * per-run destroy can strand a workspace on a mid-reap crash, so warren sweeps
	 * idle workspaces via the destroy seam. `false` where the backend's own
	 * lifecycle reclaims them (K8s pod-GC reclaims terminal pods + their emptyDir),
	 * so the sweep stays dark instead of aiming a burrow destroy at a pod name.
	 */
	workspaceGc: boolean;
}

export interface TeardownResult {
	archived: boolean;
	deletedEvents: number;
	deletedMessages: number;
	deletedRuns: number;
}

/**
 * The provider-neutral answer to reap's "where is this run's workspace, and what
 * branch does it push?" question (warren-e9e1). Replaces reap's direct
 * `burrows.get` — a burrow-only call that 404s on a K8s pod name and stranded
 * succeeded K8s runs before `finalize` ever ran.
 *
 * - `workspacePath` is a HOST path when the backend runs finalize host-side over
 *   a shared workspace (LocalProvider → the burrow worktree). It is `null` when
 *   the workspace is unreachable from the control plane (K8sProvider → the pod's
 *   `emptyDir`); the domain then routes finalize through the seam (in-pod) and
 *   applies the returned mirror deltas to the project clone itself.
 * - `branch` is the run's push branch, resolved from wherever the backend
 *   recorded it (burrow echoes it on `GET /burrows/:id`; K8s stamps it as a pod
 *   annotation). `null` when it could not be resolved — finalize then pushes
 *   `HEAD` (reap's historical fallback).
 *
 * A THROW means resolution failed (a live burrow that 404'd, an API error): the
 * domain records `workspace_lookup` and skips the success pipeline, as reap did
 * when `burrows.get` threw. A `workspacePath: null` is NOT a failure — it is K8s
 * reporting a legitimately host-unreachable (but finalizable) workspace.
 */
export interface WorkspaceInfo {
	workspacePath: string | null;
	branch: string | null;
}

// The finalize seam's intent/result vocabulary (§4) — `FinalizeIntent`,
// `FinalizeEvent`, `FinalizeResult`, `FinalizeStageOutcome` — lives in
// `./finalize-contract.ts` (size-budget split, warren-4553); re-exported here
// so importers keep using `../contract.ts`.
export type {
	FinalizeEvent,
	FinalizeIntent,
	FinalizeResult,
	FinalizeStageOutcome,
} from "./finalize-contract.ts";
// Feature-neutral artifact deltas `finalize` returns for the domain to apply to
// its project clone. Extracted to `./finalize-deltas.ts` (warren-e9e1, frozen
// size budget); re-exported here so importers keep using `../contract.ts`.
export type { ArtifactDelta, ArtifactDeltaFile } from "./finalize-deltas.ts";

export type { FinalizePipelineStage, FinalizeStage } from "./finalize-stages.ts";
// The finalize stage vocabulary (warren-357c) lives in `./finalize-stages.ts` (size-budget split).
export {
	FINALIZE_PIPELINE_STAGES,
	finalizeCommitStage,
	finalizeMergeStage,
	isFinalizeStage,
} from "./finalize-stages.ts";

/**
 * The runtime backend seam. Eight methods; `create / streamEvents / status /
 * sendMessage / cancel / terminate` are firm and fully grounded, `finalize` is
 * the load-bearing §4 seam (its existence is not optional — something must
 * bridge the filesystem gap under pod-per-run).
 */
export interface RuntimeProvider {
	readonly capabilities: RuntimeCapabilities;

	/**
	 * Filesystem + exec seams for the workspace this provider owns
	 * (ubuntu-c929). Optional: a provider answers only when its workspace is
	 * reachable through it rather than through the warren host.
	 *
	 * The domain needs these for workspace work that lives OUTSIDE `finalize` —
	 * reap's salvage capture and the scorecard's diff read. Without them, a
	 * remote workspace (a fleet box) gets read through the host's own
	 * filesystem, which is the wrong machine.
	 *
	 * Absent ⇒ the caller's own seams hold.
	 */
	workspaceSeams?(handle: RunHandle): WorkspaceSeams | undefined;

	/**
	 * Create a run. Collapses burrow's two-call (`burrows.up` + `runs.create`)
	 * into one (§6.1). The provider OWNS: workspace materialization (burrow:
	 * internal; K8s: init container), callback-URL computation, seq origin,
	 * uid/gid, and filesystem-layout env. The domain supplies only neutral
	 * intent (`RunSpec`).
	 */
	create(spec: RunSpec): Promise<RunHandle>;

	/**
	 * Ordered, resumable, lossless event stream. The provider GUARANTEES a
	 * monotonic per-run `seq` (burrow server-assigns; K8s synthesizes a cursor
	 * over pod logs) and passes `payload` through verbatim (the cost extractor
	 * reads it).
	 */
	streamEvents(handle: RunHandle, opts?: StreamOpts): AsyncIterable<NormalizedEvent>;

	/**
	 * Out-of-band reconcile/recovery snapshot. NEVER throws on a missing run —
	 * returns `exists:false`. This is what the watchdog/recovery/pod-watcher use.
	 */
	status(handle: RunHandle): Promise<RunStatus>;

	/**
	 * Enqueue a steering message. Priority-desc then FIFO claim ordering,
	 * run-attributed, crash-safe (unread→delivered→failed). Delivery timing
	 * depends on `capabilities.midRunSteering` (live stdin vs next-spawn fold-in).
	 */
	sendMessage(handle: RunHandle, msg: OutboundMessage): Promise<Message>;

	/**
	 * Graceful stop — distinct from `terminate`. Burrow: POST /cancel. K8s:
	 * SIGTERM + grace. Best-effort; the domain still reaps + terminates after.
	 */
	cancel(handle: RunHandle, reason?: string): Promise<void>;

	/**
	 * Resolve the run's workspace path + push branch (warren-e9e1) — the neutral
	 * replacement for reap's direct `burrows.get`. LocalProvider returns the live
	 * burrow worktree path + branch; K8sProvider returns `{ workspacePath: null,
	 * branch }` (the pod's `emptyDir` is host-unreachable). Throws only on a
	 * genuine resolution failure — a `null` workspace path is a value, not a throw.
	 * The domain gates its success pipeline on this resolving rather than on a
	 * host path existing, so succeeded K8s runs reach `finalize`.
	 */
	workspaceInfo(handle: RunHandle): Promise<WorkspaceInfo>;

	/**
	 * Runs the workspace-DEPENDENT half of reap while the workspace is still
	 * live and returns its artifacts (§4). The load-bearing method, not a detail.
	 */
	finalize(handle: RunHandle, intent: FinalizeIntent): Promise<FinalizeResult>;

	/**
	 * Kill the sandbox/pod, reclaim the workspace, archive+prune the ephemeral
	 * store. Idempotent, best-effort. The domain calls this ONLY after
	 * `finalize()`.
	 */
	terminate(handle: RunHandle): Promise<TeardownResult>;
}
