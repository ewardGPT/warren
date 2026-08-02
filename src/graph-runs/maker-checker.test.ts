import { describe, expect, test } from "bun:test";
import { resolveMakerChecker } from "./maker-checker.ts";

describe("resolveMakerChecker", () => {
	test("permits sapling checker with a distinct model", () => {
		expect(
			resolveMakerChecker({
				makerAgent: "sapling",
				makerModel: "deepseek-chat",
				checkerAgent: "sapling",
				checkerModel: "deepseek-reasoner",
				stopCheckModel: "claude-haiku-4-5",
			}),
		).toMatchObject({ checkerAgent: "sapling", checkerModel: "deepseek-reasoner" });
	});

	test("blocks self-grading and checker/stop-check model reuse", () => {
		expect(() =>
			resolveMakerChecker({
				makerAgent: "sapling",
				makerModel: "deepseek-reasoner",
				checkerAgent: "sapling",
				checkerModel: "deepseek-reasoner",
				stopCheckModel: "claude-haiku-4-5",
			}),
		).toThrow("independent");
		expect(() =>
			resolveMakerChecker({
				makerAgent: "sapling",
				checkerAgent: "sapling",
				makerModel: "deepseek-chat",
				checkerModel: "claude-haiku-4-5",
				stopCheckModel: "claude-haiku-4-5",
			}),
		).toThrow("separate models");
	});
});
