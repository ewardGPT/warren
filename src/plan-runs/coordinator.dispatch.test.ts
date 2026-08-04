import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Harness, NOW, neverPoll, setup } from "./coordinator.test-helpers.ts";
import { advancePlanRun, type CoordinatorSpawnFn } from "./coordinator.ts";

async function attachFailedChild(
	h: Harness,
	reason: "provider_error" | "crashed",
): Promise<string> {
	await h.repos.planRuns.transitionTo(h.planRun.id, "running", {
		startedAt: NOW.toISOString(),
	});
	const runId = await h.makeRun("warren-a");
	await h.repos.runs.markRunning(runId, NOW);
	await h.repos.runs.finalize(runId, "failed", NOW, reason);
	await h.repos.planRuns.updateChild({
		planRunId: h.planRun.id,
		seq: 1,
		patch: { runId, state: "dispatched", startedAt: NOW.toISOString() },
	});
	return runId;
}

describe("advancePlanRun — dispatch phase", () => {
	let h: Harness;

	beforeEach(async () => {
		h = await setup();
	});

	afterEach(async () => {
		await h.db.close();
	});

	test("queued → running, dispatches first child", async () => {
		const result = await advancePlanRun({
			planRun: h.planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "run_x"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("dispatched");
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("running");
		expect(reloaded.startedAt).toBe(NOW.toISOString());
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		const first = children.find((c) => c.seq === 1);
		expect(first?.state).toBe("dispatched");
		expect(first?.runId).not.toBeNull();
		expect(h.events.map((e) => e.kind)).toContain("plan_run.dispatched");
	});

	test("non-terminal child run → waiting_for_run; running run syncs child.state", async () => {
		await h.repos.planRuns.transitionTo(h.planRun.id, "running", { startedAt: NOW.toISOString() });
		const runId = await h.makeRun("warren-a");
		await h.repos.runs.markRunning(runId, NOW);
		await h.repos.planRuns.updateChild({
			planRunId: h.planRun.id,
			seq: 1,
			patch: { runId, state: "dispatched", startedAt: NOW.toISOString() },
		});
		const planRun = await h.repos.planRuns.require(h.planRun.id);
		const result = await advancePlanRun({
			planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("waiting_for_run");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("running");
	});

	test("dispatch failure → plan_failed with dispatch_failed:<message>", async () => {
		const failingSpawn: CoordinatorSpawnFn = async () => {
			throw new Error("burrow unreachable");
		};
		const result = await advancePlanRun({
			planRun: h.planRun,
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: failingSpawn,
			emit: h.emit,
			now: () => NOW,
		});
		expect(result.kind).toBe("plan_failed");
		if (result.kind === "plan_failed") {
			expect(result.reason).toBe("dispatch_failed:burrow unreachable");
			expect(result.failedSeq).toBe(1);
		}
		const reloaded = await h.repos.planRuns.require(h.planRun.id);
		expect(reloaded.state).toBe("failed");
		expect(reloaded.failureReason).toBe("dispatch_failed:burrow unreachable");
		const children = await h.repos.planRuns.listChildren(h.planRun.id);
		expect(children.find((c) => c.seq === 1)?.state).toBe("failed");
	});

	test("retries a provider-error child once and dispatches the same seed again", async () => {
		await attachFailedChild(h, "provider_error");
		const result = await advancePlanRun({
			planRun: await h.repos.planRuns.require(h.planRun.id),
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "replacement"),
			emit: h.emit,
			now: () => NOW,
		});

		expect(result.kind).toBe("dispatched");
		expect(h.events.map((e) => e.kind)).toContain("plan_run.child_retry");
		const child = (await h.repos.planRuns.listChildren(h.planRun.id)).find((c) => c.seq === 1);
		expect(child?.state).toBe("dispatched");
		expect(child?.runId).not.toBeNull();
		expect(child?.failureReason).toBe("provider_error_retry_attempted");
	});

	test("provider-error retry exhaustion fails the child and plan", async () => {
		await attachFailedChild(h, "provider_error");
		await advancePlanRun({
			planRun: await h.repos.planRuns.require(h.planRun.id),
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "replacement"),
			emit: h.emit,
			now: () => NOW,
		});
		const replacement = (await h.repos.planRuns.listChildren(h.planRun.id)).find(
			(c) => c.seq === 1,
		);
		if (replacement?.runId === null || replacement === undefined)
			throw new Error("replacement missing");
		await h.repos.runs.markRunning(replacement.runId, NOW);
		await h.repos.runs.finalize(replacement.runId, "failed", NOW, "provider_error");

		const result = await advancePlanRun({
			planRun: await h.repos.planRuns.require(h.planRun.id),
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

		expect(result).toEqual({ kind: "plan_failed", failedSeq: 1, reason: "child_provider_error" });
		expect((await h.repos.planRuns.require(h.planRun.id)).failureReason).toBe(
			"child_provider_error",
		);
		expect(h.events.filter((e) => e.kind === "plan_run.child_retry")).toHaveLength(1);
	});

	test("non-provider child failures remain terminal without retry", async () => {
		await attachFailedChild(h, "crashed");
		const result = await advancePlanRun({
			planRun: await h.repos.planRuns.require(h.planRun.id),
			repos: h.repos,
			showSeed: h.showSeedStub("open"),
			checkPrMerged: neverPoll,
			spawn: h.spawnStub(() => "unused"),
			emit: h.emit,
			now: () => NOW,
		});

		expect(result).toEqual({ kind: "plan_failed", failedSeq: 1, reason: "child_crashed" });
		expect(h.events.filter((e) => e.kind === "plan_run.child_retry")).toHaveLength(0);
	});
});
