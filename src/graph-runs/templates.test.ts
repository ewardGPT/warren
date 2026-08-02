import { describe, expect, test } from "bun:test";
import { parseGraphTemplate } from "./templates.ts";

describe("parseGraphTemplate", () => {
	test("parses security-sweep shape", () => {
		const tpl = parseGraphTemplate(
			{
				name: "security-sweep",
				defaults: { verify: true, synthesize: true, max_fan_out: 20 },
				scope: { glob: "src/server/handlers/*.ts" },
				executor_prompt: "Audit {file}",
			},
			"security-sweep.yaml",
		);
		expect(tpl.name).toBe("security-sweep");
		expect(tpl.defaults.maxFanOut).toBe(20);
		expect(tpl.scope.glob).toBe("src/server/handlers/*.ts");
	});
});

describe("loadGraphTemplate", () => {
	test("loads warren security-sweep.yaml from disk", async () => {
		const { loadGraphTemplate } = await import("./templates.ts");
		const tpl = await loadGraphTemplate("/home/ubuntu/warren", "security-sweep");
		expect(tpl.name).toBe("security-sweep");
		expect(tpl.scope.glob).toContain("handlers");
	});
});
