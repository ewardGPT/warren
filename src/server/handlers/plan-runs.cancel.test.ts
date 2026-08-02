import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSdSpawn, silentLogger, tcpUrl } from "./plan-runs.test-helpers.ts";

describe("POST /plan-runs/:id/cancel", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let seedyProjectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const seedy = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy",
			defaultBranch: "main",
			hasSeeds: true,
		});
		seedyProjectId = seedy.id;
		await repos.agents.upsert({
			name: "claude-code",
			renderedJson: {
				name: "claude-code",
				version: 1,
				sections: { system: "you are claude" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("cancels an in-flight child via cancelRun + flips plan_run to cancelled", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-cancel",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running", {
			startedAt: new Date().toISOString(),
		});

		// Create a queued run with NO burrow_run_id — cancelRun's "partial spawn"
		// branch handles this without a burrow round-trip, so we can assert the
		// chain through without stubbing the burrow client's cancel endpoint.
		const childRun = await repos.runs.create({
			agentName: "claude-code",
			projectId: seedyProjectId,
			prompt: "work on sd wa-a",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: { runId: childRun.id, state: "dispatched", startedAt: new Date().toISOString() },
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/cancel`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			planRun: { state: string };
			cancelledChild: { childSeq: number; runId: string } | null;
			alreadyTerminal: boolean;
		};
		expect(body.planRun.state).toBe("cancelled");
		expect(body.cancelledChild).toEqual({ childSeq: 1, runId: childRun.id });
		expect(body.alreadyTerminal).toBe(false);

		const persistedChild = await repos.runs.require(childRun.id);
		expect(persistedChild.state).toBe("cancelled");
	});

	test("alreadyTerminal=true for a plan_run already in cancelled/succeeded/failed", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-terminal",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "cancelled", {
			endedAt: new Date().toISOString(),
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/cancel`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { alreadyTerminal: boolean; cancelledChild: unknown };
		expect(body.alreadyTerminal).toBe(true);
		expect(body.cancelledChild).toBeNull();
	});

	test("resumes a child PR timeout and re-arms its merge clock", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-resume",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running");
		const childRun = await repos.runs.create({
			agentName: "claude-code",
			projectId: seedyProjectId,
			prompt: "work on sd wa-a",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.runs.markRunning(childRun.id);
		await repos.runs.setPrUrl(childRun.id, "https://github.com/x/seedy/pull/7");
		await repos.runs.finalize(childRun.id, "succeeded", new Date("2026-08-01T00:00:00.000Z"));
		await repos.planRuns.updateChild({
			planRunId: created.planRun.id,
			seq: 1,
			patch: {
				runId: childRun.id,
				state: "failed",
				failureReason: "child_pr_merge_timeout",
				endedAt: "2026-08-01T00:30:00.000Z",
			},
		});
		await repos.planRuns.transitionTo(created.planRun.id, "failed", {
			failureReason: "child_pr_merge_timeout",
			endedAt: "2026-08-01T00:30:00.000Z",
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/resume`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { planRun: { state: string }; resumed: boolean };
		expect(body).toEqual({ planRun: expect.objectContaining({ state: "running" }), resumed: true });
		const child = (await repos.planRuns.listChildren(created.planRun.id))[0];
		expect(child).toBeDefined();
		if (child === undefined) return;
		expect(child.state).toBe("pr_open");
		expect(child.runId).toBe(childRun.id);
		expect(child.failureReason).toBeNull();
		expect(child.endedAt).toBeNull();
		const rearmed = await repos.runs.require(childRun.id);
		expect(rearmed.prUrl).toBe("https://github.com/x/seedy/pull/7");
		expect(rearmed.mergeWaitStartedAt).not.toBeNull();
	});

	test("rejects non-timeout failures without changing state", async () => {
		const created = await repos.planRuns.create({
			planId: "pl-no-resume",
			projectId: seedyProjectId,
			agentName: "claude-code",
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running");
		await repos.planRuns.transitionTo(created.planRun.id, "failed", {
			failureReason: "pr_closed_without_merge",
		});
		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/resume`, {
			method: "POST",
		});
		expect(res.status).toBe(400);
		expect((await repos.planRuns.require(created.planRun.id)).state).toBe("failed");
	});

	test("resumes a parent PR timeout by re-arming the parent run", async () => {
		const parent = await repos.runs.create({
			agentName: "claude-code",
			projectId: seedyProjectId,
			prompt: "parent",
			renderedAgentJson: {},
			trigger: "plan-run",
		});
		await repos.runs.markRunning(parent.id);
		await repos.runs.setPrUrl(parent.id, "https://github.com/x/seedy/pull/8");
		await repos.runs.finalize(parent.id, "succeeded", new Date("2026-08-01T00:00:00.000Z"));
		const created = await repos.planRuns.create({
			planId: "pl-parent-resume",
			projectId: seedyProjectId,
			agentName: "claude-code",
			parentRunId: parent.id,
			children: [{ seq: 1, seedId: "wa-a" }],
		});
		await repos.planRuns.transitionTo(created.planRun.id, "running");
		await repos.planRuns.transitionTo(created.planRun.id, "failed", {
			failureReason: "parent_pr_merge_timeout",
		});

		const deps = await depsFor({ repos, sdSpawn: makeSdSpawn([], []) });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(`${tcpUrl(handle)}/plan-runs/${created.planRun.id}/resume`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
		expect((await repos.runs.require(parent.id)).mergeWaitStartedAt).not.toBeNull();
		expect((await repos.planRuns.require(created.planRun.id)).state).toBe("running");
	});
});
