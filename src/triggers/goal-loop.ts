/**
 * Goal + loop trigger dispatch (warren-goal / warren-loop).
 *
 * Goal (warren-goal): run-until-condition. Spawns the agent, then checks the
 * stop condition after each run until it holds or maxRuns is reached. The
 * stop check is a separate model call — the agent that did the work does not
 * grade its own completion (loop-engineering maker≠checker).
 *
 * Loop (warren-loop): fixed-cadence trigger with an iteration cap. Runs on a
 * cron schedule like a cron trigger but tracks iteration count on the seed
 * and stops after maxIterations.
 */

import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { GoalTrigger, LoopTrigger } from "../warren-config/schema.ts";
import { parseCron } from "./cron.ts";
import type { DispatchSpawnFn } from "./dispatch.ts";

export interface DispatchGoalInput {
	readonly projectId: string;
	readonly trigger: GoalTrigger;
	readonly now: Date;
	readonly spawn: DispatchSpawnFn;
	readonly repos?: Pick<Repos, "triggers" | "runs" | "events">;
	/** Test seam — defaults to fetch-based LLM completion check. */
	readonly checkStop?: (stopPrompt: string, runOutput: string) => Promise<boolean>;
}

export type DispatchGoalResult =
	| { readonly kind: "spawned"; readonly runId: string }
	| { readonly kind: "spawn_failed"; readonly reason: string }
	| { readonly kind: "skipped_no_seed" }
	| { readonly kind: "waiting_for_run"; readonly runId: string }
	| { readonly kind: "completed" }
	| { readonly kind: "max_runs_reached" }
	| { readonly kind: "stop_check_failed"; readonly reason: string };

export async function dispatchGoalTrigger(input: DispatchGoalInput): Promise<DispatchGoalResult> {
	const seed = input.trigger.seed;
	if (seed === undefined) {
		// Goal triggers need a seed to attach iteration state to.
		return { kind: "skipped_no_seed" };
	}
	const stateResult = await evaluateGoalState(input);
	if (stateResult !== null) return stateResult;
	const prompt =
		input.trigger.prompt ??
		`Work toward the goal until this condition holds: ${input.trigger.stopPrompt ?? "done"}`;
	try {
		const result = await input.spawn({
			agentName: input.trigger.role,
			projectId: input.projectId,
			prompt,
			trigger: "goal",
			...(input.trigger.maxCostUsd !== undefined ? { maxCostUsd: input.trigger.maxCostUsd } : {}),
			...(seed !== undefined ? { metadata: { seedId: seed } } : {}),
		});
		if (input.repos !== undefined) {
			await input.repos.triggers.recordFire({
				projectId: input.projectId,
				triggerId: input.trigger.id,
				firedAt: input.now,
				nextFireAt: null,
				runId: result.runId,
			});
		}
		return { kind: "spawned", runId: result.runId };
	} catch (err) {
		return { kind: "spawn_failed", reason: formatError(err) };
	}
}

export interface DispatchLoopInput {
	readonly projectId: string;
	readonly trigger: LoopTrigger;
	readonly now: Date;
	readonly spawn: DispatchSpawnFn;
	/** How many iterations this loop trigger has already run (from seed). */
	readonly iterationsRun: number;
	readonly repos?: Pick<Repos, "triggers">;
}

export type DispatchLoopResult =
	| { readonly kind: "spawned"; readonly runId: string }
	| { readonly kind: "iteration_cap_reached" }
	| { readonly kind: "skipped_no_seed" }
	| { readonly kind: "not_due" }
	| { readonly kind: "spawn_failed"; readonly reason: string };

export async function dispatchLoopTrigger(input: DispatchLoopInput): Promise<DispatchLoopResult> {
	if (input.iterationsRun >= input.trigger.maxIterations) {
		return { kind: "iteration_cap_reached" };
	}
	const seed = input.trigger.seed;
	if (seed === undefined) {
		return { kind: "skipped_no_seed" };
	}
	const cadenceResult = await evaluateLoopCadence(input);
	if (cadenceResult !== null) return cadenceResult;
	try {
		const result = await input.spawn({
			agentName: input.trigger.role,
			projectId: input.projectId,
			prompt: input.trigger.prompt ?? "",
			trigger: "loop",
			...(input.trigger.maxCostUsd !== undefined ? { maxCostUsd: input.trigger.maxCostUsd } : {}),
			...(seed !== undefined ? { metadata: { seedId: seed } } : {}),
		});
		if (input.repos !== undefined) {
			await input.repos.triggers.recordFire({
				projectId: input.projectId,
				triggerId: input.trigger.id,
				firedAt: input.now,
				nextFireAt: null,
				runId: result.runId,
			});
		}
		return { kind: "spawned", runId: result.runId };
	} catch (err) {
		return { kind: "spawn_failed", reason: formatError(err) };
	}
}

async function evaluateGoalState(input: DispatchGoalInput): Promise<DispatchGoalResult | null> {
	if (input.repos === undefined) return null;
	const key = { projectId: input.projectId, triggerId: input.trigger.id };
	const state = await input.repos.triggers.get(key);
	if (state?.completedAt !== null && state?.completedAt !== undefined) {
		return { kind: "completed" };
	}
	if ((state?.fireCount ?? 0) >= input.trigger.maxRuns) return { kind: "max_runs_reached" };
	if (state?.lastRunId === null || state?.lastRunId === undefined) return null;
	const previous = await input.repos.runs.get(state.lastRunId);
	if (previous !== null && (previous.state === "queued" || previous.state === "running")) {
		return { kind: "waiting_for_run", runId: previous.id };
	}
	if (previous?.state !== "succeeded") return null;
	try {
		const output = await readRunOutput(input.repos.events, previous.id);
		const check = await (input.checkStop ?? defaultStopCheck)(
			input.trigger.stopPrompt ?? "done",
			output,
		);
		if (!check) return null;
		await input.repos.triggers.markCompleted(key, input.now);
		return { kind: "completed" };
	} catch (err) {
		return { kind: "stop_check_failed", reason: formatError(err) };
	}
}

async function evaluateLoopCadence(input: DispatchLoopInput): Promise<DispatchLoopResult | null> {
	if (input.repos === undefined) return null;
	const parsed = parseCron({
		expression: input.trigger.cron,
		...(input.trigger.timezone !== undefined ? { timezone: input.trigger.timezone } : {}),
	});
	if (!parsed.ok) return { kind: "spawn_failed", reason: `cron parse failed: ${parsed.message}` };
	const key = { projectId: input.projectId, triggerId: input.trigger.id };
	const row = await input.repos.triggers.get(key);
	const nextFireAt = parsed.cron.nextRun(input.now);
	if (row === null || row.lastFiredAt === null) {
		await input.repos.triggers.upsert({
			...key,
			lastFiredAt: input.now.toISOString(),
			nextFireAt: nextFireAt?.toISOString() ?? null,
		});
		return { kind: "not_due" };
	}
	const previous = parsed.cron.previousRun(input.now);
	if (previous === null || previous <= new Date(row.lastFiredAt)) return { kind: "not_due" };
	return null;
}

/** Default stop-condition check: LLM answers "does the output satisfy the goal?" */
export async function defaultStopCheck(stopPrompt: string, runOutput: string): Promise<boolean> {
	const endpoint = process.env.WARREN_STOP_CHECK_URL;
	const model = process.env.WARREN_STOP_CHECK_MODEL ?? "claude-haiku-4-5";
	if (endpoint === undefined) return false;
	const apiKey = process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "";
	const body = JSON.stringify({
		model,
		messages: [
			{
				role: "system",
				content: `You verify whether a goal condition is met. Answer only true or false.\nCondition: ${stopPrompt}`,
			},
			{ role: "user", content: runOutput.slice(0, 4000) },
		],
		max_tokens: 4,
	});
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(apiKey !== "" ? { authorization: `Bearer ${apiKey}` } : {}),
		},
		body,
	});
	if (!response.ok) return false;
	const data = (await response.json()) as {
		content?: { text?: string }[];
		choices?: { message?: { content?: string | null } }[];
	};
	const text = extractStopCheckText(data);
	return text.trim().toLowerCase() === "true";
}

function extractStopCheckText(data: {
	content?: { text?: string }[];
	choices?: { message?: { content?: string | null } }[];
}): string {
	const anthropic = data.content?.[0]?.text;
	if (typeof anthropic === "string") return anthropic;
	const openai = data.choices?.[0]?.message?.content;
	if (typeof openai === "string") return openai;
	return "";
}

async function readRunOutput(
	events: Pick<Repos["events"], "listTail">,
	runId: string,
): Promise<string> {
	const rows = await events.listTail(runId, 200);
	return rows
		.map((row) => extractText(row.payloadJson))
		.filter((text): text is string => text !== null)
		.join("\n")
		.slice(-12_000);
}

function extractText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	for (const key of ["text", "content", "output", "message"]) {
		const candidate = record[key];
		if (typeof candidate === "string") return candidate;
	}
	return null;
}
