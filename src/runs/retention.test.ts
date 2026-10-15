/**
 * Tests for the age-based `never_started` sweep (ubuntu-4f98).
 *
 * Every case runs against a real temp sqlite handle (`withDb`), so the
 * predicate and the transaction are the ones production uses — only the
 * clock and the page size are injected.
 */

import { describe, expect, test } from "bun:test";
import type { SqliteWarrenDb } from "../db/client.ts";
import { AgentsRepo } from "../db/repos/agents.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { EventsRepo } from "../db/repos/events.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { RunsRepo } from "../db/repos/runs.ts";
import type { RunFailureReason } from "../db/schema.ts";
import { type TestDbHandle, withDb } from "../db/testing.ts";
import { pruneNeverStartedRuns, type RetentionRunsRepo } from "./retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed sweep clock: every fixture date below is relative to this. */
const NOW = new Date("2026-06-01T00:00:00.000Z");
const OLD = "2026-01-01T00:00:00.000Z";
const FRESH = "2026-05-31T00:00:00.000Z";

/** A temp sqlite handle plus the repos and fixtures the sweep needs. */
interface Harness {
	handle: TestDbHandle<SqliteWarrenDb>;
	runs: RunsRepo;
	events: EventsRepo;
	agents: AgentsRepo;
	projects: ProjectsRepo;
	agentName: string;
	projectId: string;
}

async function open(): Promise<Harness> {
	const handle = await withDb({ dialect: "sqlite" });
	const adapter = DrizzleAdapter.for(handle.db);
	const repositories = {
		runs: new RunsRepo(adapter),
		events: new EventsRepo(adapter),
		agents: new AgentsRepo(adapter),
		projects: new ProjectsRepo(adapter),
	};
	const agent = await repositories.agents.upsert({
		name: "retention-bot",
		renderedJson: { sections: {} },
	});
	const project = await repositories.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	return {
		handle,
		...repositories,
		agentName: agent.name,
		projectId: project.id,
	};
}

/** A terminal run with one event, the shape an unreachable runtime leaves. */
async function seedRun(
	harness: Harness,
	terminal: {
		state: "failed" | "succeeded";
		endedAt: string;
		failureReason: RunFailureReason | null;
	},
): Promise<string> {
	const run = await harness.runs.create({
		agentName: harness.agentName,
		projectId: harness.projectId,
		prompt: "work on sd test",
		renderedAgentJson: { sections: {} },
		trigger: "manual",
	});
	await harness.runs.markRunning(run.id);
	await harness.runs.finalize(
		run.id,
		terminal.state,
		new Date(terminal.endedAt),
		terminal.failureReason,
	);
	await harness.events.append({
		runId: run.id,
		burrowEventSeq: 1,
		ts: terminal.endedAt,
		kind: "spawn_failed",
		stream: "system",
		payload: { message: "runtime unreachable" },
	});
	return run.id;
}

const sweep = (
	harness: Harness,
	overrides: { olderThanMs?: number; batchSize?: number; maxBatches?: number } = {},
) =>
	pruneNeverStartedRuns({
		runs: harness.runs,
		olderThanMs: overrides.olderThanMs ?? 7 * DAY_MS,
		batchSize: overrides.batchSize,
		maxBatches: overrides.maxBatches,
		now: () => NOW,
	});

describe("pruneNeverStartedRuns", () => {
	test("deletes aged-out never_started rows and their events, and nothing else", async () => {
		const harness = await open();
		try {
			const expired = await seedRun(harness, {
				state: "failed",
				endedAt: OLD,
				failureReason: "never_started",
			});
			const fresh = await seedRun(harness, {
				state: "failed",
				endedAt: FRESH,
				failureReason: "never_started",
			});
			const realFailure = await seedRun(harness, {
				state: "failed",
				endedAt: OLD,
				failureReason: "crashed",
			});
			const succeeded = await seedRun(harness, {
				state: "succeeded",
				endedAt: OLD,
				failureReason: null,
			});

			const result = await sweep(harness);

			expect(result.runs).toBe(1);
			expect(result.events).toBe(1);
			expect(result.batches).toBe(1);
			expect(result.exhausted).toBe(true);
			expect(result.cutoff).toBe(new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
			expect(await harness.runs.get(expired)).toBeNull();
			expect(await harness.events.listByRun(expired)).toHaveLength(0);
			// A fresh transient row, a real failure and a success all survive.
			expect(await harness.runs.get(fresh)).not.toBeNull();
			expect(await harness.runs.get(realFailure)).not.toBeNull();
			expect(await harness.runs.get(succeeded)).not.toBeNull();
			expect(await harness.events.listByRun(realFailure)).toHaveLength(1);
		} finally {
			await harness.handle.close();
		}
	});

	test("pages the backlog and reports how many batches it took", async () => {
		const harness = await open();
		try {
			for (let i = 0; i < 5; i += 1) {
				await seedRun(harness, {
					state: "failed",
					endedAt: OLD,
					failureReason: "never_started",
				});
			}

			const result = await sweep(harness, { batchSize: 2 });

			expect(result).toMatchObject({ batches: 3, runs: 5, events: 5, exhausted: true });
			expect(await harness.runs.listAll()).toHaveLength(0);
		} finally {
			await harness.handle.close();
		}
	});

	test("maxBatches caps the sweep and leaves the rest for a re-run", async () => {
		const harness = await open();
		try {
			for (let i = 0; i < 5; i += 1) {
				await seedRun(harness, {
					state: "failed",
					endedAt: OLD,
					failureReason: "never_started",
				});
			}

			const first = await sweep(harness, { batchSize: 2, maxBatches: 1 });
			expect(first).toMatchObject({ batches: 1, runs: 2, events: 2, exhausted: false });
			expect(await harness.runs.listAll()).toHaveLength(3);

			const second = await sweep(harness, { batchSize: 2, maxBatches: 1 });
			expect(second).toMatchObject({ batches: 1, runs: 2, events: 2, exhausted: false });
			expect(await harness.runs.listAll()).toHaveLength(1);
		} finally {
			await harness.handle.close();
		}
	});

	test("an exhausted backlog deletes nothing and costs no batch", async () => {
		const harness = await open();
		try {
			await seedRun(harness, {
				state: "failed",
				endedAt: FRESH,
				failureReason: "never_started",
			});

			const result = await sweep(harness);

			expect(result).toMatchObject({ batches: 0, runs: 0, events: 0, exhausted: true });
			expect(await harness.runs.listAll()).toHaveLength(1);
		} finally {
			await harness.handle.close();
		}
	});

	test("the batch delete re-checks the guard against the page it was handed", async () => {
		const harness = await open();
		try {
			const eligible = await seedRun(harness, {
				state: "failed",
				endedAt: OLD,
				failureReason: "never_started",
			});
			const dispatched = await seedRun(harness, {
				state: "failed",
				endedAt: OLD,
				failureReason: "crashed",
			});

			const deleted = await harness.runs.deleteNeverStartedBatch([eligible, dispatched]);

			expect(deleted).toEqual({ runs: 1, events: 1 });
			expect(await harness.runs.get(dispatched)).not.toBeNull();
			expect(await harness.events.listByRun(dispatched)).toHaveLength(1);
		} finally {
			await harness.handle.close();
		}
	});

	test("a page the guard rejects ends the sweep instead of re-selecting it", async () => {
		// The page is chosen outside the delete's transaction, so a row that
		// dispatched in between makes the delete a no-op. Retrying would select
		// the same ids forever; the sweep must stop and report the cap.
		let selects = 0;
		const stuck: RetentionRunsRepo = {
			async listExpiredNeverStartedIds() {
				selects += 1;
				return ["run_stuck"];
			},
			async deleteNeverStartedBatch() {
				return { runs: 0, events: 0 };
			},
		};

		const result = await pruneNeverStartedRuns({
			runs: stuck,
			olderThanMs: DAY_MS,
			now: () => NOW,
		});

		expect(result).toMatchObject({ batches: 1, runs: 0, events: 0, exhausted: false });
		expect(selects).toBe(1);
	});

	test("rejects a non-positive batch size and a negative cutoff", async () => {
		const harness = await open();
		try {
			await expect(sweep(harness, { batchSize: 0 })).rejects.toThrow(/batchSize/);
			await expect(
				pruneNeverStartedRuns({ runs: harness.runs, olderThanMs: -1, now: () => NOW }),
			).rejects.toThrow(/olderThanMs/);
			await expect(sweep(harness, { maxBatches: -2 })).rejects.toThrow(/maxBatches/);
		} finally {
			await harness.handle.close();
		}
	});
});
