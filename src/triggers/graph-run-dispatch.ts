/**
 * Cron-style dispatch for `kind: graph-run` triggers — creates a GraphRun
 * from a declarative template instead of spawning a single agent run.
 */

import { formatError } from "../core/errors.ts";
import type { Repos } from "../db/repos/index.ts";
import { createGraphRunFromTemplate } from "../graph-runs/create-from-template.ts";
import type { GraphRunTrigger } from "../warren-config/schema.ts";
import { parseCron } from "./cron.ts";

export interface DispatchGraphRunTriggerInput {
	readonly projectId: string;
	readonly trigger: GraphRunTrigger;
	readonly now: Date;
	readonly repos: Pick<Repos, "triggers" | "graphRuns" | "agents" | "projects">;
}

export type DispatchGraphRunTriggerResult =
	| {
			readonly kind: "fired";
			readonly graphRunId: string;
			readonly firedAt: Date;
			readonly nextFireAt: Date | null;
	  }
	| {
			readonly kind: "seeded";
			readonly nextFireAt: Date | null;
	  }
	| {
			readonly kind: "skipped";
			readonly nextFireAt: Date | null;
			readonly reason: string;
	  }
	| {
			readonly kind: "error";
			readonly reason: string;
			readonly permanent: boolean;
	  };

export async function dispatchGraphRunTrigger(
	input: DispatchGraphRunTriggerInput,
): Promise<DispatchGraphRunTriggerResult> {
	const parseInput: { expression: string; timezone?: string } = {
		expression: input.trigger.cron,
		...(input.trigger.timezone !== undefined ? { timezone: input.trigger.timezone } : {}),
	};
	const parsed = parseCron(parseInput);
	if (!parsed.ok) {
		return { kind: "error", reason: `cron parse failed: ${parsed.message}`, permanent: false };
	}

	const row = await input.repos.triggers.get({
		projectId: input.projectId,
		triggerId: input.trigger.id,
	});
	const nextFireAt = parsed.cron.nextRun(input.now);

	if (row === null || row.lastFiredAt === null) {
		await input.repos.triggers.upsert({
			projectId: input.projectId,
			triggerId: input.trigger.id,
			lastFiredAt: input.now.toISOString(),
			nextFireAt: nextFireAt?.toISOString() ?? null,
		});
		return { kind: "seeded", nextFireAt };
	}

	const last = new Date(row.lastFiredAt);
	const prev = parsed.cron.previousRun(input.now);
	if (prev === null || prev <= last) {
		await input.repos.triggers.upsert({
			projectId: input.projectId,
			triggerId: input.trigger.id,
			nextFireAt: nextFireAt?.toISOString() ?? null,
		});
		return {
			kind: "skipped",
			nextFireAt,
			reason: "no new cron slot since last fire",
		};
	}

	try {
		return await fireGraphRunFromTrigger(input, nextFireAt);
	} catch (err) {
		return { kind: "error", reason: formatError(err), permanent: false };
	}
}

async function fireGraphRunFromTrigger(
	input: DispatchGraphRunTriggerInput,
	nextFireAt: Date | null,
): Promise<Extract<DispatchGraphRunTriggerResult, { kind: "fired" }>> {
	const scopeOverride = {
		...(input.trigger.scope?.glob !== undefined ? { glob: input.trigger.scope.glob } : {}),
		...(input.trigger.scope?.max !== undefined ? { max: input.trigger.scope.max } : {}),
		...(input.trigger.seed !== undefined ? { seedId: input.trigger.seed } : {}),
	};
	const { graphRun } = await createGraphRunFromTemplate({
		repos: input.repos,
		projectId: input.projectId,
		templateName: input.trigger.template,
		...(input.trigger.agent !== undefined ? { agent: input.trigger.agent } : {}),
		...(Object.keys(scopeOverride).length > 0 ? { scopeOverride } : {}),
		...(input.trigger.verify !== undefined ? { verify: input.trigger.verify } : {}),
		...(input.trigger.synthesize !== undefined ? { synthesize: input.trigger.synthesize } : {}),
		now: input.now,
	});

	await input.repos.triggers.recordFire({
		projectId: input.projectId,
		triggerId: input.trigger.id,
		firedAt: input.now,
		nextFireAt,
		runId: null,
	});

	return {
		kind: "fired",
		graphRunId: graphRun.id,
		firedAt: input.now,
		nextFireAt,
	};
}
