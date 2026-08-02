/**
 * Load declarative GraphRun templates from `.warren/graph-templates/*.yaml`.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYamlDocument } from "yaml";
import { ValidationError } from "../core/errors.ts";
import type { GraphRunScopeJson } from "../db/schema.ts";

export interface GraphTemplateDefaults {
	readonly agent?: string;
	readonly verify: boolean;
	readonly synthesize: boolean;
	readonly maxFanOut: number;
	readonly maxConcurrent: number;
	readonly perRunCostUsd?: number;
}

export interface GraphTemplate {
	readonly name: string;
	readonly description?: string;
	readonly defaults: GraphTemplateDefaults;
	readonly scope: GraphRunScopeJson;
	readonly executorPrompt: string;
	readonly verifierPrompt?: string;
	readonly synthesizePrompt?: string;
}

interface RawTemplateYaml {
	readonly name?: string;
	readonly description?: string;
	readonly defaults?: {
		readonly agent?: string;
		readonly verify?: boolean;
		readonly synthesize?: boolean;
		readonly max_fan_out?: number;
		readonly max_concurrent?: number;
		readonly per_run_cost_usd?: number;
	};
	readonly scope?: {
		readonly glob?: string;
		readonly max?: number;
		readonly seed_id?: string;
		readonly maker_model?: string;
		readonly checker_agent?: string;
		readonly checker_model?: string;
		readonly stop_check_model?: string;
	};
	readonly executor_prompt?: string;
	readonly verifier_prompt?: string;
	readonly synthesize_prompt?: string;
}

function parseTemplateYaml(text: string): RawTemplateYaml {
	return parseYamlDocument(text) as RawTemplateYaml;
}

export function parseGraphTemplate(raw: RawTemplateYaml, fileName: string): GraphTemplate {
	const name = raw.name ?? fileName.replace(/\.ya?ml$/, "");
	const glob = raw.scope?.glob;
	if (glob === undefined || glob.length === 0) {
		throw new ValidationError(`template ${name}: scope.glob is required`);
	}
	const executorPrompt = raw.executor_prompt?.trim();
	if (executorPrompt === undefined || executorPrompt.length === 0) {
		throw new ValidationError(`template ${name}: executor_prompt is required`);
	}
	return {
		name,
		...(raw.description !== undefined ? { description: raw.description } : {}),
		defaults: parseDefaults(raw),
		scope: parseScope(raw, glob),
		executorPrompt,
		...(raw.verifier_prompt !== undefined ? { verifierPrompt: raw.verifier_prompt.trim() } : {}),
		...(raw.synthesize_prompt !== undefined
			? { synthesizePrompt: raw.synthesize_prompt.trim() }
			: {}),
	};
}

function parseDefaults(raw: RawTemplateYaml): GraphTemplateDefaults {
	const defaults = raw.defaults;
	return {
		...(defaults?.agent !== undefined ? { agent: defaults.agent } : {}),
		verify: defaults?.verify ?? true,
		synthesize: defaults?.synthesize ?? true,
		maxFanOut: defaults?.max_fan_out ?? 20,
		maxConcurrent: defaults?.max_concurrent ?? 16,
		...(defaults?.per_run_cost_usd !== undefined
			? { perRunCostUsd: defaults.per_run_cost_usd }
			: {}),
	};
}

function parseScope(raw: RawTemplateYaml, glob: string): GraphRunScopeJson {
	return {
		glob,
		...(raw.scope?.max !== undefined ? { max: raw.scope.max } : {}),
		...(raw.scope?.seed_id !== undefined ? { seedId: raw.scope.seed_id } : {}),
		...(raw.scope?.maker_model !== undefined ? { makerModel: raw.scope.maker_model } : {}),
		...(raw.scope?.checker_agent !== undefined ? { checkerAgent: raw.scope.checker_agent } : {}),
		...(raw.scope?.checker_model !== undefined ? { checkerModel: raw.scope.checker_model } : {}),
		...(raw.scope?.stop_check_model !== undefined
			? { stopCheckModel: raw.scope.stop_check_model }
			: {}),
	};
}

export async function loadGraphTemplate(
	projectLocalPath: string,
	templateName: string,
): Promise<GraphTemplate> {
	const base = path.join(projectLocalPath, ".warren", "graph-templates");
	const candidates = [`${templateName}.yaml`, `${templateName}.yml`];
	for (const file of candidates) {
		const full = path.join(base, file);
		try {
			const text = await readFile(full, "utf8");
			return parseGraphTemplate(parseTemplateYaml(text), file);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw err;
		}
	}
	throw new ValidationError(`graph template not found: ${templateName}`, {
		recoveryHint: `add .warren/graph-templates/${templateName}.yaml to the project`,
	});
}
