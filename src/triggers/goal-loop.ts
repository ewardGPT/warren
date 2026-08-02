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
import type { GoalTrigger, LoopTrigger } from "../warren-config/schema.ts";
import type { DispatchSpawnFn } from "./dispatch.ts";

export interface DispatchGoalInput {
	readonly projectId: string;
	readonly trigger: GoalTrigger;
	readonly now: Date;
	readonly spawn: DispatchSpawnFn;
	/** Test seam — defaults to fetch-based LLM completion check. */
	readonly checkStop?: (stopPrompt: string, runOutput: string) => Promise<boolean>;
}

export type DispatchGoalResult =
	| { readonly kind: "spawned"; readonly runId: string }
	| { readonly kind: "spawn_failed"; readonly reason: string }
	| { readonly kind: "skipped_no_seed" };

export async function dispatchGoalTrigger(input: DispatchGoalInput): Promise<DispatchGoalResult> {
	const seed = input.trigger.seed;
	if (seed === undefined) {
		// Goal triggers need a seed to attach iteration state to.
		return { kind: "skipped_no_seed" };
	}
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
}

export type DispatchLoopResult =
	| { readonly kind: "spawned"; readonly runId: string }
	| { readonly kind: "iteration_cap_reached" }
	| { readonly kind: "skipped_no_seed" }
	| { readonly kind: "spawn_failed"; readonly reason: string };

export async function dispatchLoopTrigger(input: DispatchLoopInput): Promise<DispatchLoopResult> {
	if (input.iterationsRun >= input.trigger.maxIterations) {
		return { kind: "iteration_cap_reached" };
	}
	const seed = input.trigger.seed;
	if (seed === undefined) {
		return { kind: "skipped_no_seed" };
	}
	try {
		const result = await input.spawn({
			agentName: input.trigger.role,
			projectId: input.projectId,
			prompt: input.trigger.prompt ?? "",
			trigger: "loop",
			...(input.trigger.maxCostUsd !== undefined ? { maxCostUsd: input.trigger.maxCostUsd } : {}),
			...(seed !== undefined ? { metadata: { seedId: seed } } : {}),
		});
		return { kind: "spawned", runId: result.runId };
	} catch (err) {
		return { kind: "spawn_failed", reason: formatError(err) };
	}
}

/** Default stop-condition check: LLM answers "does the output satisfy the goal?" */
export async function defaultStopCheck(stopPrompt: string, runOutput: string): Promise<boolean> {
	const endpoint = process.env.WARREN_STOP_CHECK_URL;
	const model = process.env.WARREN_STOP_CHECK_MODEL ?? "claude-haiku-4-5";
	if (endpoint === undefined) return true;
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
		headers: { "content-type": "application/json" },
		body,
	});
	if (!response.ok) return false;
	const data = (await response.json()) as { content?: { text?: string }[] };
	const text = data.content?.[0]?.text ?? "";
	return text.trim().toLowerCase() === "true";
}
