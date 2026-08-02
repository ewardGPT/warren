/**
 * GraphRun HTTP handlers (graph-engineering pilot).
 */

import { NotFoundError, ValidationError } from "../../core/errors.ts";
import type { GraphRunScopeJson } from "../../db/schema.ts";
import { createGraphRunFromTemplate } from "../../graph-runs/create-from-template.ts";
import { loadGraphTemplate } from "../../graph-runs/templates.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { optionalString, readJsonBody, requireParam, requireString } from "./index.ts";

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
		const bodyScope = parseScopeOverride(body);

		const project = await deps.repos.projects.require(projectId);
		const loaded = await loadGraphTemplate(project.localPath, templateName);
		const agent = optionalString(body, "agent") ?? loaded.defaults.agent ?? "sapling";
		const verifyEnabled = parseBodyBoolean(body, "verify", loaded.defaults.verify);
		const synthesizeEnabled = parseBodyBoolean(body, "synthesize", loaded.defaults.synthesize);

		const { graphRun } = await createGraphRunFromTemplate({
			repos: deps.repos,
			projectId,
			templateName,
			agent,
			...(bodyScope !== undefined ? { scopeOverride: bodyScope } : {}),
			verify: verifyEnabled,
			synthesize: synthesizeEnabled,
		});

		const children = await deps.repos.graphRuns.listChildren(graphRun.id);
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
