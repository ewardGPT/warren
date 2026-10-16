/**
 * Tests for the seed-drain lane (ubuntu-6ab8).
 *
 * Three behaviours carry the contract:
 *   1. dispatch refuses a closed seed and a seed with an open blocker, and it
 *      records the seed id on the run row;
 *   2. the wait reports the failure reason for every non-merge exit and always
 *      terminates against its bound;
 *   3. closure is idempotent — a repeat close of an already-closed seed is a
 *      `noop`, and a non-merge outcome never closes anything.
 *
 * Every seam is a stub: no database, no sandbox, no GitHub, no `sd` process.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import { SEED_DRAIN_REFUSAL_REASONS, SeedDrainRefusedError } from "./errors.ts";
import { HAPPY_PROJECT, reposStub, seedsStub } from "./seed-drain.test-helpers.ts";
import {
	closeSeedAfterDrain,
	DEFAULT_SEED_DRAIN_PROMPT,
	dispatchSeedDrain,
	drainSeed,
	resolveSeedDrainRef,
	SEED_DRAIN_TRIGGER,
	type SeedDrainDispatchInput,
	type SeedDrainOutcome,
} from "./seed-drain.ts";

/* ----------------------------------------------------------------------- */
/* Dispatch                                                                */
/* ----------------------------------------------------------------------- */

describe("dispatchSeedDrain", () => {
	function dispatchInput(
		over: Partial<SeedDrainDispatchInput> & { seedId?: string } = {},
	): SeedDrainDispatchInput {
		const { seedId, ...rest } = over;
		return {
			repos: reposStub([HAPPY_PROJECT]) as unknown as Repos,
			runtimeProvider: {} as SeedDrainDispatchInput["runtimeProvider"],
			seedsCli: seedsStub({}),
			agentName: "claude-code",
			seed: { projectId: HAPPY_PROJECT.id, seedId: seedId ?? "ubuntu-6ab8" },
			...rest,
		};
	}

	test("records seed_id on the run and dispatches with the seed-drain trigger", async () => {
		const calls: Array<Record<string, unknown>> = [];
		const result = await dispatchSeedDrain({
			...dispatchInput({
				seedId: "ubuntu-6ab8",
				seedsCli: seedsStub({
					"ubuntu-6ab8": { status: "open", title: "Drain a seed", description: "Do the work." },
				}),
			}),
			spawnRunFn: (async (input: Record<string, unknown>) => {
				calls.push(input);
				return { run: { id: "run_abc" } };
			}) as unknown as SeedDrainDispatchInput["spawnRunFn"],
		});

		expect(result.runId).toBe("run_abc");
		expect(calls[0]?.seedId).toBe("ubuntu-6ab8");
		expect(calls[0]?.projectId).toBe(HAPPY_PROJECT.id);
		expect(calls[0]?.trigger).toBe(SEED_DRAIN_TRIGGER);
		// The seed's own text is inlined into the prompt (no caller input needed).
		expect(result.prompt).toContain("Drain a seed");
		expect(result.prompt).toContain("Do the work.");
		expect(result.prompt).toContain("ubuntu-6ab8");
	});

	test("uses the default template when none is supplied", async () => {
		const result = await dispatchSeedDrain({
			...dispatchInput({
				seedsCli: seedsStub({ "ubuntu-6ab8": { status: "open", title: "T" } }),
			}),
			spawnRunFn: (async () => ({
				run: { id: "run_abc" },
			})) as unknown as SeedDrainDispatchInput["spawnRunFn"],
		});
		// The template's `{seed_id}`/`{seed_body}` tokens are resolved, not echoed.
		expect(result.prompt).not.toContain("{seed_id}");
		expect(result.prompt).not.toContain("{seed_body}");
		const prefix = DEFAULT_SEED_DRAIN_PROMPT.split("{seed_id}")[0] as string;
		expect(result.prompt.startsWith(prefix)).toBe(true);
	});

	test("refuses a closed seed", async () => {
		const err = await dispatchSeedDrain(
			dispatchInput({
				seedsCli: seedsStub({ "ubuntu-6ab8": { status: "closed" } }),
			}),
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SeedDrainRefusedError);
		expect((err as SeedDrainRefusedError).reason).toBe("seed_closed");
	});

	test("refuses a seed with an open blocker", async () => {
		const err = await dispatchSeedDrain(
			dispatchInput({
				seedsCli: seedsStub(
					{ "ubuntu-6ab8": { status: "open", blockedBy: ["ubuntu-aaaa", "ubuntu-bbbb"] } },
					{ "ubuntu-aaaa": "open", "ubuntu-bbbb": "closed" },
				),
			}),
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SeedDrainRefusedError);
		expect((err as SeedDrainRefusedError).reason).toBe("seed_blocked");
		expect((err as Error).message).toContain("ubuntu-aaaa");
		// A closed blocker does not refuse the drain.
		expect((err as Error).message).not.toContain("ubuntu-bbbb");
	});

	test("dispatches a blocked seed once every blocker closes", async () => {
		const result = await dispatchSeedDrain({
			...dispatchInput({
				seedsCli: seedsStub(
					{ "ubuntu-6ab8": { status: "open", blockedBy: ["ubuntu-aaaa"] } },
					{ "ubuntu-aaaa": "closed" },
				),
			}),
			spawnRunFn: (async () => ({
				run: { id: "run_abc" },
			})) as unknown as SeedDrainDispatchInput["spawnRunFn"],
		});
		expect(result.runId).toBe("run_abc");
	});

	test("refuses a project without .seeds/", async () => {
		const err = await dispatchSeedDrain(
			dispatchInput({
				repos: reposStub([{ ...HAPPY_PROJECT, hasSeeds: false }]) as unknown as Repos,
			}),
		).catch((e: unknown) => e);
		expect((err as SeedDrainRefusedError).reason).toBe("project_lacks_seeds");
	});

	test("every refusal reason is a stable code", () => {
		expect([...SEED_DRAIN_REFUSAL_REASONS].sort()).toEqual([
			"project_lacks_seeds",
			"seed_blocked",
			"seed_closed",
			"seed_not_found",
		]);
	});
});

/* ----------------------------------------------------------------------- */
/* Closure                                                                 */
/* ----------------------------------------------------------------------- */

describe("closeSeedAfterDrain", () => {
	const MERGED: SeedDrainOutcome = {
		kind: "merged",
		runId: "run_abc",
		state: "succeeded",
		failureReason: null,
		prUrl: "https://github.com/x/y/pull/1",
		detail: "the pull request merged",
		waitedMs: 5,
		polls: 1,
	};

	function closeInput(outcome: SeedDrainOutcome, closeFn: () => Promise<unknown>) {
		return {
			seedId: "ubuntu-6ab8",
			outcome,
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedsCli: seedsStub({}),
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
			gitBinary: "git",
			closeFn: closeFn as never,
		};
	}

	test("closes the seed when the PR merged", async () => {
		let calls = 0;
		const result = await closeSeedAfterDrain(
			closeInput(MERGED, async () => {
				calls += 1;
				return { kind: "closed", branch: "main" };
			}),
		);
		expect(result).toEqual({ kind: "closed", seedId: "ubuntu-6ab8", branch: "main" });
		expect(calls).toBe(1);
	});

	test("a second close of the same merged seed is a noop, not a second commit", async () => {
		const result = await closeSeedAfterDrain(closeInput(MERGED, async () => ({ kind: "noop" })));
		expect(result).toEqual({ kind: "noop", seedId: "ubuntu-6ab8" });
	});

	test("never closes a seed whose work did not land", async () => {
		let calls = 0;
		for (const kind of [
			"run_failed",
			"run_cancelled",
			"run_succeeded_no_pr",
			"pr_closed_unmerged",
			"run_missing",
			"timed_out",
		] as const) {
			const result = await closeSeedAfterDrain(
				closeInput({ ...MERGED, kind }, async () => {
					calls += 1;
					return { kind: "closed", branch: "main" };
				}),
			);
			expect(result.kind).toBe("skipped");
			expect(result).toMatchObject({ reason: kind });
		}
		expect(calls).toBe(0);
	});
});

/* ----------------------------------------------------------------------- */
/* Resolution                                                              */
/* ----------------------------------------------------------------------- */

describe("resolveSeedDrainRef", () => {
	test("resolves the seed's home project without the caller naming it", async () => {
		const ref = await resolveSeedDrainRef({
			repos: reposStub([
				{ ...HAPPY_PROJECT, id: "prj_other", hasSeeds: false },
				{ ...HAPPY_PROJECT, id: "prj_home" },
			]) as unknown as Repos,
			seedsCli: seedsStub({ "ubuntu-6ab8": { status: "open", title: "T" } }),
			seedId: "ubuntu-6ab8",
		});
		expect(ref.projectId).toBe("prj_home");
		expect(ref.seedId).toBe("ubuntu-6ab8");
	});

	test("refuses an id no project owns", async () => {
		const err = await resolveSeedDrainRef({
			repos: reposStub([HAPPY_PROJECT]) as unknown as Repos,
			seedsCli: seedsStub({}),
			seedId: "ubuntu-missing",
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SeedDrainRefusedError);
		expect((err as SeedDrainRefusedError).reason).toBe("seed_not_found");
	});
});

/* ----------------------------------------------------------------------- */
/* Composition                                                             */
/* ----------------------------------------------------------------------- */

describe("drainSeed", () => {
	/** A real in-memory DB so the composition drives the live run-state reader. */
	async function harness() {
		const db = await openDatabase({ path: ":memory:" });
		const repos = createRepos(db);
		const projectPath = await mkdtemp(join(tmpdir(), "seed-drain-"));
		const project = await repos.projects.create({
			id: "prj_seeddrain1",
			gitUrl: "https://github.com/x/y.git",
			localPath: projectPath,
			defaultBranch: "main",
			hasSeeds: true,
		});
		const run = await repos.runs.create({
			agentName: "claude-code",
			projectId: project.id,
			renderedAgentJson: { sections: {} },
			prompt: "Implement seed ubuntu-6ab8.",
			trigger: "seed-drain",
			seedId: "ubuntu-6ab8",
		});
		return { db, repos, project, runId: run.id };
	}

	test("resolves, dispatches, waits, and closes in one call", async () => {
		const { db, repos, runId } = await harness();
		try {
			// The run terminal-succeeds with a PR the merge checker reports merged.
			await repos.runs.markRunning(runId);
			await repos.runs.finalize(runId, "succeeded", new Date());
			await repos.runs.setPrUrl(runId, "https://github.com/x/y/pull/9");

			const result = await drainSeed({
				repos,
				runtimeProvider: {} as SeedDrainDispatchInput["runtimeProvider"],
				seedsCli: seedsStub({ "ubuntu-6ab8": { status: "open", title: "Drain it" } }),
				agentName: "claude-code",
				seedId: "ubuntu-6ab8",
				spawnRunFn: (async () => ({
					run: { id: runId },
				})) as unknown as SeedDrainDispatchInput["spawnRunFn"],
				wait: { mergeState: async () => "merged", sleep: async () => undefined },
				closure: {
					spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
					gitBinary: "git",
					closeFn: (async () => ({ kind: "closed", branch: "main" })) as never,
				},
			});
			expect(result.seed.projectId).toBe("prj_seeddrain1");
			expect(result.runId).toBe(runId);
			expect(result.outcome.kind).toBe("merged");
			expect(result.closure).toEqual({ kind: "closed", seedId: "ubuntu-6ab8", branch: "main" });
		} finally {
			await db.close();
		}
	});

	test("a refusal at the dispatch gate propagates and no run is waited on", async () => {
		const { db, repos } = await harness();
		try {
			const err = await drainSeed({
				repos,
				runtimeProvider: {} as SeedDrainDispatchInput["runtimeProvider"],
				seedsCli: seedsStub({ "ubuntu-6ab8": { status: "closed" } }),
				agentName: "claude-code",
				seedId: "ubuntu-6ab8",
				wait: {},
				closure: {
					spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
					gitBinary: "git",
				},
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(SeedDrainRefusedError);
			expect((err as SeedDrainRefusedError).reason).toBe("seed_closed");
		} finally {
			await db.close();
		}
	});
});
