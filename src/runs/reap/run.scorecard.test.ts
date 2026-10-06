import { describe, expect, test } from "bun:test";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import { reapRun } from "./run.ts";
import {
	createRepos,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	openDatabase,
	reapDeps,
} from "./test-helpers.ts";

const ISSUES =
	'{"id":"sd-target","status":"open","updatedAt":"2026-05-08T19:00:00Z","title":"x"}\n';

function fakeSeedsCli(): SeedsCliDeps {
	return { sdBinary: "sd", spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
}

describe("reapRun: run.scorecard event (ubuntu-c929)", () => {
	test("emits a deterministic scorecard after a succeeded no-changes reap", async () => {
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
			hasSeeds: true,
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
		await repos.runs.markRunning(run.id);

		const f = fakeFs({ "/data/projects/x/y/.seeds/issues.jsonl": ISSUES });
		const e = fakeExec({
			revListCount: "0",
			gitStatus: " M .mulch/expertise/build.jsonl\n?? .seeds/issues.jsonl\n",
		});

		const result = await reapRun({
			runId: run.id,
			outcome: "succeeded",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: f.fs, exec: e.exec }),
			fs: f.fs,
			exec: e.exec,
			seedsCli: fakeSeedsCli(),
		});

		expect(result.state).toBe("succeeded");
		expect(result.failureReason).toBeNull();
		const events = await repos.events.listByRun(run.id);
		const scorecard = events.find((ev) => ev.kind === "run.scorecard")?.payloadJson as Record<
			string,
			unknown
		> | null;
		expect(scorecard).not.toBeNull();
		expect(scorecard?.schema).toBe(1);
		expect(scorecard?.outcome).toBe("succeeded");
		expect(scorecard?.noChanges).toBe(true);
		expect(scorecard?.failureReason).toBeNull();
		expect(scorecard?.turns).toBe(0);
		expect(scorecard?.costUsd).toBeNull();
		expect(scorecard?.salvageRef).toBeNull();
		expect(scorecard?.seedsClosed).toBe(0);
		// Forcing is off by default — no continuation is spawned.
		expect(await repos.runs.listAll()).toHaveLength(1);
		await db.close();
	});
});
