import { describe, expect, test } from "bun:test";
import { WARREN_BOT_IDENTITY } from "../bot-identity.ts";
import type { SpawnFn } from "../projects/index.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import { closeMergedChildSeed } from "./close-child-seed.ts";

interface SpawnCall {
	cmd: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
}

/**
 * Stub git spawn. `dirtyAfterClose` controls whether `git status` reports a
 * pending change to `.seeds/issues.jsonl` (i.e. the seed was actually open on
 * the default branch), and `pushExit` lets a test force a push failure.
 *
 * `nonFastForwardCount` makes the Nth push a non-fast-forward rejection so
 * tests can drive the concurrent-writer recovery path: the first push is
 * refused (another warren process pinned a tick `sd update` onto default),
 * the retry re-fetches origin and re-applies the idempotent close, and the
 * second push succeeds convergently.
 */
function makeGitSpawn(opts: {
	dirtyAfterClose: boolean;
	pushExit?: number;
	nonFastForwardCount?: number;
}): {
	spawn: SpawnFn;
	calls: SpawnCall[];
} {
	const calls: SpawnCall[] = [];
	let pushAttempts = 0;
	const spawn: SpawnFn = async (cmd, spawnOpts) => {
		calls.push({ cmd: cmd as string[], cwd: spawnOpts.cwd, env: spawnOpts.env });
		if (cmd.includes("status")) {
			return {
				stdout: opts.dirtyAfterClose ? " M .seeds/issues.jsonl\n" : "",
				stderr: "",
				exitCode: 0,
			};
		}
		if (cmd.includes("push")) {
			pushAttempts += 1;
			if ((opts.nonFastForwardCount ?? 0) >= pushAttempts) {
				// `fetch first` is a canonical non-fast-forward rejection.
				return {
					stdout: "",
					stderr: " ! [rejected] main -> main (fetch first)",
					exitCode: 1,
				};
			}
			return { stdout: "", stderr: "denied", exitCode: opts.pushExit ?? 0 };
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	};
	return { spawn, calls };
}

function makeSeedsCli(): { seedsCli: SeedsCliDeps; calls: SpawnCall[] } {
	const calls: SpawnCall[] = [];
	const seedsCli: SeedsCliDeps = {
		sdBinary: "sd",
		spawn: async (cmd, spawnOpts) => {
			calls.push({ cmd: cmd as string[], cwd: spawnOpts.cwd });
			return { stdout: "", stderr: "", exitCode: 0 };
		},
	};
	return { seedsCli, calls };
}

describe("closeMergedChildSeed", () => {
	test("closes an open seed on the default branch and pushes", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true });
		const { seedsCli, calls: sdCalls } = makeSeedsCli();
		const result = await closeMergedChildSeed({
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedId: "warren-3f09",
			seedsCli,
			spawn,
			gitBinary: "git",
		});

		expect(result.kind).toBe("closed");
		if (result.kind === "closed") expect(result.branch).toBe("main");

		// sd close ran inside the throwaway worktree, not the project clone.
		expect(sdCalls).toHaveLength(1);
		expect(sdCalls[0]?.cmd).toEqual(["sd", "close", "warren-3f09"]);
		expect(sdCalls[0]?.cwd).not.toBe("/data/projects/x/y");

		const has = (sub: string) => calls.some((c) => c.cmd.includes(sub));
		expect(has("fetch")).toBe(true);
		expect(has("worktree")).toBe(true);
		expect(has("commit")).toBe(true);
		expect(has("push")).toBe(true);

		// The commit pins the WARREN_BOT_IDENTITY (env + `-c` config) and skips hooks.
		const commit = calls.find((c) => c.cmd.includes("commit"));
		expect(commit?.cmd).toContain("--no-verify");
		expect(commit?.cmd.join(" ")).toContain("user.name=warren");
		expect(commit?.env?.GIT_AUTHOR_NAME).toBe("warren");
		expect(commit?.env?.GIT_COMMITTER_EMAIL).toBe(WARREN_BOT_IDENTITY.email);

		// The push targets the default branch directly.
		const push = calls.find((c) => c.cmd.includes("push"));
		expect(push?.cmd).toEqual(["git", "push", "origin", "HEAD:main"]);

		// The worktree is always cleaned up.
		expect(has("remove")).toBe(true);
	});

	test("githubToken → fetch + push carry the credential env; token stays out of argv", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true });
		const { seedsCli } = makeSeedsCli();
		await closeMergedChildSeed({
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedId: "warren-3f09",
			seedsCli,
			spawn,
			gitBinary: "git",
			githubToken: "ghp_secret",
		});

		const credKey = "url.https://x-access-token:ghp_secret@github.com/.insteadOf";
		const fetch = calls.find((c) => c.cmd.includes("fetch"));
		expect(fetch?.env?.GIT_CONFIG_KEY_0).toBe(credKey);
		const push = calls.find((c) => c.cmd.includes("push"));
		expect(push?.env?.GIT_CONFIG_KEY_0).toBe(credKey);
		// The scrub still composes under the credential (keys present-and-undefined).
		expect(push?.env).toHaveProperty("GIT_DIR");
		expect(push?.env?.GIT_DIR).toBeUndefined();
		// Local git ops (worktree/commit/status) never see the credential…
		const commit = calls.find((c) => c.cmd.includes("commit"));
		expect(commit?.env?.GIT_CONFIG_KEY_0).toBeUndefined();
		// …and the token never rides in argv.
		expect(calls.flatMap((c) => c.cmd).join(" ")).not.toContain("ghp_secret");
	});

	test("already-closed seed yields noop without a commit or push", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: false });
		const { seedsCli } = makeSeedsCli();
		const result = await closeMergedChildSeed({
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedId: "warren-f854",
			seedsCli,
			spawn,
			gitBinary: "git",
		});

		expect(result.kind).toBe("noop");
		expect(calls.some((c) => c.cmd.includes("commit"))).toBe(false);
		expect(calls.some((c) => c.cmd.includes("push"))).toBe(false);
		// Worktree still torn down on the noop path.
		expect(calls.some((c) => c.cmd.includes("remove"))).toBe(true);
	});

	test("push failure throws and still removes the worktree", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true, pushExit: 1 });
		const { seedsCli } = makeSeedsCli();
		await expect(
			closeMergedChildSeed({
				projectPath: "/data/projects/x/y",
				defaultBranch: "main",
				seedId: "warren-3f09",
				seedsCli,
				spawn,
				gitBinary: "git",
			}),
		).rejects.toThrow(/git push failed/);
		expect(calls.some((c) => c.cmd.includes("remove"))).toBe(true);
	});

	test("non-fast-forward push is recovered by re-fetching and re-applying the close", async () => {
		// First push rejected as non-fast-forward (a concurrent writer pinned the
		// remote head); the retry re-fetches, re-runs the idempotent `sd close`,
		// and the second push succeeds.
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true, nonFastForwardCount: 1 });
		const { seedsCli, calls: sdCalls } = makeSeedsCli();
		const result = await closeMergedChildSeed({
			projectPath: "/data/projects/x/y",
			defaultBranch: "main",
			seedId: "warren-3f09",
			seedsCli,
			spawn,
			gitBinary: "git",
		});

		expect(result.kind).toBe("closed");
		if (result.kind === "closed") expect(result.branch).toBe("main");

		const pushes = calls.filter((c) => c.cmd.includes("push"));
		expect(pushes).toHaveLength(2);
		// Two close attempts (second on a fresh origin head) — the JSONL close is
		// re-applied idempotently rather than clobbering the conflicting writer's lines.
		expect(sdCalls.filter((c) => c.cmd[1] === "close")).toHaveLength(2);
		// A re-fetch happened between the rejection and the retry commit.
		expect(calls.filter((c) => c.cmd.includes("fetch"))).toHaveLength(2);

		// Each attempt tears its own worktree down.
		expect(calls.filter((c) => c.cmd.includes("remove"))).toHaveLength(2);
	});

	test("non-fast-forward recovery propagates when the retry push is also rejected", async () => {
		const { spawn, calls } = makeGitSpawn({ dirtyAfterClose: true, nonFastForwardCount: 2 });
		const { seedsCli } = makeSeedsCli();
		await expect(
			closeMergedChildSeed({
				projectPath: "/data/projects/x/y",
				defaultBranch: "main",
				seedId: "warren-3f09",
				seedsCli,
				spawn,
				gitBinary: "git",
			}),
		).rejects.toThrow(/git push failed/);
		expect(calls.filter((c) => c.cmd.includes("push"))).toHaveLength(2);
		// Worktrees for both attempts cleaned up.
		expect(calls.filter((c) => c.cmd.includes("remove"))).toHaveLength(2);
	});
});
