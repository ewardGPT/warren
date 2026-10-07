/**
 * Best-of contested lane core (ubuntu-3de1 / TTC roadmap 4).
 *
 * For a high-risk piece of work, run N competing replicates and let
 * measurement pick the winner. Every replicate is a normal run; the
 * scorecard they produce at reap (ubuntu-c929) is the only judge — no LLM
 * verdict on the outputs. The ranking is deterministic: real committed work
 * beats an empty success, which beats a failure; within a tier, more
 * commits ahead first, then lower cost, then run id.
 *
 * The collector spawns the replicates with a per-approach prompt mutation
 * and optional model-tier rotation, polls each run's scorecard until
 * terminal or the deadline, and returns the ranked table. Runs keep their
 * branches; the operator reviews the winner's PR and closes the rest —
 * v1 deliberately ships no auto-merge.
 */

import type { RunScorecard } from "./reap/scorecard.ts";

export const BEST_OF_TRIGGER = "best_of_contest";
export const BEST_OF_MIN_REPLICATES = 2;
export const BEST_OF_MAX_REPLICATES = 5;
export const BEST_OF_DEFAULT_POLL_MS = 10_000;
export const BEST_OF_DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

export interface BestOfRunFacts {
	readonly runId: string;
	readonly scorecard: RunScorecard;
}

/** Relevance tier: 2 = real work, 1 = empty success, 0 = failed. */
function tierOf(scorecard: RunScorecard): number {
	if (
		scorecard.outcome === "succeeded" &&
		!scorecard.noChanges &&
		(scorecard.commitsAhead ?? 0) > 0
	) {
		return 2;
	}
	if (scorecard.outcome === "succeeded") return 1;
	return 0;
}

/**
 * Rank finished replicates best-first. The winner is the first entry; an
 * all-failed batch still yields a best-failed pick so the operator sees the
 * least-wrong branch. Pure and deterministic.
 */
export function rankBestOf(runs: readonly BestOfRunFacts[]): BestOfRunFacts[] {
	return [...runs].sort((a, b) => {
		const tier = tierOf(b.scorecard) - tierOf(a.scorecard);
		if (tier !== 0) return tier;
		const ahead = (b.scorecard.commitsAhead ?? -1) - (a.scorecard.commitsAhead ?? -1);
		if (ahead !== 0) return ahead;
		const cost =
			(a.scorecard.costUsd ?? Number.POSITIVE_INFINITY) -
			(b.scorecard.costUsd ?? Number.POSITIVE_INFINITY);
		if (cost !== 0) return cost;
		return a.runId < b.runId ? -1 : 1;
	});
}

export interface BestOfSpawnInput {
	readonly agentName: string;
	readonly projectId: string;
	readonly prompt: string;
	readonly trigger: string;
	readonly seedId?: string;
	readonly modelOverride?: string;
}

export interface BestOfCollectDeps {
	readonly spawn: (input: BestOfSpawnInput) => Promise<string>;
	/** The run's verified scorecard, or null while it is still running. */
	readonly scorecard: (runId: string) => Promise<RunScorecard | null>;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly now?: () => number;
	readonly pollMs?: number;
	readonly deadlineMs?: number;
}

export interface BestOfCollectInput {
	readonly projectId: string;
	readonly agentName: string;
	readonly prompt: string;
	readonly seedId?: string;
	readonly replicates: number;
	/** Per-replicate model overrides; cycled when fewer than replicates. */
	readonly tiers?: readonly (string | undefined)[];
}

export interface BestOfCollectResult {
	readonly ranked: readonly BestOfRunFacts[];
	/** Runs that never reached a scorecard before the deadline. */
	readonly pendingRunIds: readonly string[];
	readonly winner: BestOfRunFacts | null;
}

/** Spawn one replicate with the per-approach prompt mutation and tier. */
async function spawnReplicate(
	index: number,
	input: BestOfCollectInput,
	spawn: BestOfCollectDeps["spawn"],
): Promise<string> {
	const tier = input.tiers?.[index % input.tiers.length];
	return spawn({
		agentName: input.agentName,
		projectId: input.projectId,
		prompt: [
			input.prompt,
			`Approach ${index + 1} of ${input.replicates}: deliberately differ from the other approaches when choosing strategy, structure, and trade-offs.`,
		].join("\n\n"),
		trigger: BEST_OF_TRIGGER,
		...(input.seedId !== undefined && input.seedId !== "" ? { seedId: input.seedId } : {}),
		...(tier !== undefined ? { modelOverride: tier } : {}),
	});
}

/** Poll until every scorecard is present or the deadline passes. */
async function waitForScorecards(
	runIds: ReadonlySet<string>,
	deps: BestOfCollectDeps,
	now: () => number,
	pollMs: number,
	deadlineMs: number,
): Promise<{ finished: BestOfRunFacts[]; pending: readonly string[] }> {
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const pending = new Set(runIds);
	const finished: BestOfRunFacts[] = [];
	const deadline = now() + deadlineMs;
	while (pending.size > 0) {
		const stillPending = new Set<string>();
		for (const runId of pending) {
			const scorecard = await deps.scorecard(runId);
			if (scorecard === null) stillPending.add(runId);
			else finished.push({ runId, scorecard });
		}
		const next = [...stillPending];
		pending.clear();
		for (const runId of next) pending.add(runId);
		if (pending.size === 0) break;
		if (now() >= deadline) break;
		await sleep(pollMs);
	}
	return { finished, pending: [...pending] };
}

/**
 * Spawn the replicate set, poll every run's scorecard until all are
 * terminal or the deadline passes, and rank the finished ones. Runs that
 * stay unfinished at the deadline are reported, not killed — the operator
 * decides their fate.
 */
export async function collectBestOf(
	input: BestOfCollectInput,
	deps: BestOfCollectDeps,
): Promise<BestOfCollectResult> {
	if (input.replicates < BEST_OF_MIN_REPLICATES || input.replicates > BEST_OF_MAX_REPLICATES) {
		throw new RangeError(
			`replicates must be between ${BEST_OF_MIN_REPLICATES} and ${BEST_OF_MAX_REPLICATES}`,
		);
	}
	const runIds = new Set<string>();
	for (let index = 0; index < input.replicates; index += 1) {
		runIds.add(await spawnReplicate(index, input, deps.spawn));
	}
	const { finished, pending } = await waitForScorecards(
		runIds,
		deps,
		deps.now ?? Date.now,
		deps.pollMs ?? BEST_OF_DEFAULT_POLL_MS,
		deps.deadlineMs ?? BEST_OF_DEFAULT_DEADLINE_MS,
	);
	const ranked = rankBestOf(finished);
	return { ranked, pendingRunIds: pending, winner: ranked[0] ?? null };
}
