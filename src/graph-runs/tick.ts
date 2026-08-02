/**
 * GraphRun coordinator tick loop (graph-engineering pilot).
 */

import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { GraphRunRow } from "../db/schema.ts";
import { defaultStopCheck } from "./check-stop.ts";
import {
	type AdvanceGraphRunResult,
	advanceGraphRun,
	type CoordinatorEmitFn,
	type CoordinatorRepos,
	type CoordinatorSpawnFn,
	type GraphRunEventKind,
	type StopCheckFn,
} from "./coordinator.ts";
import { readRunOutputFromEvents } from "./run-output.ts";

export interface GraphRunTickLogger {
	info(obj: Record<string, unknown>, msg?: string): void;
	warn(obj: Record<string, unknown>, msg?: string): void;
	error(obj: Record<string, unknown>, msg?: string): void;
}

export interface GraphRunTickDeps {
	readonly repos: Pick<Repos, "graphRuns" | "runs" | "events">;
	readonly spawn: CoordinatorSpawnFn;
	readonly checkStop?: StopCheckFn;
	readonly readRunOutput?: (runId: string) => Promise<string>;
	readonly now?: () => Date;
	readonly logger?: GraphRunTickLogger;
	readonly emit?: CoordinatorEmitFn;
}

export interface GraphRunAdvanceLog {
	readonly graphRunId: string;
	readonly result: AdvanceGraphRunResult;
}

export interface GraphRunTickResult {
	readonly advances: readonly GraphRunAdvanceLog[];
	readonly errors: readonly { readonly graphRunId: string; readonly reason: string }[];
}

export async function runGraphRunTick(deps: GraphRunTickDeps): Promise<GraphRunTickResult> {
	const advances: GraphRunAdvanceLog[] = [];
	const errors: { graphRunId: string; reason: string }[] = [];
	const emit = deps.emit ?? buildDefaultEmit(deps.repos as CoordinatorRepos, deps.now);
	const checkStop = deps.checkStop ?? defaultStopCheck;
	const readRunOutput = deps.readRunOutput ?? buildDefaultReadRunOutput(deps.repos.events);

	const active: GraphRunRow[] = await deps.repos.graphRuns.listActive();
	for (const graphRun of active) {
		try {
			const result = await advanceGraphRun({
				graphRun,
				repos: deps.repos as CoordinatorRepos,
				spawn: deps.spawn,
				checkStop,
				emit,
				readRunOutput,
				...(deps.now !== undefined ? { now: deps.now } : {}),
			});
			advances.push({ graphRunId: graphRun.id, result });
			logAdvance(deps.logger, graphRun.id, result);
		} catch (err) {
			const reason = formatError(err);
			errors.push({ graphRunId: graphRun.id, reason });
			deps.logger?.error({ graphRunId: graphRun.id, reason }, "graph_run.advance_failed");
		}
	}

	return { advances, errors };
}

function logAdvance(
	logger: GraphRunTickLogger | undefined,
	graphRunId: string,
	result: AdvanceGraphRunResult,
): void {
	if (logger === undefined) return;
	if (result.kind === "graph_run_failed") {
		logger.warn({ graphRunId, reason: result.reason }, "graph_run.failed");
		return;
	}
	if (result.kind === "noop") {
		logger.warn({ graphRunId, reason: result.reason }, "graph_run.noop");
		return;
	}
	logger.info({ graphRunId, kind: result.kind }, "graph_run.advanced");
}

function buildDefaultEmit(repos: CoordinatorRepos, now?: () => Date): CoordinatorEmitFn {
	return async (runId: string, kind: GraphRunEventKind, payload: Record<string, unknown>) => {
		const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
		const ts = (now?.() ?? new Date()).toISOString();
		await repos.events.append({
			runId,
			burrowEventSeq: seq,
			ts,
			kind,
			stream: "system",
			payload,
		});
	};
}

function buildDefaultReadRunOutput(
	events: Pick<Repos["events"], "listTail">,
): (runId: string) => Promise<string> {
	return async (runId: string) => {
		const rows = await events.listTail(runId, 200);
		return readRunOutputFromEvents(rows);
	};
}

export type GraphRunCoordinatorTimerHandle = object;

export interface BootGraphRunCoordinatorInput extends GraphRunTickDeps {
	readonly tickMs: number;
	readonly disabled?: boolean;
	readonly setInterval?: (cb: () => void, ms: number) => GraphRunCoordinatorTimerHandle;
	readonly clearInterval?: (handle: GraphRunCoordinatorTimerHandle) => void;
}

export interface GraphRunCoordinatorHandle {
	stop(): Promise<void>;
	runOnce(): Promise<GraphRunTickResult | null>;
	tickCount(): number;
}

const NOOP_HANDLE = Symbol(
	"graph-run-coordinator-noop-handle",
) as unknown as GraphRunCoordinatorTimerHandle;

export function bootGraphRunCoordinator(
	input: BootGraphRunCoordinatorInput,
): GraphRunCoordinatorHandle {
	const setIntervalFn: (cb: () => void, ms: number) => GraphRunCoordinatorTimerHandle =
		input.setInterval ??
		((cb, ms) => globalThis.setInterval(cb, ms) as GraphRunCoordinatorTimerHandle);
	const clearIntervalFn: (handle: GraphRunCoordinatorTimerHandle) => void =
		input.clearInterval ?? ((handle) => globalThis.clearInterval(handle as never));

	let inFlight: Promise<GraphRunTickResult | null> | null = null;
	let ticks = 0;
	let stopped = false;

	const fire = async (): Promise<GraphRunTickResult | null> => {
		if (stopped) return null;
		if (inFlight !== null) {
			input.logger?.info({}, "graph_run.tick_skipped");
			return null;
		}
		const promise = (async () => {
			try {
				const result = await runGraphRunTick(input);
				ticks += 1;
				return result;
			} catch (err) {
				input.logger?.error({ reason: formatError(err) }, "graph_run.tick_failed");
				return null;
			} finally {
				inFlight = null;
			}
		})();
		inFlight = promise;
		return promise;
	};

	const handle: GraphRunCoordinatorTimerHandle =
		input.disabled === true ? NOOP_HANDLE : setIntervalFn(() => void fire(), input.tickMs);

	return {
		async stop() {
			stopped = true;
			if (handle !== NOOP_HANDLE) clearIntervalFn(handle);
			if (inFlight !== null) {
				try {
					await inFlight;
				} catch {
					// already logged in fire()
				}
			}
		},
		runOnce: fire,
		tickCount: () => ticks,
	};
}
