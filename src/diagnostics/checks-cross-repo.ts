import type { ResolveTargetRepos } from "../projects/resolve-target.ts";
import { resolveTargetProject } from "../projects/resolve-target.ts";
import { listPlans, type SeedsCliDeps, showPlan, showSeed } from "../seeds-cli/index.ts";
import { readTargetRepo } from "../seeds-cli/warren-extensions.ts";
import type { DiagnosticCheck } from "./checks.ts";

export interface CrossRepoCheckProject {
	readonly id: string;
	readonly localPath: string;
	readonly gitUrl?: string;
	readonly hasSeeds?: boolean;
}

function isOpenPlan(status: string): boolean {
	return !["closed", "done", "archived"].includes(status.toLowerCase());
}

interface CrossRepoContext {
	readonly seedsCli: SeedsCliDeps;
	readonly repos: ResolveTargetRepos;
}

async function inspectPlan(
	project: CrossRepoCheckProject,
	planId: string,
	context: CrossRepoContext,
): Promise<string[]> {
	const plan = await showPlan(context.seedsCli, project.localPath, planId);
	const unresolved: string[] = [];
	for (const seedId of plan.children) {
		const seed = await showSeed(context.seedsCli, project.localPath, seedId);
		const repoRef = readTargetRepo(seed.extensions);
		if (repoRef === undefined) continue;
		try {
			await resolveTargetProject(context.repos, repoRef);
		} catch (err) {
			unresolved.push(
				`${project.id}/${plan.id}/${seedId}: ${repoRef} (${err instanceof Error ? err.message : String(err)})`,
			);
		}
	}
	return unresolved;
}

async function inspectProject(
	project: CrossRepoCheckProject,
	context: CrossRepoContext,
): Promise<{ unresolved: string[]; plansChecked: number }> {
	const plans = await listPlans(context.seedsCli, project.localPath);
	const openPlans = plans.filter((plan) => isOpenPlan(plan.status));
	const results = await Promise.all(
		openPlans.map((plan) => inspectPlan(project, plan.id, context)),
	);
	return { unresolved: results.flat(), plansChecked: openPlans.length };
}

/** Walk open plans and prove every explicit child repo target is registered. */
export async function checkCrossRepoPlanTargets(input: {
	readonly projects: readonly CrossRepoCheckProject[];
	readonly seedsCli?: SeedsCliDeps;
	readonly repos?: ResolveTargetRepos;
}): Promise<DiagnosticCheck> {
	if (input.seedsCli === undefined) {
		return {
			name: "cross_repo_plan_targets",
			ok: true,
			message: "seeds CLI not wired; cross-repo plan targets not inspected",
		};
	}
	const projects = input.projects.filter((project) => project.hasSeeds !== false);
	if (projects.length === 0) {
		return {
			name: "cross_repo_plan_targets",
			ok: true,
			message: "no seed-bearing projects registered",
		};
	}
	const registered = projects.filter((project) => project.gitUrl !== undefined);
	const context: CrossRepoContext = {
		seedsCli: input.seedsCli,
		repos:
			input.repos ??
			({ projects: { listAll: async () => registered } } as unknown as ResolveTargetRepos),
	};
	const results = await Promise.all(
		projects.map(async (project) => {
			try {
				return await inspectProject(project, context);
			} catch (err) {
				return {
					plansChecked: 0,
					unresolved: [`${project.id}: ${err instanceof Error ? err.message : String(err)}`],
				};
			}
		}),
	);
	const unresolved = results.flatMap((result) => result.unresolved);
	const plansChecked = results.reduce((total, result) => total + result.plansChecked, 0);
	if (unresolved.length > 0) {
		return {
			name: "cross_repo_plan_targets",
			ok: false,
			message: `${unresolved.length} unresolved target(s): ${unresolved.join("; ")}`,
			hint: "register each target repo in warren or correct the seed extensions.repo value",
		};
	}
	return {
		name: "cross_repo_plan_targets",
		ok: true,
		message: `${plansChecked} open plan(s) checked; all explicit repo targets resolve`,
	};
}
