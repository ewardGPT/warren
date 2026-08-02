/**
 * Create a GraphRun row + fan_out children from a declarative template.
 */

import { Glob } from "bun";
import { ValidationError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import type { GraphRunRow, GraphRunScopeJson } from "../db/schema.ts";
import { loadGraphTemplate, type GraphTemplate } from "./templates.ts";

const DEFAULT_SCOPE_MAX = 20;

export async function resolveScopeFiles(
	localPath: string,
	scope: GraphRunScopeJson,
): Promise<string[]> {
	const glob = new Glob(scope.glob);
	const files: string[] = [];
	for await (const rel of glob.scan({ cwd: localPath, onlyFiles: true })) {
		if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
		files.push(rel);
	}
	files.sort();
	const max = scope.max ?? DEFAULT_SCOPE_MAX;
	return files.slice(0, max);
}

export interface CreateGraphRunFromTemplateInput {
	readonly repos: Pick<Repos, "graphRuns" | "agents" | "projects">;
	readonly projectId: string;
	readonly templateName: string;
	readonly agent?: string;
	readonly scopeOverride?: Partial<GraphRunScopeJson>;
	readonly verify?: boolean;
	readonly synthesize?: boolean;
	readonly now?: Date;
}

export interface CreateGraphRunFromTemplateResult {
	readonly graphRun: GraphRunRow;
	readonly template: GraphTemplate;
	readonly files: readonly string[];
}

export async function createGraphRunFromTemplate(
	input: CreateGraphRunFromTemplateInput,
): Promise<CreateGraphRunFromTemplateResult> {
	const project = await input.repos.projects.require(input.projectId);
	const loaded = await loadGraphTemplate(project.localPath, input.templateName);
	const agent = input.agent ?? loaded.defaults.agent ?? "sapling";

	const verifyEnabled = input.verify ?? loaded.defaults.verify;
	const synthesizeEnabled = input.synthesize ?? loaded.defaults.synthesize;
	const scope: GraphRunScopeJson = {
		...loaded.scope,
		...(input.scopeOverride ?? {}),
		max: input.scopeOverride?.max ?? loaded.scope.max ?? loaded.defaults.maxFanOut,
		...(loaded.synthesizePrompt !== undefined
			? { synthesizePrompt: loaded.synthesizePrompt }
			: {}),
	};

	await input.repos.agents.resolve(agent, { projectId: input.projectId });

	const files = await resolveScopeFiles(project.localPath, scope);
	if (files.length === 0) {
		throw new ValidationError(`scope matched no files: glob=${scope.glob}`, {
			recoveryHint: "check the glob path relative to the project clone root",
		});
	}

	const { graphRun } = await input.repos.graphRuns.create({
		projectId: project.id,
		template: input.templateName,
		agentName: agent,
		scopeJson: scope,
		verifyEnabled,
		synthesizeEnabled,
		children: files.map((filePath, idx) => ({
			seq: idx + 1,
			phase: "fan_out" as const,
			filePath,
		})),
		...(input.now !== undefined ? { now: input.now } : {}),
	});

	return { graphRun, template: loaded, files };
}
