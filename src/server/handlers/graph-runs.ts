/**
 * GraphRun HTTP handlers (graph-engineering pilot).
 */

import { Glob } from "bun";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { GraphRunScopeJson } from "../../db/schema.ts";
import { loadGraphTemplate } from "../../graph-runs/templates.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { optionalString, readJsonBody, requireParam, requireString } from "./index.ts";

const DEFAULT_SCOPE_MAX = 20;

async function resolveScopeFiles(localPath: string, scope: GraphRunScopeJson): Promise<string[]> {
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

function parseScopeOverride(body: Record<string, unknown>): Partial<GraphRunScopeJson> | undefined {
	const scope = body.scope;
	if (scope === undefined) return undefined;
	if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
		throw new ValidationError("scope must be an object with optional glob, max, seedId");
	}
	const record = scope as Record<string, unknown>;
	const glob = optionalString(record, "glob");
	const maxRaw = record.max;
	let max: number | undefined;
	if (maxRaw !== undefined) {
		const parsed = Number(maxRaw);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			throw new ValidationError("scope.max must be a positive integer");
		}
		max = Math.trunc(parsed);
	}
	const seedId = optionalString(record, "seedId");
	return {
		...(glob !== undefined ? { glob } : {}),
		...(max !== undefined ? { max } : {}),
		...(seedId !== undefined ? { seedId } : {}),
	};
}

function parseBodyBoolean(
	body: Record<string, unknown>,
	key: string,
	defaultValue: boolean,
): boolean {
	const raw = body[key];
	if (raw === undefined) return defaultValue;
	if (typeof raw !== "boolean") {
		throw new ValidationError(`field '${key}' must be a boolean`);
	}
	return raw;
}

export function createGraphRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const body = await readJsonBody(ctx);
		const projectId = requireString(body, "project");
		const templateName = requireString(body, "template");

		const project = await deps.repos.projects.require(projectId);
		const loaded = await loadGraphTemplate(project.localPath, templateName);
		const agent = optionalString(body, "agent") ?? loaded.defaults.agent ?? "sapling";
		const bodyScope = parseScopeOverride(body);

		const verifyEnabled = parseBodyBoolean(body, "verify", loaded.defaults.verify);
		const synthesizeEnabled = parseBodyBoolean(body, "synthesize", loaded.defaults.synthesize);
		const scope: GraphRunScopeJson = {
			...loaded.scope,
			...(bodyScope ?? {}),
			max: bodyScope?.max ?? loaded.scope.max ?? loaded.defaults.maxFanOut,
			...(loaded.synthesizePrompt !== undefined
				? { synthesizePrompt: loaded.synthesizePrompt }
				: {}),
		};

		await deps.repos.agents.resolve(agent, { projectId });

		const files = await resolveScopeFiles(project.localPath, scope);
		if (files.length === 0) {
			throw new ValidationError(`scope matched no files: glob=${scope.glob}`, {
				recoveryHint: "check the glob path relative to the project clone root",
			});
		}

		const { graphRun, children } = await deps.repos.graphRuns.create({
			projectId: project.id,
			template: templateName,
			agentName: agent,
			scopeJson: scope,
			verifyEnabled,
			synthesizeEnabled,
			children: files.map((filePath, idx) => ({
				seq: idx + 1,
				phase: "fan_out" as const,
				filePath,
			})),
		});

		return jsonResponse(201, { graphRun, children });
	};
}

export function getGraphRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const graphRun = await deps.repos.graphRuns.getById(id);
		if (graphRun === null) {
			throw new NotFoundError(`graph_run not found: ${id}`);
		}
		const children = await deps.repos.graphRuns.listChildren(id);
		return jsonResponse(200, { graphRun, children });
	};
}
