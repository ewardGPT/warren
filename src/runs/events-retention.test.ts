/**
 * Tests for the age-based `events` sweep (ubuntu-057f).
 *
 * Every case runs against a real temp sqlite handle (`withDb`), so the
 * predicates and the transactions are the ones production uses — only the
 * clock and the page size are injected.
 */

import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import type { SqliteWarrenDb } from "../db/client.ts";
import { AgentsRepo } from "../db/repos/agents.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { EventsRepo } from "../db/repos/events.ts";
import { ProjectsRepo } from "../db/repos/projects.ts";
import { RunsRepo } from "../db/repos/runs.ts";
import type { RunFailureReason, RunTerminalState } from "../db/schema.ts";
import { type TestDbHandle, withDb } from "../db/testing.ts";
import { pruneRunEvents } from "./events-retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Fixed sweep clock: every fixture date below is relative to this. */
const NOW = new Date("2026-06-01T00:00:00.000Z");
/** Well past the 30d window. */
const OLD = "2026-01-01T00:00:00.000Z";
/** Inside the 30d window — one day ago. */
const FRESH = "2026-05-31T00:00:00.000Z";

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

/** A terminal run that ended at `endedAt`, carrying `eventCount` events. */
async function seedTerminalRun(
	harness: Harness,
	terminal: {
		state: RunTerminalState;
		endedAt: string;
		failureReason?: RunFailureReason | null;
	},
	eventCount = 1,
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
		terminal.failureReason ?? null,
	);
	for (let i = 1; i <= eventCount; i += 1) {
		await harness.events.append({
			runId: run.id,
			burrowEventSeq: i,
			ts: terminal.endedAt,
			kind: "agent_message",
			stream: "stdout",
			payload: { text: `line ${i}` },
		});
	}
	return run.id;
}

/** A run still in flight — it has not reached a terminal state. */
async function seedRunningRun(harness: Harness, eventCount = 1): Promise<string> {
	const run = await harness.runs.create({
		agentName: harness.agentName,
		projectId: harness.projectId,
		prompt: "still going",
		renderedAgentJson: { sections: {} },
		trigger: "manual",
	});
	await harness.runs.markRunning(run.id);
	for (let i = 1; i <= eventCount; i += 1) {
		await harness.events.append({
			runId: run.id,
			burrowEventSeq: i,
			ts: "2025-01-01T00:00:00.000Z",
			kind: "agent_message",
			stream: "stdout",
			payload: { text: `old line ${i}` },
		});
	}
	return run.id;
}

const sweep = (
	harness: Harness,
	overrides: {
		olderThanMs?: number;
		apply?: boolean;
		batchSize?: number;
		maxBatches?: number;
	} = {},
) =>
	pruneRunEvents({
		events: harness.events,
		olderThanMs: overrides.olderThanMs ?? 30 * DAY_MS,
		apply: overrides.apply,
		batchSize: overrides.batchSize,
		maxBatches: overrides.maxBatches,
		now: () => NOW,
	});

describe("pruneRunEvents: dry-run (default)", () => {
	test("reports the window's rows and bytes and deletes nothing", async () => {
		const harness = await open();
		try {
			const expiredA = await seedTerminalRun(harness, { state: "succeeded", endedAt: OLD }, 3);
			const expiredB = await seedTerminalRun(harness, { state: "cancelled", endedAt: OLD }, 2);
			const fresh = await seedTerminalRun(harness, { state: "failed", endedAt: FRESH }, 2);
			const running = await seedRunningRun(harness, 2);

			const result = await sweep(harness);

			expect(result.dryRun).toBe(true);
			expect(result.batches).toBe(0);
			expect(result.runs).toBe(2);
			expect(result.events).toBe(5);
			expect(result.bytes).toBeGreaterThan(0);
			expect(result.cutoff).toBe(new Date(NOW.getTime() - 30 * DAY_MS).toISOString());

			// Nothing was deleted — every row is exactly where it was.
			expect(await harness.events.countByRun(expiredA)).toBe(3);
			expect(await harness.events.countByRun(expiredB)).toBe(2);
			expect(await harness.events.countByRun(fresh)).toBe(2);
			expect(await harness.events.countByRun(running)).toBe(2);
		} finally {
			await harness.handle.close();
		}
	});
});

describe("pruneRunEvents: apply", () => {
	test("removes only events of terminal runs inside the window", async () => {
		const harness = await open();
		try {
			const expiredA = await seedTerminalRun(harness, { state: "succeeded", endedAt: OLD }, 3);
			const expiredB = await seedTerminalRun(harness, { state: "cancelled", endedAt: OLD }, 2);
			const fresh = await seedTerminalRun(harness, { state: "failed", endedAt: FRESH }, 2);
			const running = await seedRunningRun(harness, 2);

			const result = await sweep(harness, { apply: true });

			expect(result).toMatchObject({
				dryRun: false,
				batches: 1,
				runs: 2,
				events: 5,
				exhausted: true,
			});
			expect(result.bytes).toBeGreaterThan(0);

			// Expired terminal runs lost their transcripts; the run ROWS survive.
			expect(await harness.events.countByRun(expiredA)).toBe(0);
			expect(await harness.events.countByRun(expiredB)).toBe(0);
			expect(await harness.runs.get(expiredA)).not.toBeNull();
			expect(await harness.runs.get(expiredB)).not.toBeNull();
			// A young terminal run and an in-flight run keep every event.
			expect(await harness.events.countByRun(fresh)).toBe(2);
			expect(await harness.events.countByRun(running)).toBe(2);
		} finally {
			await harness.handle.close();
		}
	});

	test("never touches the events of a run that has not reached a terminal state", async () => {
		const harness = await open();
		try {
			// Its events are older than the window, but the run is still going.
			const running = await seedRunningRun(harness, 4);

			const result = await sweep(harness, { apply: true });

			expect(result).toMatchObject({ runs: 0, events: 0, batches: 0, exhausted: true });
			expect(await harness.events.countByRun(running)).toBe(4);
		} finally {
			await harness.handle.close();
		}
	});

	test("pages the backlog, advances past pruned runs, and is resumable", async () => {
		const harness = await open();
		try {
			for (let i = 0; i < 5; i += 1) {
				await seedTerminalRun(harness, { state: "succeeded", endedAt: OLD }, 2);
			}

			const first = await sweep(harness, { apply: true, batchSize: 2, maxBatches: 1 });
			expect(first).toMatchObject({ batches: 1, runs: 2, events: 4, exhausted: false });

			// The pruned runs no longer qualify, so a re-run advances instead of
			// re-selecting them.
			const second = await sweep(harness, { apply: true, batchSize: 10 });
			expect(second).toMatchObject({ batches: 1, runs: 3, events: 6, exhausted: true });

			const third = await sweep(harness, { apply: true });
			expect(third).toMatchObject({ runs: 0, events: 0, exhausted: true });
		} finally {
			await harness.handle.close();
		}
	});
});

describe("pruneRunEvents: the 7-day floor", () => {
	test("refuses a window below seven days", async () => {
		const harness = await open();
		try {
			await expect(sweep(harness, { olderThanMs: DAY_MS, apply: true })).rejects.toBeInstanceOf(
				ValidationError,
			);
			await expect(sweep(harness, { olderThanMs: 6 * DAY_MS })).rejects.toThrow(/7 days/);
		} finally {
			await harness.handle.close();
		}
	});

	test("a window of exactly seven days is allowed", async () => {
		const harness = await open();
		try {
			const result = await sweep(harness, { olderThanMs: 7 * DAY_MS });
			expect(result.cutoff).toBe(new Date(NOW.getTime() - 7 * DAY_MS).toISOString());
		} finally {
			await harness.handle.close();
		}
	});
});
