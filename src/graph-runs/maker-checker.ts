/** Maker/checker policy used by graph runs and goal stop checks. */

export interface MakerCheckerInput {
	readonly makerAgent: string;
	readonly makerModel?: string;
	readonly checkerAgent: string;
	readonly checkerModel?: string;
	readonly stopCheckModel: string;
}

export interface MakerCheckerConfig {
	readonly checkerAgent: string;
	readonly checkerModel: string;
	readonly stopCheckModel: string;
}

export const DEFAULT_CHECKER_AGENT = "sapling";
export const DEFAULT_CHECKER_MODEL = "deepseek-reasoner";
export const DEFAULT_STOP_CHECK_MODEL = "claude-haiku-4-5";

export function resolveMakerChecker(input: MakerCheckerInput): MakerCheckerConfig {
	const checkerModel = input.checkerModel ?? DEFAULT_CHECKER_MODEL;
	if (
		input.makerAgent === input.checkerAgent &&
		input.makerModel !== undefined &&
		input.makerModel === checkerModel
	) {
		throw new Error("maker and checker must use independent agent instructions or models");
	}
	if (checkerModel === input.stopCheckModel) {
		throw new Error("checker and stop-check must use separate models");
	}
	return {
		checkerAgent: input.checkerAgent,
		checkerModel,
		stopCheckModel: input.stopCheckModel,
	};
}
