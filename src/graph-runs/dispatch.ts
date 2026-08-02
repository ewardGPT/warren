/**
 * Spawn wrapper for the GraphRun coordinator.
 */

import type { BurrowClientPool } from "../burrow-client/pool.ts";
import type { Repos } from "../db/repos/index.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import { spawnRun } from "../runs/index.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { BridgeRegistry } from "../server/types.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import type { CoordinatorSpawnFn } from "./coordinator.ts";

export interface CreateGraphRunSpawnInput {
	readonly repos: Repos;
	readonly burrowClientPool: BurrowClientPool;
	readonly bridges: BridgeRegistry;
	readonly warrenConfigs: WarrenConfigCache;
	readonly projectsConfig: ProjectsConfig;
	readonly projectSpawn: SpawnFn;
	readonly seedsCli: SeedsCliDeps;
	readonly runBranchPrefixDefault?: string;
	readonly now?: () => Date;
	readonly spawnRunFn?: typeof spawnRun;
}

export function createGraphRunSpawn(input: CreateGraphRunSpawnInput): CoordinatorSpawnFn {
	const spawnRunFn = input.spawnRunFn ?? spawnRun;
	return async ({ graphRun, child, prompt, agentName, model }) => {
		const project = await input.repos.projects.require(graphRun.projectId);
		const result = await spawnRunFn({
			repos: input.repos,
			burrowClientPool: input.burrowClientPool,
			agentName: agentName ?? graphRun.agentName,
			projectId: graphRun.projectId,
			prompt,
			trigger: "graph-run",
			ref: project.defaultBranch,
			...(graphRun.scopeJson.seedId !== undefined ? { seedId: graphRun.scopeJson.seedId } : {}),
			...(model !== undefined ? { modelOverride: model } : {}),
			metadata: {
				graphRunId: graphRun.id,
				childId: child.id,
				phase: child.phase,
				...(child.filePath !== null ? { filePath: child.filePath } : {}),
			},
			projectsConfig: input.projectsConfig,
			projectSpawn: input.projectSpawn,
			warrenConfigs: input.warrenConfigs,
			seedsCli: input.seedsCli,
			dispatcherHandle: "operator",
			...(input.runBranchPrefixDefault !== undefined
				? { runBranchPrefixDefault: input.runBranchPrefixDefault }
				: {}),
			...(input.now !== undefined ? { now: input.now } : {}),
		});
		input.bridges.start(result.run.id, result.burrowRun.id, result.burrow.id);
		return { runId: result.run.id };
	};
}
