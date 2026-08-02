import { describe, expect, test } from "bun:test";
import { parseTriggersConfig } from "./schema.ts";

describe("GraphRunTrigger schema", () => {
	test("accepts graph-run trigger with template and cron", () => {
		const result = parseTriggersConfig([
			{
				id: "security-sweep-weekly",
				kind: "graph-run",
				cron: "0 6 * * 1",
				template: "security-sweep",
				scope: { max: 15 },
			},
		]);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value[0]?.kind).toBe("graph-run");
		}
	});

	test("rejects graph-run without template", () => {
		const result = parseTriggersConfig([
			{
				id: "bad",
				kind: "graph-run",
				cron: "0 6 * * 1",
			},
		]);
		expect(result.ok).toBe(false);
	});
});
