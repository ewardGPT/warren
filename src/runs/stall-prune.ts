/**
 * Stall pruning (ubuntu-7579 / TTC roadmap 5).
 *
 * A run that spends turns without producing workspace changes while it is
 * still `running` burns budget for nothing. On each watchdog tick, a running
 * batch-mode run is sampled: when enough new agent events have flowed since
 * the last sample, the sampler reads the workspace's HEAD and dirty state.
 * Three consecutive samples with no progress (no new commits, no uncommitted
 * changes) means the run is spinning — it gets a `progress.stalled` event,
 * its work is salvaged like a failed push (rescue ref + bundle), the backend
 * run is cancelled, and reap finalizes the row `failed/stalled`.
 *
 * Safeguards: off until `WARREN_STALL_PRUNE=1` (or an explicit dep config);
 * batch-mode runs only; a forced-continuation lineage (ubuntu-d8c3) is never
 * pruned this way; a missing/unreachable workspace is skipped, never failed.
 * Every step is best-effort — a sampling or salvage error degrades to a log
 * line, never to a reaped row.
 */

import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";
import { RuntimeRunNotFoundError } from "../runtime/errors.ts";
import { isForcedContinuationLineage } from "./reap/run-evidence.ts";
import { salvageWorkspace } from "./reap/salvage.ts";
import type { ReapExec, ReapFs } from "./reap/types.ts";
import { defaultExec, defaultFs } from "./reap/util.ts";
import { type BridgeLogger, bindBridgeLogger } from "./stream/index.ts";

export const STALL_PRUNE_EVENT = "progress.stalled";
export const STALLED_FAILURE_REASON = "stalled";
export const STALL_DEFAULT_MIN_EVENTS = 4;
export const STALL_DEFAULT_EVENTS_PER_SAMPLE = 2;
export const STALL_DEFAULT_STREAK_THRESHOLD = 3;

export interface StallPruneConfig {
	readonly enabled: boolean;
	/** Agent events that must exist before the first sample. */
	readonly minEvents?: number;
	/** New events required between two samples. */
	readonly eventsPerSample?: number;
	/** Consecutive no-progress samples that earn a cancel. */
	readonly streakThreshold?: number;
	/** Git + salvage seams (tests); default to the reap defaults. */
	readonly exec?: ReapExec;
	readonly fs?: ReapFs;
	readonly salvageDir?: string;
}

/** Per-run sampler state, kept by the caller across ticks. */
export interface StallTrackerState {
	readonly seqAtLastSample: number;
	readonly headAtLastSample: string | null;
	readonly streak: number;
}

export interface StallReapInput {
	readonly runId: string;
	readonly outcome: "failed";
	readonly failureReason: "stalled";
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
}

export interface StallPruneDeps {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	/** Reap seam (the watchdog's bound `reapRun`). */
	readonly reap: (input: StallReapInput) => Promise<unknown>;
	readonly stallPrune?: StallPruneConfig;
	readonly logger?: BridgeLogger;
}

interface WorkspaceSample {
	readonly head: string;
	readonly dirty: boolean;
}

const NO_STALL: StallTrackerState = { seqAtLastSample: 0, headAtLastSample: null, streak: 0 };

async function sampleWorkspace(
	exec: ReapExec,
	workspacePath: string,
): Promise<WorkspaceSample | null> {
	try {
		const head = await exec.run("git", ["rev-parse", "HEAD"], { cwd: workspacePath });
		const status = await exec.run("git", ["status", "--porcelain"], { cwd: workspacePath });
		return { head: head.stdout.trim(), dirty: status.stdout.trim() !== "" };
	} catch {
		return null;
	}
}

function resolveConfig(deps: StallPruneDeps): StallPruneConfig {
	return (
		deps.stallPrune ?? {
			enabled: process.env.WARREN_STALL_PRUNE === "1",
		}
	);
}

/** One sample: advance the streak, or reset it on progress. */
function advanceStreak(
	state: StallTrackerState,
	head: string,
	dirty: boolean,
): Pick<StallTrackerState, "headAtLastSample" | "streak"> {
	const progressed = dirty || (state.headAtLastSample !== null && head !== state.headAtLastSample);
	return { headAtLastSample: head, streak: progressed ? 0 : state.streak + 1 };
}

async function appendRunEvent(
	repos: Repos,
	run: RunRow,
	kind: string,
	payload: Record<string, unknown>,
	ts: string,
): Promise<void> {
	const seq = ((await repos.events.maxSeqForRun(run.id)) ?? 0) + 1;
	await repos.events.append({
		runId: run.id,
		burrowEventSeq: seq,
		ts,
		kind,
		stream: "system",
		payload,
	});
}

/** Capture the workspace (rescue ref + bundle), emitting the outcome event. */
async function salvageBeforeCancel(
	deps: StallPruneDeps,
	config: StallPruneConfig,
	run: RunRow,
	workspacePath: string,
	ts: string,
): Promise<void> {
	try {
		const outcome = await salvageWorkspace({
			runId: run.id,
			workspacePath,
			baseBranch: run.targetBranch ?? null,
			salvageDir: config.salvageDir,
			exec: config.exec ?? defaultExec,
			fs: config.fs ?? defaultFs,
		});
		if (outcome.rescueRef !== null || outcome.bundlePath !== null) {
			await appendRunEvent(
				deps.repos,
				run,
				"reap.workspace_salvaged",
				{ rescueRef: outcome.rescueRef, bundlePath: outcome.bundlePath },
				ts,
			);
		}
	} catch {
		// Salvage is a best-effort capture; the cancel proceeds regardless.
	}
}

/** Emit the stall event, cancel the backend best-effort, and reap the row. */
async function cancelAndReap(
	deps: StallPruneDeps,
	run: RunRow,
	workspacePath: string,
	streak: number,
	ts: string,
): Promise<void> {
	await appendRunEvent(deps.repos, run, STALL_PRUNE_EVENT, { streak, workspacePath }, ts);
	const handle: RunHandle = {
		runId: run.id,
		sandboxId: run.burrowId ?? "",
		providerRunId: run.burrowRunId ?? "",
	};
	try {
		await deps.runtimeProvider.cancel(handle, "watchdog stall pruning");
	} catch (err) {
		if (!(err instanceof RuntimeRunNotFoundError)) {
			bindBridgeLogger(deps.logger, { run_id: run.id }).warn(
				{ event: "stall.cancel_failed", reason: String(err) },
				"stall-prune cancel failed",
			);
		}
	}
	await deps.reap({
		runId: run.id,
		outcome: "failed",
		failureReason: STALLED_FAILURE_REASON,
		repos: deps.repos,
		runtimeProvider: deps.runtimeProvider,
	});
}

/**
 * One sample attempt for one run: gates (mode, lineage, workspace,
 * cadence) then the workspace read and streak advance. Returns null when
 * the run is not samplable or below cadence.
 */
async function takeStallSample(
	deps: StallPruneDeps,
	run: RunRow,
	state: StallTrackerState,
	config: StallPruneConfig,
	seq: number,
	workspacePath: string,
): Promise<StallTrackerState | null> {
	if (run.mode !== "batch") return null;
	if (run.burrowId === null || run.burrowRunId === null) return null;
	if (await isForcedContinuationLineage(deps.repos, run)) return null;
	const minEvents = config.minEvents ?? STALL_DEFAULT_MIN_EVENTS;
	const eventsPerSample = config.eventsPerSample ?? STALL_DEFAULT_EVENTS_PER_SAMPLE;
	if (seq < minEvents) return null;
	if (seq - state.seqAtLastSample < eventsPerSample) return null;
	const sample = await sampleWorkspace(config.exec ?? defaultExec, workspacePath);
	if (sample === null) return null;
	const advanced = advanceStreak(state, sample.head, sample.dirty);
	return {
		seqAtLastSample: seq,
		headAtLastSample: advanced.headAtLastSample,
		streak: advanced.streak,
	};
}

/**
 * One watchdog-tick pass for one running run: sample progress when the
 * cadence allows, and cancel + reap the run when the no-progress streak
 * reaches the threshold. Never throws. The per-run tracker state lives in
 * `states`, which the caller keeps across ticks.
 */
export async function maybeStallPrune(
	deps: StallPruneDeps,
	run: RunRow,
	states: Map<string, StallTrackerState>,
	now: Date,
): Promise<void> {
	const config = resolveConfig(deps);
	if (!config.enabled) return;
	const handle: RunHandle = {
		runId: run.id,
		sandboxId: run.burrowId ?? "",
		providerRunId: run.burrowRunId ?? "",
	};
	const info = await deps.runtimeProvider.workspaceInfo(handle);
	if (info.workspacePath === null) return;
	const seq = (await deps.repos.events.maxSeqForRun(run.id)) ?? 0;
	const state = states.get(run.id) ?? NO_STALL;
	const next = await takeStallSample(deps, run, state, config, seq, info.workspacePath);
	if (next === null) return;
	states.set(run.id, next);
	const threshold = config.streakThreshold ?? STALL_DEFAULT_STREAK_THRESHOLD;
	if (next.streak < threshold) return;
	const ts = now.toISOString();
	await salvageBeforeCancel(deps, config, run, info.workspacePath, ts);
	await cancelAndReap(deps, run, info.workspacePath, next.streak, ts);
	states.delete(run.id);
}
