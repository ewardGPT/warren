import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import { spawnRun } from "./index.ts";
import { makeBurrowClient, makeProvider, setupRepos } from "./test-helpers.ts";

describe("spawnRun: mulch priors (ubuntu-2bb5)", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		({ db, repos } = await setupRepos());
	});
	afterEach(async () => {
		await db.close();
	});

	test("injects seed-relevant mulch failures into the dispatched prompt", async () => {
		const projectPath = await mkdtemp(join(tmpdir(), "mulch-priors-"));
		await mkdir(join(projectPath, ".mulch", "expertise"), { recursive: true });
		await mkdir(join(projectPath, ".seeds"), { recursive: true });
		await writeFile(
			join(projectPath, ".mulch", "expertise", "patterns.jsonl"),
			`${JSON.stringify({
				type: "failure",
				id: "mx-prior",
				description: "Push protection rejected the reap push (GH013).",
				resolution: "Classify GH013 as push_rejected_policy.",
				dir_anchors: ["src/runs/reap"],
			})}\n`,
		);
		await writeFile(
			join(projectPath, ".seeds", "issues.jsonl"),
			`${JSON.stringify({
				id: "warren-1a2b",
				title: "Fix GH013 handling in src/runs/reap",
				description: "Push protection blocks the reap push.",
				status: "open",
			})}\n`,
		);
		await repos.projects.create({
			id: "prj_mulchpriors1",
			gitUrl: "https://github.com/x/priors.git",
			localPath: projectPath,
			defaultBranch: "main",
		});

		const { client, calls } = makeBurrowClient();
		await spawnRun({
			repos,
			runtimeProvider: makeProvider(client),
			agentName: "refactor-bot",
			projectId: "prj_mulchpriors1",
			prompt: "Work on warren-1a2b",
			seedId: "warren-1a2b",
		});

		const body = calls[1]?.body as { prompt: string };
		expect(body.prompt.startsWith("be a refactor agent\n\n---\n\n")).toBe(true);
		expect(body.prompt).toContain("Known failure priors");
		expect(body.prompt).toContain("[mx-prior]");
		expect(body.prompt.endsWith("\n\n---\n\nWork on warren-1a2b")).toBe(true);
	});
});
