import { describe, expect, test } from "bun:test";
import { resolveTokenBudget, TokenBudgetLedger } from "./token-budget.ts";

describe("TokenBudgetLedger", () => {
	test("keeps a 10% reserve and records usage by tool", () => {
		const ledger = new TokenBudgetLedger({ totalTokens: 1_000 });
		expect(ledger.record({ input: 700, output: 200, tool: "bash" })).toBe("reserve_required");
		expect(ledger.snapshot()).toMatchObject({
			totalTokens: 900,
			regularLimit: 900,
			reserveTokens: 100,
			byTool: { bash: 900 },
		});
		expect(ledger.shouldEarlyExit(true)).toBe(false);
		expect(ledger.record({ input: 100, output: 0, tool: "bash" })).toBe("exhausted");
	});

	test("caps repeated bad attempts", () => {
		const ledger = new TokenBudgetLedger({ totalTokens: 10_000, maxBadAttempts: 2 });
		expect(ledger.record({ input: 1, output: 1, successful: false })).toBe("continue");
		expect(ledger.record({ input: 1, output: 1, successful: false })).toBe("bad_attempt_cap");
	});

	test("confident completion exits before reserve", () => {
		const ledger = new TokenBudgetLedger({ totalTokens: 1_000 });
		ledger.record({ input: 100, output: 100 });
		expect(ledger.shouldEarlyExit(true)).toBe(true);
		expect(ledger.shouldEarlyExit(false)).toBe(false);
	});
});

test("resolveTokenBudget reads frozen frontmatter defensively", () => {
	expect(resolveTokenBudget({ frontmatter: { tokenBudget: { totalTokens: 500 } } })).toEqual({
		totalTokens: 500,
	});
	expect(resolveTokenBudget({ frontmatter: { tokenBudget: { totalTokens: -1 } } })).toBeNull();
});
