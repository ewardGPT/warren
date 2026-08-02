/**
 * GraphRun coordinator state machine (graph-engineering pilot).
 *
 * Phases: FAN_OUT (parallel file audits, max 16 concurrent) → VERIFY
 * (checkStop per finding) → SYNTHESIZE (single aggregation run).
 */

import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import {
	GRAPH_RUN_CHILD_TERMINAL_STATES,
	type GraphRunChildRow,
	type GraphRunFindingJson,
	type GraphRunRow,
	RUN_TERMINAL_STATES,
	type RunRow,
	type RunTerminalState,
} from "../db/schema.ts";

export type CoordinatorRepos = Pick<Repos, "graphRuns" | "runs" | "events">;

export type StopCheckFn = (stopPrompt: string, runOutput: string) => Promise<boolean>;

export interface CoordinatorSpawnInput {
	readonly graphRun: GraphRunRow;
	readonly child: GraphRunChildRow;
	readonly prompt: string;
}

export interface CoordinatorSpawnResult {
	readonly runId: string;
}

export type CoordinatorSpawnFn = (input: CoordinatorSpawnInput) => Promise<CoordinatorSpawnResult>;

export type CoordinatorEmitFn = (
	runId: string,
	kind: GraphRunEventKind,
	payload: Record<string, unknown>,
) => Promise<void>;

export const GRAPH_RUN_EVENT_KINDS = [
	"graph_run.dispatched",
	"graph_run.advanced",
	"graph_run.failed",
	"graph_run.succeeded",
] as const;
export type GraphRunEventKind = (typeof GRAPH_RUN_EVENT_KINDS)[number];

export type AdvanceGraphRunResult =
	| { readonly kind: "dispatched"; readonly count: number }
	| { readonly kind: "waiting_for_runs" }
	| { readonly kind: "waiting_for_verify" }
	| {
			readonly kind: "advanced";
			readonly from: GraphRunRow["state"];
			readonly to: GraphRunRow["state"];
	  }
	| { readonly kind: "graph_run_succeeded" }
	| { readonly kind: "graph_run_failed"; readonly reason: string }
	| { readonly kind: "noop"; readonly reason: string };

export interface AdvanceGraphRunInput {
	readonly graphRun: GraphRunRow;
	readonly repos: CoordinatorRepos;
	readonly spawn: CoordinatorSpawnFn;
	readonly checkStop: StopCheckFn;
	readonly emit: CoordinatorEmitFn;
	readonly readRunOutput: (runId: string) => Promise<string>;
	readonly now?: () => Date;
}

export function isGraphChildTerminal(state: GraphRunChildRow["state"]): boolean {
	return (GRAPH_RUN_CHILD_TERMINAL_STATES as readonly string[]).includes(state);
}

export async function advanceGraphRun(input: AdvanceGraphRunInput): Promise<AdvanceGraphRunResult> {
	const nowFn = input.now ?? (() => new Date());
	let graphRun = input.graphRun;

	if (graphRun.state === "pending") {
		const startedAt = nowFn().toISOString();
		graphRun = await input.repos.graphRuns.transitionTo(graphRun.id, "fan_out", { startedAt });
	}

	switch (graphRun.state) {
		case "fan_out":
			return advanceFanOut({ ...input, graphRun, nowFn });
		case "verifying":
			return advanceVerify({ ...input, graphRun, nowFn });
		case "synthesizing":
			return advanceSynthesize({ ...input, graphRun, nowFn });
		default:
			return { kind: "noop", reason: `terminal_or_unhandled_state:${graphRun.state}` };
	}
}

async function advanceFanOut(
	input: AdvanceGraphRunInput & { readonly graphRun: GraphRunRow; readonly nowFn: () => Date },
): Promise<AdvanceGraphRunResult> {
	let children = await input.repos.graphRuns.listChildrenByPhase(input.graphRun.id, "fan_out");
	await syncDispatchedChildren(input, children);
	children = await input.repos.graphRuns.listChildrenByPhase(input.graphRun.id, "fan_out");

	const inFlight = children.filter((c) => c.state === "dispatched").length;
	const pending = children.filter((c) => c.state === "pending");
	const slots = Math.max(0, input.graphRun.maxFanOut - inFlight);
	const toDispatch = pending.slice(0, slots);

	if (toDispatch.length > 0) {
		let dispatched = 0;
		for (const child of toDispatch) {
			const prompt = buildFanOutPrompt(input.graphRun, child.filePath ?? "");
			try {
				const spawnResult = await input.spawn({ graphRun: input.graphRun, child, prompt });
				await input.repos.graphRuns.updateChild({
					id: child.id,
					patch: { runId: spawnResult.runId, state: "dispatched" },
				});
				await input.emit(spawnResult.runId, "graph_run.dispatched", {
					graphRunId: input.graphRun.id,
					childId: child.id,
					phase: "fan_out",
					filePath: child.filePath,
				});
				dispatched += 1;
			} catch (err) {
				return failGraphRun(input, `fan_out_dispatch_failed:${formatError(err)}`);
			}
		}
		return { kind: "dispatched", count: dispatched };
	}

	if (children.some((c) => c.state === "dispatched")) {
		return { kind: "waiting_for_runs" };
	}

	if (children.some((c) => c.state === "failed")) {
		return failGraphRun(input, "fan_out_child_failed");
	}

	const findings = await collectFindings(input, children);
	if (input.graphRun.verifyEnabled && findings.length > 0) {
		await input.repos.graphRuns.insertChildren(
			input.graphRun.id,
			findings.map((finding, idx) => ({
				seq: children.length + idx + 1,
				phase: "verify" as const,
				findingJson: finding,
			})),
		);
		const next = await input.repos.graphRuns.transitionTo(input.graphRun.id, "verifying");
		await input.emit(mostRecentRunId(children) ?? input.graphRun.id, "graph_run.advanced", {
			graphRunId: input.graphRun.id,
			from: "fan_out",
			to: "verifying",
			findingCount: findings.length,
		});
		return { kind: "advanced", from: "fan_out", to: next.state };
	}

	return enterSynthesizeOrSucceed(input, findings, "fan_out");
}

async function advanceVerify(
	input: AdvanceGraphRunInput & { readonly graphRun: GraphRunRow; readonly nowFn: () => Date },
): Promise<AdvanceGraphRunResult> {
	let children = await input.repos.graphRuns.listChildrenByPhase(input.graphRun.id, "verify");
	const pending = children.filter((c) => c.state === "pending");

	for (const child of pending) {
		const finding = child.findingJson;
		if (finding === null) {
			await input.repos.graphRuns.updateChild({ id: child.id, patch: { state: "failed" } });
			continue;
		}
		const prompt = buildVerifyPrompt(finding);
		try {
			const ok = await input.checkStop(prompt, JSON.stringify(finding));
			await input.repos.graphRuns.updateChild({
				id: child.id,
				patch: { state: ok ? "succeeded" : "failed" },
			});
		} catch (err) {
			return failGraphRun(input, `verify_check_failed:${formatError(err)}`);
		}
	}

	children = await input.repos.graphRuns.listChildrenByPhase(input.graphRun.id, "verify");
	if (children.some((c) => c.state === "pending")) {
		return { kind: "waiting_for_verify" };
	}

	const verified = children.filter((c) => c.state === "succeeded" && c.findingJson !== null);
	const findings = verified
		.map((c) => c.findingJson)
		.filter((f): f is GraphRunFindingJson => f !== null);

	return enterSynthesizeOrSucceed(input, findings, "verifying");
}

async function advanceSynthesize(
	input: AdvanceGraphRunInput & { readonly graphRun: GraphRunRow; readonly nowFn: () => Date },
): Promise<AdvanceGraphRunResult> {
	const children = await input.repos.graphRuns.listChildrenByPhase(input.graphRun.id, "synthesize");
	if (children.length === 0) {
		return failGraphRun(input, "synthesize_child_missing");
	}
	let child = children[0];
	if (child === undefined) {
		return failGraphRun(input, "synthesize_child_missing");
	}

	if (child.state === "pending") {
		const verifyChildren = await input.repos.graphRuns.listChildrenByPhase(
			input.graphRun.id,
			"verify",
		);
		const findings = verifyChildren
			.filter((c) => c.state === "succeeded" && c.findingJson !== null)
			.map((c) => c.findingJson)
			.filter((f): f is GraphRunFindingJson => f !== null);
		const prompt = buildSynthesizePrompt(findings);
		try {
			const spawnResult = await input.spawn({ graphRun: input.graphRun, child, prompt });
			await input.repos.graphRuns.updateChild({
				id: child.id,
				patch: { runId: spawnResult.runId, state: "dispatched" },
			});
			await input.emit(spawnResult.runId, "graph_run.dispatched", {
				graphRunId: input.graphRun.id,
				childId: child.id,
				phase: "synthesize",
			});
			return { kind: "dispatched", count: 1 };
		} catch (err) {
			return failGraphRun(input, `synthesize_dispatch_failed:${formatError(err)}`);
		}
	}

	if (child.state === "dispatched") {
		if (child.runId === null) return { kind: "waiting_for_runs" };
		const run = await input.repos.runs.get(child.runId);
		if (run === null || !isRunTerminal(run.state)) {
			return { kind: "waiting_for_runs" };
		}
		if (run.state !== "succeeded") {
			return failGraphRun(input, `synthesize_run_${run.state}`);
		}
		await input.repos.graphRuns.updateChild({ id: child.id, patch: { state: "succeeded" } });
		child = { ...child, state: "succeeded" };
	}

	if (child.state === "failed") {
		return failGraphRun(input, "synthesize_child_failed");
	}

	const endedAt = input.nowFn().toISOString();
	await input.repos.graphRuns.transitionTo(input.graphRun.id, "succeeded", { endedAt });
	if (child.runId !== null) {
		await input.emit(child.runId, "graph_run.succeeded", { graphRunId: input.graphRun.id });
	}
	return { kind: "graph_run_succeeded" };
}

async function enterSynthesizeOrSucceed(
	input: AdvanceGraphRunInput & { readonly graphRun: GraphRunRow; readonly nowFn: () => Date },
	findings: readonly GraphRunFindingJson[],
	from: GraphRunRow["state"],
): Promise<AdvanceGraphRunResult> {
	if (input.graphRun.synthesizeEnabled) {
		await input.repos.graphRuns.insertChildren(input.graphRun.id, [
			{ seq: 10_000, phase: "synthesize", state: "pending" },
		]);
		const next = await input.repos.graphRuns.transitionTo(input.graphRun.id, "synthesizing");
		await input.emit(
			mostRecentRunId(await input.repos.graphRuns.listChildren(input.graphRun.id)) ??
				input.graphRun.id,
			"graph_run.advanced",
			{
				graphRunId: input.graphRun.id,
				from,
				to: "synthesizing",
				findingCount: findings.length,
			},
		);
		return { kind: "advanced", from, to: next.state };
	}

	const endedAt = input.nowFn().toISOString();
	await input.repos.graphRuns.transitionTo(input.graphRun.id, "succeeded", { endedAt });
	return { kind: "graph_run_succeeded" };
}

async function syncDispatchedChildren(
	input: AdvanceGraphRunInput,
	children: readonly GraphRunChildRow[],
): Promise<void> {
	for (const child of children) {
		if (child.state !== "dispatched" || child.runId === null) continue;
		const run = await input.repos.runs.get(child.runId);
		if (run === null || !isRunTerminal(run.state)) continue;
		await input.repos.graphRuns.updateChild({
			id: child.id,
			patch: { state: isGraphRunChildSuccess(run) ? "succeeded" : "failed" },
		});
	}
}

/** Read-only graph-run fan-out may finish with no commit; reap marks that dropped_commit. */
export function isGraphRunChildSuccess(
	run: Pick<RunRow, "state" | "failureReason" | "trigger">,
): boolean {
	if (run.state === "succeeded") return true;
	return (
		run.trigger === "graph-run" && run.state === "failed" && run.failureReason === "dropped_commit"
	);
}

async function collectFindings(
	input: AdvanceGraphRunInput,
	children: readonly GraphRunChildRow[],
): Promise<GraphRunFindingJson[]> {
	const out: GraphRunFindingJson[] = [];
	for (const child of children) {
		if (child.state !== "succeeded" || child.runId === null) continue;
		const output = await input.readRunOutput(child.runId);
		out.push(...parseFindings(output));
	}
	return out;
}

export function parseFindings(output: string): GraphRunFindingJson[] {
	const trimmed = output.trim();
	if (trimmed === "") return [];
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter(isFinding);
		}
	} catch {
		// fall through to bracket scan
	}
	const start = trimmed.indexOf("[");
	const end = trimmed.lastIndexOf("]");
	if (start >= 0 && end > start) {
		try {
			const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter(isFinding);
			}
		} catch {
			return [];
		}
	}
	return [];
}

function isFinding(value: unknown): value is GraphRunFindingJson {
	if (value === null || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return typeof record.file === "string" && typeof record.claim === "string";
}

function buildFanOutPrompt(graphRun: GraphRunRow, filePath: string): string {
	const seedSuffix =
		graphRun.scopeJson.seedId !== undefined ? `\nWork on seed ${graphRun.scopeJson.seedId}.` : "";
	if (graphRun.template === "security-sweep") {
		return `Audit ${filePath} for missing auth checks on mutating routes.\nOutput: JSON array of findings [{file, line, route, claim, evidence}].\nDo not fix — report only.${seedSuffix}`;
	}
	return `Analyze ${filePath} using template ${graphRun.template}. Output JSON array of findings [{file, line, route, claim, evidence}].${seedSuffix}`;
}

function buildVerifyPrompt(finding: GraphRunFindingJson): string {
	return `Finding: ${JSON.stringify(finding)}\nCriterion: route handler calls auth middleware or documents public exemption.\nAnswer true only if finding is confirmed by reading the file.\nOutput: true or false only.`;
}

function buildSynthesizePrompt(findings: readonly GraphRunFindingJson[]): string {
	return `Read verified findings below. Produce a verified-finding report and mint fix seeds for confirmed hits only.\nFindings: ${JSON.stringify(findings)}`;
}

async function failGraphRun(
	input: AdvanceGraphRunInput & { readonly graphRun: GraphRunRow; readonly nowFn: () => Date },
	reason: string,
): Promise<AdvanceGraphRunResult> {
	const endedAt = input.nowFn().toISOString();
	await input.repos.graphRuns.transitionTo(input.graphRun.id, "failed", {
		endedAt,
		failureReason: reason,
	});
	const anchor = mostRecentRunId(await input.repos.graphRuns.listChildren(input.graphRun.id));
	if (anchor !== null) {
		await input.emit(anchor, "graph_run.failed", { graphRunId: input.graphRun.id, reason });
	}
	return { kind: "graph_run_failed", reason };
}

function mostRecentRunId(children: readonly GraphRunChildRow[]): string | null {
	for (let i = children.length - 1; i >= 0; i -= 1) {
		const child = children[i];
		if (child !== undefined && child.runId !== null) return child.runId;
	}
	return null;
}

function isRunTerminal(state: string): state is RunTerminalState {
	return (RUN_TERMINAL_STATES as readonly string[]).includes(state);
}
