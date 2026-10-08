import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Repos } from "../db/repos/index.ts";
import type { RunRow } from "../db/schema.ts";
import type { RunHandle, RuntimeProvider } from "../runtime/contract.ts";
import { FORCE_CONTINUE_TRIGGER } from "./reap/run-evidence.ts";
import { createRepos, openDatabase } from "./reap/test-helpers.ts";
import type { ReapExec } from "./reap/types.ts";
import {
	maybeStallPrune,
	STALL_PRUNE_EVENT,
	type StallPruneDeps,
	type StallTrackerState,
} from "./stall-prune.ts";

const NOW = new Date("2026-10-08T00:00:00.000Z");

function stubProvider(workspacePath: string | null, cancels: string[]): RuntimeProvider {
	// Partial seam stub — watchdog test-helpers precedent.
	return {
		workspaceInfo: async () => ({ workspacePath, branch: null }),
		cancel: async (handle: RunHandle) => {
			cancels.push(handle.providerRunId);
		},
	} as unknown as RuntimeProvider;
}

function mutableExec(initial: { head?: string; dirty?: boolean } = {}): ReapExec & {
	head: string;
	dirty: boolean;
	calls: number;
} {
	const tool: ReapExec & { head: string; dirty: boolean; calls: number } = {
		head: initial.head ?? "abc123",
		dirty: initial.dirty ?? false,
		calls: 0,
		run: async (_cmd: string, args: readonly string[]) => {
			tool.calls += 1;
			if (args[0] === "rev-parse") return { stdout: `${tool.head}\n`, stderr: "" };
			if (args[0] === "status") {
				return tool.dirty ? { stdout: " M src/foo.ts\n", stderr: "" } : { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		},
	};
	return tool;
}

async function seedTheIter(run: RunRow, count: number): Promise<void> {
	for (let i = 0; i < count; i += 1) {
		await repos.events.append({
			runId: run.id,
			burrowEventSeq: ((await repos.events.maxSeqForRun(run.id)) ?? 0) + 1,
			ts: NOW.toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "x" },
		});
	}
}

let db: Awaited<ReturnType<typeof openDatabase>>;
let repos: Repos;

async function makeRun(over: Partial<RunRow> = {}): Promise<RunRow> {
	return repos.runs.create({
		...over,
		agentName: over.agentName ?? "refactor-bot",
		projectId: over.projectId ?? "prj_t",
		prompt: "p",
		renderedAgentJson: {},
		trigger: "manual",
		burrowId: "bur_1",
		burrowRunId: "run_1",
	});
}

function deps(over: Partial<StallPruneDeps> = {}): StallPruneDeps {
	return {
		repos,
		runtimeProvider: stubProvider("/data/burrow/ws", []),
		reap: async () => {},
		stallPrune: {
			enabled: true,
			minEvents: 1,
			eventsPerSample: 1,
			streakThreshold: 3,
		},
		...over,
	};
}

describe("maybeStallPrune gates", () => {
	let states: Map<string, StallTrackerState>;
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.projects.create({
			id: "prj_t",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		states = new Map();
	});
	afterEach(async () => {
		await db.close();
	});

	test("disabled config never touches the workspace", async () => {
		const run = await makeRun();
		await seedTheIter(run, 5);
		const cancellations: string[] = [];
		const reaped: unknown[] = [];
		await maybeStallPrune(
			deps({
				runtimeProvider: stubProvider("/data/burrow/ws", cancellations),
				stallPrune: { enabled: false },
				reap: async (input) => void reaped.push(input),
			}),
			run,
			states,
			NOW,
		);
		expect(cancellations).toEqual([]);
		expect(reaped).toEqual([]);
		expect(states.size).toBe(0);
	});

	test("non-batch modes are skipped", async () => {
		const run = await makeRun({ mode: "conversation" as unknown as RunRow["mode"] });
		await seedTheIter(run, 5);
		const cancellations: string[] = [];
		await maybeStallPrune(
			deps({ runtimeProvider: stubProvider("/data/burrow/ws", cancellations) }),
			run,
			states,
			NOW,
		);
		expect(cancellations).toEqual([]);
		expect(states.size).toBe(0);
	});

	test("forced-continuation lineage is never pruned", async () => {
		const parent = await makeRun({ id: "run_parent", burrowRunId: "run_parent" });
		const child = await makeRun({
			id: "run_child",
			parentRunId: parent.id,
			trigger: FORCE_CONTINUE_TRIGGER,
		});
		await seedTheIter(child, 5);
		const cancellations: string[] = [];
		await maybeStallPrune(
			deps({ runtimeProvider: stubProvider("/data/burrow/ws", cancellations) }),
			child,
			states,
			NOW,
		);
		expect(cancellations).toEqual([]);
		expect(states.size).toBe(0);
	});

	test("a missing workspace is skipped", async () => {
		const run = await makeRun();
		await seedTheIter(run, 5);
		const cancellations: string[] = [];
		await maybeStallPrune(
			deps({ runtimeProvider: stubProvider(null, cancellations) }),
			run,
			states,
			NOW,
		);
		expect(cancellations).toEqual([]);
		expect(states.size).toBe(0);
	});

	test("runs below the minimum event count are not sampled", async () => {
		const run = await makeRun();
		await seedTheIter(run, 1);
		const exec = mutableExec();
		const cancellations: string[] = [];
		await maybeStallPrune(
			deps({
				runtimeProvider: stubProvider("/data/burrow/ws", cancellations),
				stallPrune: { enabled: true, minEvents: 4, eventsPerSample: 1, streakThreshold: 3, exec },
			}),
			run,
			states,
			NOW,
		);
		expect(exec.calls).toBe(0);
		expect(states.size).toBe(0);
	});
});

describe("maybeStallPrune sampling", () => {
	let states: Map<string, StallTrackerState>;
	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.projects.create({
			id: "prj_t",
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		states = new Map();
	});
	afterEach(async () => {
		await db.close();
	});

	test("three no-progress samples stall the run: salvage, cancel, stalled reap", async () => {
		const run = await makeRun();
		await seedTheIter(run, 2);
		const cancelled: string[] = [];
		const reaped: Array<{ runId: string; outcome: string; failureReason: string }> = [];
		const exec = mutableExec();
		const d = deps({
			runtimeProvider: stubProvider("/data/burrow/ws", cancelled),
			reap: async (input) =>
				void reaped.push({
					runId: input.runId,
					outcome: input.outcome,
					failureReason: input.failureReason,
				}),
			stallPrune: {
				enabled: true,
				minEvents: 1,
				eventsPerSample: 2,
				streakThreshold: 3,
				exec,
			},
		});
		await maybeStallPrune(d, run, states, NOW);
		expect(states.get(run.id)?.streak).toBe(1);
		await seedTheIter(run, 2);
		await maybeStallPrune(d, run, states, NOW);
		expect(states.get(run.id)?.streak).toBe(2);
		await seedTheIter(run, 2);
		await maybeStallPrune(d, run, states, NOW);
		expect(states.get(run.id)).toBeUndefined();
		expect(cancelled).toEqual(["run_1"]);
		expect(reaped).toEqual([{ runId: run.id, outcome: "failed", failureReason: "stalled" }]);
		const events = await repos.events.listByRun(run.id);
		expect(events.some((ev) => ev.kind === STALL_PRUNE_EVENT)).toBe(true);
		expect(events.some((ev) => ev.kind === "reap.workspace_salvaged")).toBe(true);
	});

	test("a dirty tree resets the streak", async () => {
		const run = await makeRun();
		await seedTheIter(run, 1);
		const cancelled: string[] = [];
		const exec = mutableExec({ dirty: false });
		const d = deps({
			runtimeProvider: stubProvider("/data/burrow/ws", cancelled),
			stallPrune: { enabled: true, minEvents: 1, eventsPerSample: 1, streakThreshold: 3, exec },
		});
		await maybeStallPrune(d, run, states, NOW);
		expect(states.get(run.id)?.streak).toBe(1);
		exec.dirty = true;
		await seedTheIter(run, 1);
		await maybeStallPrune(d, run, states, NOW);
		expect(states.get(run.id)?.streak).toBe(0);
		expect(cancelled).toEqual([]);
	});

	test("a moving HEAD counts as progress", async () => {
		const run = await makeRun();
		await seedTheIter(run, 1);
		const cancelled: string[] = [];
		const exec = mutableExec();
		const d = deps({
			runtimeProvider: stubProvider("/data/burrow/ws", cancelled),
			stallPrune: { enabled: true, minEvents: 1, eventsPerSample: 1, streakThreshold: 3, exec },
		});
		await maybeStallPrune(d, run, states, NOW);
		expect(states.get(run.id)?.streak).toBe(1);
		exec.head = "def456";
		await seedTheIter(run, 1);
		await maybeStallPrune(d, run, states, NOW);
		expect(states.get(run.id)?.streak).toBe(0);
		expect(cancelled).toEqual([]);
	});
});
