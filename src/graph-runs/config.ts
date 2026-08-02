/**
 * GraphRun coordinator environment config.
 */

import { ValidationError } from "../core/errors.ts";

export const DEFAULT_GRAPH_RUN_TICK_MS = 10_000;
export const DEFAULT_MAX_FAN_OUT = 16;

export interface GraphRunCoordinatorConfig {
	readonly tickMs: number;
	readonly disabled: boolean;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

export function loadGraphRunCoordinatorConfigFromEnv(
	env: EnvLike = process.env,
): GraphRunCoordinatorConfig {
	return {
		tickMs: parseTickMs(env.WARREN_GRAPH_RUN_TICK_MS),
		disabled: parseBoolFlag(env.WARREN_GRAPH_RUN_DISABLED),
	};
}

function parseTickMs(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_GRAPH_RUN_TICK_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new ValidationError(`WARREN_GRAPH_RUN_TICK_MS must be a positive integer, got "${raw}"`, {
			recoveryHint: `unset or set to a positive integer (default ${DEFAULT_GRAPH_RUN_TICK_MS})`,
		});
	}
	return Math.trunc(parsed);
}

function parseBoolFlag(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const t = raw.trim().toLowerCase();
	return t === "1" || t === "true" || t === "yes" || t === "on";
}
