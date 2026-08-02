import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import type { CoordinatorSpawnFn } from "./coordinator.ts";
import { bootGraphRunCoordinator, runGraphRunTick } from "./tick.ts";

const NOW = new Date("2026-05-17T00:00:00.000Z");

describe("GraphRun tick", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		db.drizzle
			.insert(agents)
			.values({
				name: "sapling",
				renderedJson: { sections: {} },
				registeredAt: NOW.toISOString(),
				lastRefreshed: NOW.toISOString(),
			})
			.run();
		repos = createRepos(db);
	});

	afterEach(async () => {
		await db.close();
	});

	test("advances an active run and uses default event/output adapters", async () => {
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: process.cwd(),
			defaultBranch: "main",
		});
		const { graphRun } = await repos.graphRuns.create({
			projectId: project.id,
			template: "security-sweep",
			scopeJson: { glob: "*.ts" },
			verifyEnabled: false,
			synthesizeEnabled: false,
			children: [{ seq: 1, phase: "fan_out", filePath: "src/index.ts" }],
			now: NOW,
		});
		const spawn: CoordinatorSpawnFn = async ({ graphRun: row, child, prompt }) => {
			const run = await repos.runs.create({
				agentName: row.agentName,
				projectId: project.id,
				prompt,
				renderedAgentJson: { sections: {} },
				trigger: "graph-run",
				now: NOW,
			});
			await repos.runs.markRunning(run.id, NOW);
			await repos.runs.finalize(run.id, "succeeded", NOW);
			void child;
			return { runId: run.id };
		};

		const first = await runGraphRunTick({ repos, spawn, now: () => NOW });
		const second = await runGraphRunTick({ repos, spawn, now: () => NOW });
		expect(first.errors).toEqual([]);
		expect(first.advances[0]?.result.kind).toBe("dispatched");
		expect(second.advances[0]?.result.kind).toBe("graph_run_succeeded");
		const children = await repos.graphRuns.listChildren(graphRun.id);
		const events = await repos.events.listByRun(children[0]?.runId ?? "missing");
		expect(events.length).toBeGreaterThan(0);
	});

	test("coordinator is single-flight and stoppable", async () => {
		let timer: (() => void) | undefined;
		const logs: string[] = [];
		const handle = bootGraphRunCoordinator({
			tickMs: 1000,
			repos: { graphRuns: { listActive: () => [] }, runs: {}, events: {} } as never,
			spawn: async () => ({ runId: "unused" }),
			setInterval: (cb) => {
				timer = cb;
				return {};
			},
			clearInterval: () => {},
			logger: {
				info: (_obj, msg) => {
					if (msg !== undefined) logs.push(msg);
				},
				warn: () => {},
				error: () => {},
			},
		});
		expect(timer).toBeDefined();
		const first = handle.runOnce();
		const second = handle.runOnce();
		expect(await second).toBeNull();
		await first;
		await handle.stop();
		expect(handle.tickCount()).toBe(1);
		expect(logs).toContain("graph_run.tick_skipped");
	});
});
