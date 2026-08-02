import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import {
	advanceGraphRun,
	type CoordinatorEmitFn,
	type CoordinatorSpawnFn,
	isGraphRunChildSuccess,
	parseFindings,
	type StopCheckFn,
} from "./coordinator.ts";

const NOW = new Date("2026-05-17T00:00:00.000Z");

interface Harness {
	db: WarrenDb;
	repos: Repos;
	projectId: string;
	emit: CoordinatorEmitFn;
	spawn: CoordinatorSpawnFn;
	checkStop: StopCheckFn;
	readRunOutput: (runId: string) => Promise<string>;
}

async function setup(): Promise<Harness> {
	const db = await openDatabase({ path: ":memory:" });
	db.drizzle
		.insert(agents)
		.values({
			name: "claude-code",
			renderedJson: { sections: {} },
			registeredAt: "2026-05-10T00:00:00.000Z",
			lastRefreshed: "2026-05-10T00:00:00.000Z",
		})
		.run();
	const repos = createRepos(db);
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const outputs = new Map<string, string>();
	const emit: CoordinatorEmitFn = async () => {};
	const spawn: CoordinatorSpawnFn = async ({ graphRun, child, prompt }) => {
		const run = await repos.runs.create({
			agentName: graphRun.agentName,
			projectId: graphRun.projectId,
			prompt,
			renderedAgentJson: { sections: {} },
			trigger: "graph-run",
			now: NOW,
		});
		void child;
		return { runId: run.id };
	};
	const checkStop: StopCheckFn = async () => true;
	const readRunOutput = async (runId: string) => outputs.get(runId) ?? "";
	return {
		db,
		repos,
		projectId: project.id,
		emit,
		spawn,
		checkStop,
		readRunOutput: (runId) => readRunOutput(runId),
	};
}

describe("parseFindings", () => {
	test("parses a JSON array from output", () => {
		const findings = parseFindings('noise\n[{"file":"a.ts","claim":"missing auth"}]\ntrailer');
		expect(findings).toEqual([{ file: "a.ts", claim: "missing auth" }]);
	});
});

describe("isGraphRunChildSuccess", () => {
	test("treats dropped_commit on graph-run trigger as success", () => {
		expect(
			isGraphRunChildSuccess({
				state: "failed",
				failureReason: "dropped_commit",
				trigger: "graph-run",
			}),
		).toBe(true);
	});

	test("does not treat dropped_commit on manual runs as success", () => {
		expect(
			isGraphRunChildSuccess({
				state: "failed",
				failureReason: "dropped_commit",
				trigger: "manual",
			}),
		).toBe(false);
	});
});

describe("advanceGraphRun", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("dispatches fan_out children up to maxFanOut", async () => {
		const { graphRun } = await h.repos.graphRuns.create({
			projectId: h.projectId,
			template: "security-sweep",
			scopeJson: { glob: "*.ts", max: 20 },
			verifyEnabled: false,
			synthesizeEnabled: false,
			maxFanOut: 2,
			children: [
				{ seq: 1, phase: "fan_out", filePath: "a.ts" },
				{ seq: 2, phase: "fan_out", filePath: "b.ts" },
				{ seq: 3, phase: "fan_out", filePath: "c.ts" },
			],
			now: NOW,
		});

		const first = await advanceGraphRun({
			graphRun,
			repos: h.repos,
			spawn: h.spawn,
			checkStop: h.checkStop,
			emit: h.emit,
			readRunOutput: h.readRunOutput,
			now: () => NOW,
		});
		expect(first.kind).toBe("dispatched");
		if (first.kind === "dispatched") expect(first.count).toBe(2);

		const children = await h.repos.graphRuns.listChildren(graphRun.id);
		expect(children.filter((c) => c.state === "dispatched")).toHaveLength(2);
		expect(children.filter((c) => c.state === "pending")).toHaveLength(1);
	});

	test("succeeds when fan_out completes with no verify/synthesize", async () => {
		const outputs = new Map<string, string>();
		const spawn: CoordinatorSpawnFn = async ({ graphRun, child, prompt }) => {
			const run = await h.repos.runs.create({
				agentName: graphRun.agentName,
				projectId: graphRun.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "graph-run",
				now: NOW,
			});
			outputs.set(run.id, "[]");
			await h.repos.runs.markRunning(run.id, NOW);
			await h.repos.runs.finalize(run.id, "succeeded", NOW);
			void child;
			return { runId: run.id };
		};

		const { graphRun } = await h.repos.graphRuns.create({
			projectId: h.projectId,
			template: "security-sweep",
			scopeJson: { glob: "*.ts" },
			verifyEnabled: false,
			synthesizeEnabled: false,
			children: [{ seq: 1, phase: "fan_out", filePath: "a.ts" }],
			now: NOW,
		});

		await advanceGraphRun({
			graphRun,
			repos: h.repos,
			spawn,
			checkStop: h.checkStop,
			emit: h.emit,
			readRunOutput: async (runId) => outputs.get(runId) ?? "",
			now: () => NOW,
		});

		const result = await advanceGraphRun({
			graphRun: await h.repos.graphRuns.require(graphRun.id),
			repos: h.repos,
			spawn,
			checkStop: h.checkStop,
			emit: h.emit,
			readRunOutput: async (runId) => outputs.get(runId) ?? "",
			now: () => NOW,
		});
		expect(result.kind).toBe("graph_run_succeeded");
		const row = await h.repos.graphRuns.require(graphRun.id);
		expect(row.state).toBe("succeeded");
	});

	test("succeeds when fan_out child ends dropped_commit (read-only audit)", async () => {
		const outputs = new Map<string, string>();
		const spawn: CoordinatorSpawnFn = async ({ graphRun, child, prompt }) => {
			const run = await h.repos.runs.create({
				agentName: graphRun.agentName,
				projectId: graphRun.projectId,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "graph-run",
				now: NOW,
			});
			outputs.set(run.id, '[{"file":"a.ts","claim":"missing auth"}]');
			await h.repos.runs.markRunning(run.id, NOW);
			await h.repos.runs.finalize(run.id, "failed", NOW, "dropped_commit");
			void child;
			return { runId: run.id };
		};

		const { graphRun } = await h.repos.graphRuns.create({
			projectId: h.projectId,
			template: "security-sweep",
			scopeJson: { glob: "*.ts" },
			verifyEnabled: false,
			synthesizeEnabled: false,
			children: [{ seq: 1, phase: "fan_out", filePath: "a.ts" }],
			now: NOW,
		});

		await advanceGraphRun({
			graphRun,
			repos: h.repos,
			spawn,
			checkStop: h.checkStop,
			emit: h.emit,
			readRunOutput: async (runId) => outputs.get(runId) ?? "",
			now: () => NOW,
		});

		const result = await advanceGraphRun({
			graphRun: await h.repos.graphRuns.require(graphRun.id),
			repos: h.repos,
			spawn,
			checkStop: h.checkStop,
			emit: h.emit,
			readRunOutput: async (runId) => outputs.get(runId) ?? "",
			now: () => NOW,
		});
		expect(result.kind).toBe("graph_run_succeeded");
	});

	test("verify phase uses checkStop and advances to synthesize", async () => {
		const checkCalls: string[] = [];
		const checkStop: StopCheckFn = async (prompt) => {
			checkCalls.push(prompt);
			return true;
		};

		const { graphRun } = await h.repos.graphRuns.create({
			projectId: h.projectId,
			template: "security-sweep",
			scopeJson: { glob: "*.ts" },
			verifyEnabled: true,
			synthesizeEnabled: true,
			state: "verifying",
			children: [
				{
					seq: 1,
					phase: "verify",
					findingJson: { file: "a.ts", claim: "missing auth" },
				},
			],
			now: NOW,
		});

		const advanced = await advanceGraphRun({
			graphRun,
			repos: h.repos,
			spawn: h.spawn,
			checkStop,
			emit: h.emit,
			readRunOutput: h.readRunOutput,
			now: () => NOW,
		});
		expect(advanced.kind).toBe("advanced");
		expect(checkCalls.length).toBe(1);
		const row = await h.repos.graphRuns.require(graphRun.id);
		expect(row.state).toBe("synthesizing");
	});
});
