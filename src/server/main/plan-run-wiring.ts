import { join } from "node:path";
import {
	autoTransitionPlotToDone,
	bootPlanRunCoordinator,
	createPlanRunSpawn,
	createPrMergeChecker,
	createResolveExecution,
	defaultPlotStatusSetter,
	loadPlanRunCoordinatorConfigFromEnv,
} from "../../plan-runs/index.ts";
import { parseGitHubUrl } from "../../projects/index.ts";
import {
	composeRunBranch,
	resolveDispatcherHandle,
	resolveRunBranchPrefix,
} from "../../runs/index.ts";
import { buildPrContent, openPullRequest } from "../../runs/pr.ts";
import { showSeed } from "../../seeds-cli/index.ts";
import type { EnvLike } from "../config.ts";
import { planRunLoggerFromPino } from "./logging.ts";

type PlanRunSpawnArgs = Parameters<typeof createPlanRunSpawn>[0];
type Repos = Parameters<typeof createResolveExecution>[0];
type Logger = Parameters<typeof planRunLoggerFromPino>[0];
type AutoOpenPr = Parameters<typeof createPrMergeChecker>[0] & {
	enabled: boolean;
	warrenBaseUrl: string | null;
};

interface ReopenPrArgs {
	readonly repos: Repos;
	readonly warrenConfigs: PlanRunSpawnArgs["warrenConfigs"];
	readonly autoOpenPr: AutoOpenPr;
	readonly runBranchPrefixDefault: PlanRunSpawnArgs["runBranchPrefixDefault"];
	readonly logger: Logger;
}

async function reopenPlanRunPr(
	runId: string,
	{ repos, warrenConfigs, autoOpenPr, runBranchPrefixDefault, logger }: ReopenPrArgs,
): Promise<string | null> {
	try {
		const run = await repos.runs.get(runId);
		if (run === null || run.projectId === null) return null;
		const project = await repos.projects.get(run.projectId);
		if (project === null) return null;
		const warrenConfig = await warrenConfigs.get(run.projectId, project.localPath);
		const prefix = resolveRunBranchPrefix({
			projectDefault: warrenConfig.defaults?.runBranchPrefix,
			envDefault: runBranchPrefixDefault,
		});
		const content = buildPrContent({
			prompt: run.prompt,
			runId: run.id,
			agentName: run.agentName,
			...(run.startedAt !== null ? { startedAt: run.startedAt } : {}),
			...(run.endedAt !== null ? { endedAt: run.endedAt } : {}),
			...(run.costUsd !== null ? { costUsd: run.costUsd } : {}),
			...(run.tokensInput !== null ? { tokensInput: run.tokensInput } : {}),
			...(run.tokensOutput !== null ? { tokensOutput: run.tokensOutput } : {}),
			...(run.tokensCacheRead !== null ? { tokensCacheRead: run.tokensCacheRead } : {}),
			...(autoOpenPr.warrenBaseUrl !== null ? { warrenBaseUrl: autoOpenPr.warrenBaseUrl } : {}),
		});
		const parsed = parseGitHubUrl(project.gitUrl);
		const result = await openPullRequest({
			owner: parsed.owner,
			repo: parsed.name,
			head: composeRunBranch(prefix, runId),
			base: project.defaultBranch,
			title: content.title,
			body: content.body,
			token: autoOpenPr.token,
		});
		if (result.ok) return result.url;
		logger.warn(
			{ runId, reason: result.reason, message: result.message },
			"plan_run.reopen_pr_failed",
		);
		return null;
	} catch (err) {
		logger.warn(
			{ runId, reason: err instanceof Error ? err.message : String(err) },
			"plan_run.reopen_pr_error",
		);
		return null;
	}
}

export interface PlanRunCoordinatorWiringArgs {
	readonly env: EnvLike;
	readonly repos: Repos;
	readonly burrowClientPool: PlanRunSpawnArgs["burrowClientPool"];
	readonly bridges: PlanRunSpawnArgs["bridges"];
	readonly warrenConfigs: PlanRunSpawnArgs["warrenConfigs"];
	readonly projectsConfig: PlanRunSpawnArgs["projectsConfig"];
	readonly autoOpenPr: AutoOpenPr;
	readonly runBranchPrefixDefault: PlanRunSpawnArgs["runBranchPrefixDefault"];
	readonly seedsCli: PlanRunSpawnArgs["seedsCli"];
	readonly projectSpawn: PlanRunSpawnArgs["projectSpawn"];
	readonly logger: Logger;
	readonly now?: () => Date;
}

export function bootPlanRunCoordinatorWiring({
	env,
	repos,
	burrowClientPool,
	bridges,
	warrenConfigs,
	projectsConfig,
	autoOpenPr,
	runBranchPrefixDefault,
	seedsCli,
	projectSpawn,
	logger,
	now,
}: PlanRunCoordinatorWiringArgs): ReturnType<typeof bootPlanRunCoordinator> {
	const config = loadPlanRunCoordinatorConfigFromEnv(env);
	const coordinator = bootPlanRunCoordinator({
		repos,
		showSeed: async (projectId, seedId) => {
			const project = await repos.projects.require(projectId);
			return showSeed(seedsCli, project.localPath, seedId);
		},
		checkPrMerged: createPrMergeChecker({ token: autoOpenPr.token }),
		resolveExecution: createResolveExecution(repos),
		reopenPr:
			autoOpenPr.enabled && autoOpenPr.token !== ""
				? (runId) =>
						reopenPlanRunPr(runId, {
							repos,
							warrenConfigs,
							autoOpenPr,
							runBranchPrefixDefault,
							logger,
						})
				: undefined,
		spawn: createPlanRunSpawn({
			repos,
			burrowClientPool,
			bridges,
			warrenConfigs,
			projectsConfig,
			projectSpawn,
			seedsCli,
			...(runBranchPrefixDefault !== undefined ? { runBranchPrefixDefault } : {}),
			...(now !== undefined ? { now } : {}),
		}),
		transitionPlot: async (planRun) => {
			if (planRun.plotId === null) return { kind: "skipped", currentStatus: "unknown" };
			const project = await repos.projects.require(planRun.projectId);
			return autoTransitionPlotToDone({
				setter: defaultPlotStatusSetter,
				logger,
				plotDir: join(project.localPath, ".plot"),
				plotId: planRun.plotId,
				handle: resolveDispatcherHandle(planRun.dispatcherHandle),
				planRunId: planRun.id,
			});
		},
		tickMs: config.tickMs,
		disabled: config.disabled,
		mergeTimeoutMs: config.mergeTimeoutMs,
		logger: planRunLoggerFromPino(logger),
		...(now !== undefined ? { now } : {}),
	});
	if (config.disabled) {
		logger.info({}, "plan-run coordinator disabled via WARREN_PLAN_RUN_DISABLED");
	} else {
		logger.info({ tickMs: config.tickMs }, "plan-run coordinator running");
	}
	return coordinator;
}
