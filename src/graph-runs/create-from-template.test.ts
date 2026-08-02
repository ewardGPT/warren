import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGraphRunFromTemplate, resolveScopeFiles } from "./create-from-template.ts";

describe("resolveScopeFiles", () => {
	test("skips test files and respects max", async () => {
		const root = await mkdtemp(join(tmpdir(), "gr-scope-"));
		await mkdir(join(root, "src", "graph-runs"), { recursive: true });
		await writeFile(join(root, "src", "graph-runs", "a.ts"), "export {};\n");
		await writeFile(join(root, "src", "graph-runs", "a.test.ts"), "test();\n");
		await writeFile(join(root, "src", "graph-runs", "b.ts"), "export {};\n");

		const files = await resolveScopeFiles(root, { glob: "src/graph-runs/*.ts", max: 1 });
		expect(files).toEqual(["src/graph-runs/a.ts"]);
	});
});

describe("createGraphRunFromTemplate", () => {
	test("creates fan_out children from template scope", async () => {
		const root = await mkdtemp(join(tmpdir(), "gr-create-"));
		const templateDir = join(root, ".warren", "graph-templates");
		await mkdir(templateDir, { recursive: true });
		await mkdir(join(root, "src", "graph-runs"), { recursive: true });
		await writeFile(join(root, "src", "graph-runs", "target.ts"), "export {};\n");
		await writeFile(
			join(templateDir, "verify-smoke.yaml"),
			[
				"name: verify-smoke",
				"scope:",
				"  glob: src/graph-runs/*.ts",
				"  max: 5",
				"executor_prompt: |",
				"  Scan {file}.",
			].join("\n"),
		);

		let created: unknown;
		const repos = {
			projects: {
				require: async () => ({ id: "project_1", localPath: root }),
			},
			agents: { resolve: async () => ({}) },
			graphRuns: {
				create: async (input: unknown) => {
					created = input;
					return {
						graphRun: {
							id: "grun_test",
							projectId: "project_1",
							template: "verify-smoke",
							agentName: "sapling",
						},
					};
				},
			},
		} as never;

		const result = await createGraphRunFromTemplate({
			repos,
			projectId: "project_1",
			templateName: "verify-smoke",
		});

		expect(result.files).toEqual(["src/graph-runs/target.ts"]);
		expect(created).toMatchObject({
			projectId: "project_1",
			template: "verify-smoke",
			agentName: "sapling",
			verifyEnabled: true,
			synthesizeEnabled: true,
		});
	});
});
