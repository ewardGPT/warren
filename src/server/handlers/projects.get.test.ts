import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BurrowClient } from "../../burrow-client/index.ts";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, silentLogger, stub, tcpUrl } from "./projects.test-helpers.ts";

describe("GET /projects/:id", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";
	let projectPath = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		projectPath = await mkdtemp(join(tmpdir(), "warren-get-project-"));
		const project = await repos.projects.create({
			id: "prj_get_project",
			gitUrl: "https://github.com/x/y.git",
			localPath: projectPath,
			defaultBranch: "main",
			hasSeeds: true,
		});
		projectId = project.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
		await rm(projectPath, { recursive: true, force: true });
	});

	async function start(): Promise<string> {
		const deps = await depsFor(
			repos,
			new BurrowClient({
				config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
				fetch: stub(async () => new Response("{}", { status: 200 })),
			}),
		);
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		return tcpUrl(handle);
	}

	test("returns the operator project row", async () => {
		const res = await fetch(`${await start()}/projects/${projectId}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			id: projectId,
			gitUrl: "https://github.com/x/y.git",
			localPath: expect.any(String),
			hasSeeds: true,
		});
	});

	test("returns 404 for an unknown project", async () => {
		const res = await fetch(`${await start()}/projects/prj_missing`);
		expect(res.status).toBe(404);
	});
});
