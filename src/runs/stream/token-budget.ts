import type { RunEvent } from "@os-eco/burrow-cli";
import type { Repos } from "../../db/repos/index.ts";
import type { RunEventBroker } from "../events.ts";
import { resolveTokenBudget, type TokenBudgetLedger } from "../token-budget.ts";
import type { BridgeLogger } from "./types.ts";

export async function resolveBridgeTokenBudget(
	repos: Pick<Repos, "runs">,
	runId: string,
	logger: BridgeLogger | undefined,
) {
	try {
		const run = await repos.runs.require(runId);
		return resolveTokenBudget(run.renderedAgentJson);
	} catch (err) {
		logger?.warn?.(
			{ runId, err: err instanceof Error ? err.message : String(err) },
			"failed to resolve token budget; proceeding without enforcement",
		);
		return null;
	}
}

export function tokenUsageDelta(
	event: RunEvent,
): { input: number; output: number; tool?: string; successful?: boolean } | null {
	if (event.kind !== "state_change" || event.stream !== "system") return null;
	if (event.payload === null || typeof event.payload !== "object") return null;
	const payload = event.payload as Record<string, unknown>;
	return payload.type === "turn_end" ? turnUsage(payload) : resultUsage(payload);
}

function turnUsage(payload: Record<string, unknown>) {
	if (payload.message === null || typeof payload.message !== "object") return null;
	const usage = (payload.message as Record<string, unknown>).usage;
	if (usage === null || typeof usage !== "object") return null;
	const u = usage as Record<string, unknown>;
	const tool = toolName(payload);
	return {
		input: numberOrZero(u.input),
		output: numberOrZero(u.output),
		...(tool !== undefined ? { tool } : {}),
	};
}

function resultUsage(payload: Record<string, unknown>) {
	if (payload.type !== "result" || payload.usage === null || typeof payload.usage !== "object")
		return null;
	const usage = payload.usage as Record<string, unknown>;
	return {
		input: numberOrZero(usage.input_tokens),
		output: numberOrZero(usage.output_tokens),
		successful: payload.is_error === true ? false : undefined,
	};
}

export async function emitTokenBudgetEvent(
	repos: Pick<Repos, "events">,
	broker: RunEventBroker,
	runId: string,
	decision: string,
	snapshot: ReturnType<TokenBudgetLedger["snapshot"]>,
): Promise<void> {
	const seq = ((await repos.events.maxSeqForRun(runId)) ?? 0) + 1;
	const row = await repos.events.append({
		runId,
		burrowEventSeq: seq,
		ts: new Date().toISOString(),
		kind: "budget.tokens_exceeded",
		stream: "system",
		payload: { decision, ...snapshot },
	});
	broker.publish(runId, row);
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function toolName(payload: Record<string, unknown>): string | undefined {
	for (const key of ["tool_name", "toolName", "name"]) {
		if (typeof payload[key] === "string" && payload[key] !== "") return payload[key] as string;
	}
	return undefined;
}
