import { describe, expect, test } from "bun:test";
import {
	COMPLEX_CAP_USD,
	classifyBudgetClass,
	STANDARD_CAP_USD,
	TRIVIAL_CAP_USD,
} from "./budget-class.ts";

describe("classifyBudgetClass", () => {
	test("maps a long, multi-path, keyword-heavy seed to the complex tier", () => {
		const seedText = [
			"Refactor and rewrite the legacy thread pool used by the toolchain:",
			"migrate the worker lifecycle across src/runtime/local/provider.ts,",
			"src/runtime/k8s/agent-entrypoint.ts, src/runtime/k8s/finalize.ts,",
			"src/runtime/k8s/workspace-init.ts, src/runtime/k8s/log-parse.ts and",
			"src/runtime/k8s/pod-watcher.ts, then review the FFI binding surface",
			"for the security audit and document the migration path for every",
			"call site with a concurrency note and a deadlock checklist.",
		].join(" ");
		const budget = classifyBudgetClass({ seedText, prompt: "proceed" });
		expect(budget.level).toBe("complex");
		expect(budget.maxCostUsd).toBe(COMPLEX_CAP_USD);
	});

	test("maps a short prompt with no paths to the trivial tier", () => {
		const budget = classifyBudgetClass({
			seedText: "Bump the dependency version in the README example",
			prompt: "do it",
		});
		expect(budget.level).toBe("trivial");
		expect(budget.maxCostUsd).toBe(TRIVIAL_CAP_USD);
	});

	test("keeps a three-path task on the standard tier", () => {
		const budget = classifyBudgetClass({
			seedText: "Add a retry to getProject in src/projects/manage.ts, wire the fallback",
			prompt: "through src/projects/clone.ts and cover it in src/projects/config.ts",
		});
		expect(budget.level).toBe("standard");
		expect(budget.maxCostUsd).toBe(STANDARD_CAP_USD);
	});

	test("library text beyond 600 chars is standard, beyond 1500 still complex only with other signals", () => {
		const long = "word ".repeat(130); // 650 chars, no other signal
		expect(classifyBudgetClass({ seedText: long, prompt: "" }).level).toBe("standard");
	});

	test("path volume alone: three paths standard, six paths still standard", () => {
		const three = classifyBudgetClass({
			seedText: "a/b/c d/e/f g/h/i",
			prompt: "",
		});
		expect(three.level).toBe("standard");
		const six = classifyBudgetClass({
			seedText: "a/b/c d/e/f g/h/i j/k/l m/n/o p/q/r",
			prompt: "",
		});
		expect(six.level).toBe("standard");
	});

	test("six paths plus two keywords cross into complex", () => {
		const sixPlusKeywords = classifyBudgetClass({
			seedText: "a/b/c d/e/f g/h/i j/k/l m/n/o p/q/r refactor the legacy path",
			prompt: "",
		});
		expect(sixPlusKeywords.level).toBe("complex");
		expect(sixPlusKeywords.maxCostUsd).toBe(COMPLEX_CAP_USD);
	});
});
