import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { cancelRun } from "./cancel.ts";
import { makeReapRunResult } from "./reap/test-helpers.ts";

describe("cancelRun K8s lost-after-cancel race", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({ name: "agent", renderedJson: {} });
		const project = await repos.projects.create({
			gitUrl: "https://github.com/example/project.git",
			localPath: "/tmp/project",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "agent",
			projectId: project.id,
			prompt: "cancel",
			renderedAgentJson: {},
			trigger: "test",
			burrowId: "pod-run",
			burrowRunId: "backend-run",
		});
		await repos.runs.markRunning(run.id);
	});

	afterEach(async () => db.close());

	test("cancel intent wins when status reports the deleted pod as lost", async () => {
		const run = (await repos.runs.listByState("running"))[0];
		if (!run) throw new Error("running fixture missing");
		const provider = {
			cancel: async () => {},
			status: async () => ({ phase: "failed", terminalReason: "lost", exists: false }),
		} as unknown as RuntimeProvider;
		let outcome: string | undefined;
		const result = await cancelRun({
			runId: run.id,
			repos,
			runtimeProvider: provider,
			reap: async (input) => {
				outcome = input.outcome;
				return makeReapRunResult({ state: input.outcome });
			},
		});
		expect(result.state).toBe("cancelled");
		expect(result.burrowRun?.state).toBe("cancelled");
		expect(outcome).toBe("cancelled");
		expect((await repos.events.listByRun(run.id))[0]?.payloadJson).toMatchObject({
			mode: "lost_after_cancel",
		});
	});
});
