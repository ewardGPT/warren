import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeBurrowClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

describe("POST /runs — cross-repo seed routing", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
	});

	afterEach(async () => {
		if (handle) await handle.stop();
		await db.close();
	});

	test("routes execution while preserving seed project", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const seedProject = await repos.projects.create({
			gitUrl: "https://github.com/x/meta.git",
			localPath: await mkdtemp(join(tmpdir(), "warren-meta-")),
			defaultBranch: "main",
		});
		const executionProject = await repos.projects.create({
			gitUrl: "https://github.com/x/child.git",
			localPath: await mkdtemp(join(tmpdir(), "warren-child-")),
			defaultBranch: "main",
		});
		const calls: { method: string; path: string; body: unknown }[] = [];
		const burrowClient = makeBurrowClient(
			{ burrowId: "bur_routed000000", burrowRunId: "run_routed00000", workspacePath: "/tmp/ws" },
			calls,
		);
		const deps = await depsFor(repos, burrowClient, undefined, {
			seedsCli: {
				sdBinary: "sd",
				spawn: async () => ({
					stdout: JSON.stringify({
						success: true,
						issue: {
							id: "seed-routed",
							status: "open",
							title: "Child task",
							description: "Do the child work",
							extensions: { repo: "x/child" },
						},
					}),
					stderr: "",
					exitCode: 0,
				}),
			},
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agent: "refactor-bot",
				project: seedProject.id,
				prompt: "Implement {seed_body}",
				seedId: "seed-routed",
			}),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { run: { id: string } };
		const persisted = await repos.runs.require(body.run.id);
		expect(persisted.projectId).toBe(executionProject.id);
		expect(calls.find((c) => c.path === "/burrows")?.body).toMatchObject({
			originUrl: executionProject.gitUrl,
		});
		expect(persisted.prompt).toContain("Child task");
	});
});
