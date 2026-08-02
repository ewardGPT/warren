import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	openDatabase,
	RunEventBroker,
} from "./test-helpers.ts";

describe("reapRun ignored Plot carriers (warren-a41f)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: { sections: { system: "x" } },
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
			hasPlot: true,
		});
		const run = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_zzzzzzzzzzzz",
		});
		await repos.burrows.create({ id: "bur_aaaaaaaaaaaa", workerId: "local" });
		await repos.runs.markRunning(run.id);
		ctx = {
			db,
			repos,
			broker: new RunEventBroker(),
			runId: run.id,
			projectPath: project.localPath,
			workspacePath: "/data/burrow/ws",
		};
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("skips gitignored Plot carriers without raising reap_failed", async () => {
		const f = fakeFs({ "/data/projects/x/y/.plot/plot-ignored.json": '{"id":"plot-ignored"}' });
		const e = fakeExec({ stagedDelta: true, ignoredPaths: true });
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: e.exec,
		});
		expect(result.plotCommitted).toBe(false);
		expect(e.calls.find((call) => call.args[0] === "add")).toBeUndefined();
		expect(e.calls.find((call) => call.args[0] === "check-ignore")).toBeDefined();
	});
});
