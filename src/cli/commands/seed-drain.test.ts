/**
 * Tests for the `warren seed-drain` command surface (ubuntu-6ab8).
 *
 * The command is wiring: it maps a settled drain onto an exit code and a
 * refusal onto exit 2. The lane itself is covered in
 * `src/runs/seed-drain.test.ts`; here the drain is a stub.
 */

import { describe, expect, test } from "bun:test";
import type { Repos } from "../../db/repos/index.ts";
import { type SeedDrainOutcomeKind, SeedDrainRefusedError } from "../../runs/index.ts";
import type { DrainSeedResult, drainSeed } from "../../runs/seed-drain.ts";
import type { CliContext } from "../output.ts";
import { runSeedDrain, type SeedDrainDeps } from "./seed-drain.ts";

function capture(): { context: CliContext; stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		context: {
			env: {},
			stdio: {
				stdout: { write: (s: string) => stdout.push(s) },
				stderr: { write: (s: string) => stderr.push(s) },
			},
			spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
		},
		stdout,
		stderr,
	};
}

function resultFor(kind: SeedDrainOutcomeKind): DrainSeedResult {
	return {
		seed: { projectId: "prj_x", seedId: "ubuntu-6ab8" },
		runId: "run_abc",
		prompt: "Implement seed ubuntu-6ab8.",
		outcome: {
			kind,
			runId: "run_abc",
			state: kind === "merged" || kind === "run_succeeded_no_pr" ? "succeeded" : "failed",
			failureReason: kind === "run_failed" ? "crashed" : null,
			prUrl: "https://github.com/x/y/pull/1",
			detail: kind === "run_failed" ? "the run failed: crashed" : `kind=${kind}`,
			waitedMs: 12,
			polls: 2,
		},
		closure:
			kind === "merged"
				? { kind: "closed", seedId: "ubuntu-6ab8", branch: "main" }
				: { kind: "skipped", seedId: "ubuntu-6ab8", reason: kind },
	};
}

function depsFor(drain: typeof drainSeed): SeedDrainDeps {
	return {
		repos: {} as Repos,
		runtimeProvider: {} as SeedDrainDeps["runtimeProvider"],
		seedsCli: { sdBinary: "sd", spawn: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
		drain,
	};
}

const ARGS = { seedId: "ubuntu-6ab8", agent: "claude-code" };

describe("runSeedDrain", () => {
	test("exit 0 when the PR merged and the seed closed", async () => {
		const { context, stdout } = capture();
		const result = await runSeedDrain(
			context,
			depsFor(async () => resultFor("merged")),
			ARGS,
		);
		expect(result.exitCode).toBe(0);
		expect(result.runId).toBe("run_abc");
		const line = JSON.parse((stdout[0] ?? "").trim()) as Record<string, unknown>;
		expect(line.event).toBe("seed.drained");
		expect(line.outcome).toBe("merged");
		expect(line.closure).toBe("closed");
	});

	test("exit 1 when the run failed, and the failure reason is reported", async () => {
		const { context, stderr, stdout } = capture();
		const result = await runSeedDrain(
			context,
			depsFor(async () => resultFor("run_failed")),
			ARGS,
		);
		expect(result.exitCode).toBe(1);
		expect(stderr.join("")).toContain("crashed");
		const line = JSON.parse((stdout[0] ?? "").trim()) as Record<string, unknown>;
		expect(line.failureReason).toBe("crashed");
	});

	test("exit 1 when the wait timed out", async () => {
		const { context } = capture();
		const result = await runSeedDrain(
			context,
			depsFor(async () => resultFor("timed_out")),
			ARGS,
		);
		expect(result.exitCode).toBe(1);
	});

	test("exit 3 when the run succeeded with no PR or the PR closed unmerged", async () => {
		const { context } = capture();
		expect(
			(
				await runSeedDrain(
					context,
					depsFor(async () => resultFor("run_succeeded_no_pr")),
					ARGS,
				)
			).exitCode,
		).toBe(3);
		expect(
			(
				await runSeedDrain(
					context,
					depsFor(async () => resultFor("pr_closed_unmerged")),
					ARGS,
				)
			).exitCode,
		).toBe(3);
	});

	test("exit 2 when the lane refuses the seed, and no run was dispatched", async () => {
		const { context, stderr } = capture();
		const result = await runSeedDrain(
			context,
			depsFor(async () => {
				throw new SeedDrainRefusedError("seed_closed", "seed ubuntu-6ab8 is already closed");
			}),
			ARGS,
		);
		expect(result.exitCode).toBe(2);
		expect(result.runId).toBeNull();
		expect(stderr.join("")).toContain("already closed");
	});

	test("exit 2 without calling the lane when the arguments are empty", async () => {
		const { context, stderr } = capture();
		let calls = 0;
		const result = await runSeedDrain(
			context,
			depsFor(async () => {
				calls += 1;
				return resultFor("merged");
			}),
			{ seedId: "", agent: "claude-code" },
		);
		expect(result.exitCode).toBe(2);
		expect(calls).toBe(0);
		expect(stderr.join("")).toContain("required");
	});
});
