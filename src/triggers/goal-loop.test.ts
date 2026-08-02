import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { GoalTrigger, LoopTrigger } from "../warren-config/schema.ts";
import type { DispatchSpawnFn } from "./dispatch.ts";
import { dispatchGoalTrigger, dispatchLoopTrigger } from "./goal-loop.ts";

const GOAL: GoalTrigger = {
	id: "goal-1",
	kind: "goal",
	role: "claude-code",
	seed: "ubuntu-abc",
	stopPrompt: "all tests pass and lint is clean",
	maxRuns: 10,
};

const LOOP: LoopTrigger = {
	id: "loop-1",
	kind: "loop",
	role: "claude-code",
	cron: "0 * * * *",
	seed: "ubuntu-def",
	maxIterations: 5,
};

describe("dispatchGoalTrigger", () => {
	let db: WarrenDb;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		await db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
	});

	afterEach(async () => {
		await db.close();
	});

	test("spawns with goal prompt including stop condition", async () => {
		let captured: Parameters<DispatchSpawnFn>[0] | undefined;
		const spawn: DispatchSpawnFn = async (input) => {
			captured = input;
			return { runId: "run-goal" };
		};
		const result = await dispatchGoalTrigger({
			projectId: "p1",
			trigger: GOAL,
			now: new Date("2026-05-17T00:00:00.000Z"),
			spawn,
		});
		expect(result.kind).toBe("spawned");
		if (result.kind === "spawned") expect(result.runId).toBe("run-goal");
		expect(captured?.trigger).toBe("goal");
		expect(captured?.prompt).toContain("all tests pass and lint is clean");
		expect(captured?.metadata).toEqual({ seedId: "ubuntu-abc" });
	});

	test("skips without seed", async () => {
		const spawn: DispatchSpawnFn = async () => ({ runId: "r" });
		const result = await dispatchGoalTrigger({
			projectId: "p1",
			trigger: { ...GOAL, seed: undefined },
			now: new Date(),
			spawn,
		});
		expect(result.kind).toBe("skipped_no_seed");
	});

	test("reports spawn failure", async () => {
		const spawn: DispatchSpawnFn = async () => {
			throw new Error("burrow down");
		};
		const result = await dispatchGoalTrigger({
			projectId: "p1",
			trigger: GOAL,
			now: new Date(),
			spawn,
		});
		expect(result.kind).toBe("spawn_failed");
		if (result.kind === "spawn_failed") expect(result.reason).toContain("burrow down");
	});
});

describe("dispatchLoopTrigger", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await db.drizzle
			.insert(agents)
			.values({
				name: "claude-code",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
		await repos.projects.create({
			id: "p1",
			gitUrl: "https://github.com/example/project.git",
			localPath: "/tmp/project",
			defaultBranch: "main",
		});
	});

	afterEach(async () => {
		await db.close();
	});

	test("spawns when under iteration cap", async () => {
		let captured: Parameters<DispatchSpawnFn>[0] | undefined;
		const spawn: DispatchSpawnFn = async (input) => {
			captured = input;
			return { runId: "run-loop" };
		};
		const result = await dispatchLoopTrigger({
			projectId: "p1",
			trigger: LOOP,
			now: new Date(),
			iterationsRun: 2,
			spawn,
		});
		expect(result.kind).toBe("spawned");
		expect(captured?.trigger).toBe("loop");
	});

	test("stops at iteration cap", async () => {
		const spawn: DispatchSpawnFn = async () => ({ runId: "r" });
		const result = await dispatchLoopTrigger({
			projectId: "p1",
			trigger: LOOP,
			now: new Date(),
			iterationsRun: 5,
			spawn,
		});
		expect(result.kind).toBe("iteration_cap_reached");
	});

	test("fireCount increments on recordFire", async () => {
		const key = { projectId: "p1", triggerId: "loop-1" };
		expect(await repos.triggers.getFireCount(key)).toBe(0);
		await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const runA = await repos.runs.create({
			agentName: "claude-code",
			projectId: "p1",
			prompt: "work",
			renderedAgentJson: { sections: {} },
			trigger: "loop",
			seedId: "ubuntu-def",
			now: new Date(),
		});
		const runB = await repos.runs.create({
			agentName: "claude-code",
			projectId: "p1",
			prompt: "work",
			renderedAgentJson: { sections: {} },
			trigger: "loop",
			seedId: "ubuntu-def",
			now: new Date(),
		});
		await repos.triggers.recordFire({
			...key,
			firedAt: new Date(),
			nextFireAt: null,
			runId: runA.id,
		});
		await repos.triggers.recordFire({
			...key,
			firedAt: new Date(),
			nextFireAt: null,
			runId: runB.id,
		});
		expect(await repos.triggers.getFireCount(key)).toBe(2);
	});
});
