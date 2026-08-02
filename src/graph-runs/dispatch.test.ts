import { describe, expect, test } from "bun:test";
import { createGraphRunSpawn } from "./dispatch.ts";

describe("createGraphRunSpawn", () => {
	test("forwards graph metadata and starts the bridge", async () => {
		const starts: string[] = [];
		let received: Record<string, unknown> | undefined;
		const spawn = createGraphRunSpawn({
			repos: { projects: { require: async () => ({ defaultBranch: "main" }) } } as never,
			runtimeProvider: {} as never,
			bridges: { start: (...args: string[]) => void starts.push(args.join(":")) } as never,
			warrenConfigs: {} as never,
			projectsConfig: {} as never,
			projectSpawn: (() => {}) as never,
			seedsCli: {} as never,
			spawnRunFn: async (input) => {
				received = input as unknown as Record<string, unknown>;
				return {
					run: { id: "run_1" },
					burrowRun: { id: "burrow_run_1" },
					burrow: { id: "burrow_1" },
				} as never;
			},
		});

		const result = await spawn({
			graphRun: {
				id: "graph_1",
				projectId: "project_1",
				template: "security-sweep",
				agentName: "sapling",
				state: "fan_out",
				scopeJson: { glob: "*.ts", seedId: "ubuntu-2966" },
				verifyEnabled: false,
				synthesizeEnabled: false,
				maxFanOut: 16,
				failureReason: null,
				createdAt: "now",
				startedAt: null,
				endedAt: null,
			},
			child: {
				id: "child_1",
				graphRunId: "graph_1",
				seq: 1,
				phase: "fan_out",
				runId: null,
				state: "pending",
				filePath: "src/index.ts",
				findingJson: null,
			},
			prompt: "audit",
		});

		expect(result).toEqual({ runId: "run_1" });
		expect(received).toMatchObject({
			projectId: "project_1",
			agentName: "sapling",
			seedId: "ubuntu-2966",
			trigger: "graph-run",
		});
		expect(starts).toEqual(["run_1:burrow_run_1:burrow_1"]);
	});
});
