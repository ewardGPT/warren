/**
 * `warren seed-drain <seed-id>` — dispatch a run for one seed, wait for its
 * pull request, and close the seed once that PR merges (ubuntu-6ab8).
 *
 * In-process, mirroring `warren run` and `warren best-of`: the same repos and
 * runtime backend drive `spawnRun`, the run row is read back from the DB while
 * waiting, and the merge state comes from the GitHub REST check the plan-run
 * coordinator already uses. The seed's home project is resolved from the seed,
 * so the operator passes one id and nothing else.
 *
 * Exit codes: 0 = the PR merged and the seed is closed (or was already);
 * 1 = the run failed, was cancelled, or the wait timed out; 2 = the lane
 * refused the seed (closed, blocked, unknown, or a project without `.seeds/`);
 * 3 = the run succeeded with no pull request, or its PR closed unmerged — the
 * seed stays open for the operator.
 */

import type { Repos } from "../../db/repos/index.ts";
import { createPrMergeChecker } from "../../plan-runs/pr-merge.ts";
import type { SpawnFn } from "../../projects/clone.ts";
import { loadProjectsConfigFromEnv, type ProjectsConfig } from "../../projects/config.ts";
import {
	type DrainSeedResult,
	drainSeed,
	type SeedDrainMergeState,
	SeedDrainRefusedError,
} from "../../runs/index.ts";
import type { RuntimeProvider } from "../../runtime/contract.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { CliContext } from "../output.ts";
import { defaultSpawn, formatError, writeJsonLine } from "../output.ts";

export interface SeedDrainArgs {
	readonly seedId: string;
	readonly agent: string;
	/** Optional home project; the seed resolves it when absent. */
	readonly project?: string;
	readonly prompt?: string;
	readonly model?: string;
	readonly provider?: string;
	/** Wait budget in ms; `0` disables the bound. */
	readonly timeoutMs?: number;
	readonly pollMs?: number;
}

export interface SeedDrainDeps {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly seedsCli: SeedsCliDeps;
	readonly projectsConfig?: ProjectsConfig;
	readonly projectSpawn?: SpawnFn;
	readonly githubToken?: string;
	readonly gitBinary?: string;
	/** Test seam — replaces the live end-to-end `drainSeed`. */
	readonly drain?: typeof drainSeed;
}

export interface SeedDrainCommandResult {
	readonly exitCode: number;
	readonly runId: string | null;
}

/** Map a settled drain onto the command's exit code. */
function exitCodeFor(result: DrainSeedResult): number {
	switch (result.outcome.kind) {
		case "merged":
			return 0;
		case "run_failed":
		case "run_cancelled":
		case "timed_out":
		case "run_missing":
			return 1;
		case "run_succeeded_no_pr":
		case "pr_closed_unmerged":
			return 3;
	}
}

/**
 * Build the PR-merge reader the wait seam consumes. Without a GitHub token the
 * wait reports `unknown`, which is honest: the lane cannot see the merge, so it
 * runs to the wait budget instead of inventing a verdict.
 */
function makeMergeState(
	githubToken: string | undefined,
): ((prUrl: string) => Promise<SeedDrainMergeState>) | undefined {
	if (githubToken === undefined || githubToken === "") return undefined;
	const checker = createPrMergeChecker({ token: githubToken });
	return async (prUrl) => {
		const result = await checker(prUrl);
		switch (result.kind) {
			case "merged":
				return "merged";
			case "open":
				return "open";
			case "closed_unmerged":
				return "closed_unmerged";
			default:
				return "unknown";
		}
	};
}

/** Assemble the end-to-end `drainSeed` input from the parsed arguments. */
function drainInput(deps: SeedDrainDeps, args: SeedDrainArgs, projectsConfig: ProjectsConfig) {
	const projectSpawn = deps.projectSpawn ?? defaultSpawn;
	const mergeState = makeMergeState(deps.githubToken);
	return {
		repos: deps.repos,
		runtimeProvider: deps.runtimeProvider,
		seedsCli: deps.seedsCli,
		agentName: args.agent,
		seedId: args.seedId,
		...(args.project !== undefined ? { projectId: args.project } : {}),
		...(args.prompt !== undefined ? { promptTemplate: args.prompt } : {}),
		...(args.model !== undefined ? { modelOverride: args.model } : {}),
		...(args.provider !== undefined ? { providerOverride: args.provider } : {}),
		...(deps.githubToken !== undefined ? { githubToken: deps.githubToken } : {}),
		projectsConfig,
		projectSpawn,
		wait: {
			...(args.pollMs !== undefined ? { pollMs: args.pollMs } : {}),
			...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
			...(mergeState !== undefined ? { mergeState } : {}),
		},
		closure: {
			spawn: projectSpawn,
			gitBinary: deps.gitBinary ?? projectsConfig.gitBinary,
			...(deps.githubToken !== undefined ? { githubToken: deps.githubToken } : {}),
		},
	} satisfies Parameters<typeof drainSeed>[0];
}

/** Dispatch, wait, close, and report one seed drain. */
export async function runSeedDrain(
	context: CliContext,
	deps: SeedDrainDeps,
	args: SeedDrainArgs,
): Promise<SeedDrainCommandResult> {
	if (args.seedId === "" || args.agent === "") {
		context.stdio.stderr.write("warren: seed id and --agent are both required\n");
		return { exitCode: 2, runId: null };
	}

	const projectsConfig = deps.projectsConfig ?? loadProjectsConfigFromEnv(context.env);
	const drain = deps.drain ?? drainSeed;

	let result: DrainSeedResult;
	try {
		result = await drain(drainInput(deps, args, projectsConfig));
	} catch (err) {
		if (err instanceof SeedDrainRefusedError) {
			context.stdio.stderr.write(`warren: refusing seed ${args.seedId}: ${err.message}\n`);
			return { exitCode: 2, runId: null };
		}
		context.stdio.stderr.write(`warren: ${formatError(err)}\n`);
		return { exitCode: 1, runId: null };
	}

	writeJsonLine(context.stdio.stdout, {
		event: "seed.drained",
		seedId: result.seed.seedId,
		projectId: result.seed.projectId,
		runId: result.runId,
		agent: args.agent,
		outcome: result.outcome.kind,
		state: result.outcome.state,
		failureReason: result.outcome.failureReason,
		prUrl: result.outcome.prUrl,
		waitedMs: result.outcome.waitedMs,
		closure: result.closure.kind,
	});
	if (result.outcome.kind !== "merged") {
		context.stdio.stderr.write(`${result.outcome.detail}\n`);
	}
	return { exitCode: exitCodeFor(result), runId: result.runId };
}
