/**
 * `warren best-of <agent> <project> -p "..." --replicates N` — contest N
 * competing implementations of one prompt and rank them by their verified
 * scorecards (ubuntu-3de1). In-process, mirroring `warren run`: the same
 * repos + runtime backend drive spawnRun for every replicate, and the
 * scorecard reader walks each run's persisted `run.scorecard` event so
 * only executed, reaped facts decide the ranking.
 *
 * Exit codes: 0 = at least one replicate ranked; 3 = some replicates were
 * still running at the deadline; 4 = none finished.
 */

import type { Repos } from "../../db/repos/index.ts";
import { type BestOfCollectResult, collectBestOf } from "../../runs/best-of.ts";
import { spawnRun } from "../../runs/index.ts";
import type { RunScorecard } from "../../runs/reap/scorecard.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { CliContext } from "../output.ts";
import { writeJsonLine } from "../output.ts";

export interface BestOfArgs {
	readonly agent: string;
	readonly project: string;
	readonly prompt: string;
	readonly seedId?: string;
	readonly replicates: number;
	readonly tiers?: string[];
}

export interface BestOfDeps {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
}

export interface BestOfCommandResult {
	readonly exitCode: number;
	readonly winnerRunId: string | null;
}

async function readScorecard(repos: Repos, runId: string): Promise<RunScorecard | null> {
	const events = await repos.events.listByRun(runId);
	for (let i = events.length - 1; i >= 0; i -= 1) {
		if (events[i]?.kind === "run.scorecard") {
			return events[i]?.payloadJson as RunScorecard | null;
		}
	}
	return null;
}

function renderTable(context: CliContext, result: BestOfCollectResult): void {
	for (const [index, run] of result.ranked.entries()) {
		context.stdio.stdout.write(
			`${index + 1}. ${run.runId}  ${run.scorecard.outcome}${
				run.scorecard.failureReason !== null ? `/${run.scorecard.failureReason}` : ""
			}  commits=${run.scorecard.commitsAhead ?? "-"}  cost=${run.scorecard.costUsd ?? "-"}\n`,
		);
	}
	if (result.winner !== null) {
		context.stdio.stdout.write(`winner: ${result.winner.runId}\n`);
	} else {
		context.stdio.stdout.write("winner: none\n");
	}
	if (result.pendingRunIds.length > 0) {
		context.stdio.stdout.write(`still running at deadline: ${result.pendingRunIds.join(", ")}\n`);
	}
}

/** Run the best-of contest and print the ranked table. */
export async function runBestOf(
	context: CliContext,
	deps: BestOfDeps,
	args: BestOfArgs,
): Promise<BestOfCommandResult> {
	const result = await collectBestOf(
		{
			projectId: args.project,
			agentName: args.agent,
			prompt: args.prompt,
			...(args.seedId !== undefined && args.seedId !== "" ? { seedId: args.seedId } : {}),
			replicates: args.replicates,
			...(args.tiers !== undefined ? { tiers: args.tiers } : {}),
		},
		{
			spawn: async (input) => {
				const spawned = await spawnRun({
					repos: deps.repos,
					runtimeProvider: deps.runtimeProvider,
					agentName: input.agentName,
					projectId: input.projectId,
					prompt: input.prompt,
					trigger: input.trigger,
					...(input.seedId !== undefined ? { seedId: input.seedId } : {}),
					...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
				});
				return spawned.run.id;
			},
			scorecard: (runId) => readScorecard(deps.repos, runId),
		},
	);
	renderTable(context, result);
	writeJsonLine(context.stdio.stdout, {
		command: "best-of",
		ranked: result.ranked.map((run) => ({
			runId: run.runId,
			outcome: run.scorecard.outcome,
			failureReason: run.scorecard.failureReason,
			commitsAhead: run.scorecard.commitsAhead,
			costUsd: run.scorecard.costUsd,
		})),
		pendingRunIds: result.pendingRunIds,
		winnerRunId: result.winner?.runId ?? null,
	});
	if (result.ranked.length === 0) return { exitCode: 4, winnerRunId: null };
	if (result.pendingRunIds.length > 0) {
		return { exitCode: 3, winnerRunId: result.winner?.runId ?? null };
	}
	return { exitCode: 0, winnerRunId: result.winner?.runId ?? null };
}
