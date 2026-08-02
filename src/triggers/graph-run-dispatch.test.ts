import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { agents } from "../db/schema.ts";
import { dispatchGraphRunTrigger } from "./graph-run-dispatch.ts";

const NOW = new Date("2026-05-17T06:00:00.000Z");

describe("dispatchGraphRunTrigger", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectId: string;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await db.drizzle
			.insert(agents)
			.values({
				name: "sapling",
				renderedJson: { sections: {} },
				registeredAt: "2026-05-10T00:00:00.000Z",
				lastRefreshed: "2026-05-10T00:00:00.000Z",
			})
			.run();
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/home/ubuntu/warren",
			defaultBranch: "main",
		});
		projectId = project.id;
	});

	afterEach(async () => {
		await db.close();
	});

	test("seeds trigger row on first observation without firing", async () => {
		const result = await dispatchGraphRunTrigger({
			projectId,
			trigger: {
				id: "security-sweep-weekly",
				kind: "graph-run",
				cron: "0 6 * * 1",
				template: "verify-smoke",
			},
			now: NOW,
			repos,
		});
		expect(result.kind).toBe("seeded");
		const row = await repos.triggers.get({ projectId, triggerId: "security-sweep-weekly" });
		expect(row?.lastFiredAt).not.toBeNull();
	});

	test("fires graph run when cron slot elapsed", async () => {
		await repos.triggers.upsert({
			projectId,
			triggerId: "verify-smoke-slot",
			lastFiredAt: new Date("2026-05-10T06:00:00.000Z").toISOString(),
			nextFireAt: null,
		});
		const result = await dispatchGraphRunTrigger({
			projectId,
			trigger: {
				id: "verify-smoke-slot",
				kind: "graph-run",
				cron: "0 6 * * 1",
				template: "verify-smoke",
				synthesize: false,
			},
			now: NOW,
			repos,
		});
		expect(result.kind).toBe("fired");
		if (result.kind === "fired") {
			const graphRun = await repos.graphRuns.require(result.graphRunId);
			expect(graphRun.template).toBe("verify-smoke");
			expect(graphRun.verifyEnabled).toBe(true);
			expect(graphRun.synthesizeEnabled).toBe(false);
		}
	});
});
