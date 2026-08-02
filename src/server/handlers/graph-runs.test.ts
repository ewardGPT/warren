import { describe, expect, test } from "bun:test";
import { createGraphRunHandler, getGraphRunHandler } from "./graph-runs.ts";

const logger = { info: () => {}, warn: () => {}, error: () => {} };

function context(body: unknown, params: Record<string, string> = {}) {
	return {
		request: new Request("http://localhost/graph-runs", {
			method: body === undefined ? "GET" : "POST",
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			headers: { "content-type": "application/json" },
		}),
		url: new URL("http://localhost/graph-runs"),
		params,
		logger,
		requestId: "request_1",
	} as never;
}

describe("GraphRun handlers", () => {
	test("creates a scoped graph run from a template", async () => {
		let created: Record<string, unknown> | undefined;
		const deps = {
			repos: {
				projects: { require: async () => ({ id: "project_1", localPath: process.cwd() }) },
				agents: { get: async () => ({}) },
				graphRuns: {
					create: async (input: Record<string, unknown>) => {
						created = input;
						return { graphRun: { id: "graph_1" }, children: [] };
					},
				},
			} as never,
		} as never;
		const response = await createGraphRunHandler(deps)(
			context({
				project: "project_1",
				template: "security-sweep",
				scope: { glob: "src/graph-runs/*.ts", max: 2 },
			}),
		);
		expect(response.status).toBe(201);
		expect(created).toMatchObject({
			projectId: "project_1",
			template: "security-sweep",
			agentName: "sapling",
		});
		expect((created?.scopeJson as { max: number }).max).toBe(2);
	});

	test("returns a graph run and its children", async () => {
		const deps = {
			repos: {
				graphRuns: { getById: async () => ({ id: "graph_1" }), listChildren: async () => [] },
			},
		} as never;
		const response = await getGraphRunHandler(deps)(context(undefined, { id: "graph_1" }));
		expect(response.status).toBe(200);
		await expect(
			getGraphRunHandler({ repos: { graphRuns: { getById: async () => null } } } as never)(
				context(undefined, { id: "missing" }),
			),
		).rejects.toThrow("graph_run not found");
	});
});
