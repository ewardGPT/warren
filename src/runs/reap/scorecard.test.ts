/**
 * The deterministic scorecard (ubuntu-c929).
 *
 * The interesting cases are the ones that distinguish observations from
 * guesses: a gate command with a failed result, a gate whose result never
 * reached the sample, a run with no gate at all, and every read that can fail.
 */

import { describe, expect, test } from "bun:test";
import type { RunRow } from "../../db/schema.ts";
import {
	assembleScorecard,
	boxOf,
	buildScorecard,
	computeDiffStat,
	isGateCommand,
	parseNumstat,
	readPrUpstream,
	type ScorecardEventInput,
	type ScorecardRunRow,
	summarizeRunStream,
} from "./scorecard.ts";
import type { ReapStepError } from "./types.ts";

/** A tool-execution start envelope, shaped as the persisted events carry it. */
function toolStart(id: string, command: string): ScorecardEventInput {
	return {
		kind: "tool_use",
		stream: "stdout",
		payload: { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } },
	};
}

/** A tool-execution end envelope, with the result text and error flag. */
function toolEnd(
	id: string,
	text: string,
	options: { isError?: boolean } = {},
): ScorecardEventInput {
	return {
		kind: "tool_result",
		stream: "stdout",
		payload: {
			type: "tool_execution_end",
			toolCallId: id,
			toolName: "bash",
			isError: options.isError ?? false,
			result: { content: [{ type: "text", text }] },
		},
	};
}

function turn(): ScorecardEventInput {
	return {
		kind: "state_change",
		stream: "system",
		payload: { type: "turn_end", message: { role: "assistant", usage: { input: 10, output: 2 } } },
	};
}

const RUN: ScorecardRunRow = {
	id: "run_test",
	burrowRunId: "mt5-wine/run_inner",
	costUsd: 0.25,
	tokensInput: 100,
	tokensOutput: 20,
	tokensCacheRead: 5,
	tokensCacheWrite: 0,
};

function build(overrides: {
	events?: readonly ScorecardEventInput[];
	state?: Partial<Parameters<typeof buildScorecard>[0]["state"]>;
	diff?: { files: number; insertions: number; deletions: number } | null;
	upstream?: { merged: "open" | "merged" | null; checks: "passing" | null };
	errors?: readonly ReapStepError[];
	run?: Partial<ScorecardRunRow>;
}) {
	return buildScorecard({
		run: { ...RUN, ...overrides.run },
		state: {
			branchPushed: true,
			commitsAhead: 2,
			droppedCommit: false,
			noChanges: false,
			prUrl: null,
			prBranch: null,
			...overrides.state,
		},
		outcome: "succeeded",
		failureReason: null,
		errors: overrides.errors ?? [],
		events: overrides.events ?? [],
		diff: overrides.diff ?? null,
		upstream: {
			merged: overrides.upstream?.merged ?? null,
			checks: overrides.upstream?.checks ?? null,
		},
		now: () => new Date("2026-10-15T12:00:00.000Z"),
	});
}

describe("summarizeRunStream", () => {
	test("counts turns and tool calls and finds the gate command", () => {
		const summary = summarizeRunStream([
			turn(),
			toolStart("c1", "ls -la"),
			toolEnd("c1", "total 20"),
			turn(),
			toolStart("c2", 'cd /workspace && bun run check:all 2>&1 | head -5; echo "EXIT=$?"'),
			toolEnd("c2", "ok\nEXIT=0"),
		]);
		expect(summary.turns).toBe(2);
		expect(summary.toolCalls).toBe(2);
		expect(summary.gateCommands).toBe(1);
		expect(summary.gate?.exitCode).toBe(0);
		expect(summary.gate?.ok).toBe(true);
	});

	test("reports the LAST gate run, because a fixed gate is the one that counts", () => {
		const summary = summarizeRunStream([
			toolStart("c1", "bun run lint"),
			toolEnd("c1", "boom\nEXIT=1", { isError: true }),
			toolStart("c2", "bun run lint"),
			toolEnd("c2", "clean\nEXIT=0"),
		]);
		expect(summary.gateCommands).toBe(2);
		expect(summary.gate?.ok).toBe(true);
		expect(summary.gate?.exitCode).toBe(0);
	});

	test("a gate whose result never reached the sample is not assumed ok", () => {
		const summary = summarizeRunStream([toolStart("c1", "bun run test")]);
		expect(summary.gate).toEqual({ command: "bun run test", ok: false, exitCode: null });
	});

	test("no gate command means null, not a verdict", () => {
		const summary = summarizeRunStream([turn(), toolStart("c1", "cat README.md")]);
		expect(summary.gate).toBeNull();
		expect(summary.gateCommands).toBe(0);
	});

	test("unknown payload shapes cost fields, never a throw", () => {
		const summary = summarizeRunStream([
			{ kind: "text", stream: "stdout", payload: null },
			{ kind: "text", stream: "stdout", payload: "not an object" },
			{ kind: "state_change", stream: "system", payload: { type: "something_new" } },
			{ kind: "tool_use", stream: "stdout", payload: { type: "tool_execution_start" } },
		]);
		expect(summary).toMatchObject({ turns: 0, toolCalls: 1, gateCommands: 0, gate: null });
	});
});

describe("isGateCommand", () => {
	test("matches the runners a run's gate uses", () => {
		for (const command of [
			"bun run check:all",
			"npm test",
			"pnpm lint",
			"npx tsc --noEmit",
			"biome check .",
			"pytest -q",
			"cargo test",
			"make check",
		]) {
			expect(isGateCommand(command)).toBe(true);
		}
	});

	test("does not mistake an unrelated command for a gate", () => {
		for (const command of ["cat check.txt", "ls -la", "git status", "echo tested"]) {
			expect(isGateCommand(command)).toBe(false);
		}
	});
});

describe("parseNumstat", () => {
	test("sums insertions, deletions and files", () => {
		const diff = parseNumstat("12\t3\tsrc/a.ts\n0\t8\tsrc/b.ts\n");
		expect(diff).toEqual({ files: 2, insertions: 12, deletions: 11 });
	});

	test("counts a binary file as changed with no lines", () => {
		expect(parseNumstat("-\t-\timg.png\n")).toEqual({ files: 1, insertions: 0, deletions: 0 });
	});

	test("ignores blank and malformed lines", () => {
		expect(parseNumstat("\nnot a numstat line\n7\t1\tx.ts\n")).toEqual({
			files: 1,
			insertions: 7,
			deletions: 1,
		});
	});
});

describe("computeDiffStat", () => {
	test("asks git for numbers against the base branch", async () => {
		const calls: { args: readonly string[]; cwd: string }[] = [];
		const diff = await computeDiffStat({
			exec: {
				run: async (_cmd, args, opts) => {
					calls.push({ args, cwd: opts.cwd });
					return { stdout: "4\t2\tsrc/a.ts\n", stderr: "" };
				},
			},
			cwd: "/ws",
			baseRef: "main",
			headRef: "HEAD",
		});
		expect(diff).toEqual({ files: 1, insertions: 4, deletions: 2 });
		expect(calls[0]?.args).toEqual(["diff", "--numstat", "main..HEAD"]);
		expect(calls[0]?.cwd).toBe("/ws");
	});

	test("a failing git read is null, not zero", async () => {
		const diff = await computeDiffStat({
			exec: {
				run: async () => {
					throw new Error("fatal: bad revision");
				},
			},
			cwd: "/ws",
			baseRef: "main",
			headRef: "HEAD",
		});
		expect(diff).toBeNull();
	});
});

describe("readPrUpstream", () => {
	const prUrl = "https://github.com/owner/repo/pull/7";

	test("without a token it calls nothing and claims nothing", async () => {
		let called = false;
		const upstream = await readPrUpstream({
			prUrl,
			ref: "warren/run_1",
			token: "",
			fetch: (async () => {
				called = true;
				return new Response("{}");
			}) as unknown as typeof fetch,
		});
		expect(upstream).toEqual({ merged: null, checks: null });
		expect(called).toBe(false);
	});

	test("reads the merge state and the check verdict from GitHub", async () => {
		const upstream = await readPrUpstream({
			prUrl,
			ref: "warren/run_1",
			token: "tok",
			fetch: (async (url: string) => {
				if (String(url).includes("/pulls/7")) {
					return new Response(JSON.stringify({ merged: false, state: "open" }), { status: 200 });
				}
				if (String(url).includes("/check-runs")) {
					return new Response(
						JSON.stringify({
							check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }],
						}),
						{ status: 200 },
					);
				}
				return new Response("not found", { status: 404 });
			}) as unknown as typeof fetch,
		});
		expect(upstream.merged).toBe("open");
		expect(upstream.checks).toBe("passing");
	});

	test("a GitHub failure costs the fields, not the reap", async () => {
		const upstream = await readPrUpstream({
			prUrl,
			ref: "warren/run_1",
			token: "tok",
			fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
		});
		expect(upstream).toEqual({ merged: null, checks: null });
	});

	test("an unparseable PR url is null rather than a request", async () => {
		expect(await readPrUpstream({ prUrl: "not-a-pr", ref: null, token: "tok" })).toEqual({
			merged: null,
			checks: null,
		});
	});
});

describe("buildScorecard", () => {
	test("carries the reap facts, the usage columns and the box", () => {
		const scorecard = build({
			diff: { files: 3, insertions: 40, deletions: 2 },
			state: { prUrl: "https://github.com/owner/repo/pull/7", prBranch: "warren/run_test" },
			upstream: { merged: "open", checks: "passing" },
		});
		expect(scorecard.version).toBe(1);
		expect(scorecard.reapedAt).toBe("2026-10-15T12:00:00.000Z");
		expect(scorecard.branch).toEqual({
			pushed: true,
			commitsAhead: 2,
			droppedCommit: false,
			noChanges: false,
		});
		expect(scorecard.diff).toEqual({ files: 3, insertions: 40, deletions: 2 });
		expect(scorecard.pr).toEqual({
			opened: true,
			url: "https://github.com/owner/repo/pull/7",
			merged: "open",
			checks: "passing",
		});
		expect(scorecard.usage).toEqual({
			costUsd: 0.25,
			tokensInput: 100,
			tokensOutput: 20,
			tokensCacheRead: 5,
			tokensCacheWrite: 0,
		});
		expect(scorecard.box).toBe("mt5-wine");
	});

	test("a run with no PR reports opened false and null upstream", () => {
		const scorecard = build({});
		expect(scorecard.pr).toEqual({ opened: false, url: null, merged: null, checks: null });
	});

	test("counts reap step failures, so a clean reap is distinguishable", () => {
		const errors: ReapStepError[] = [{ step: "branch_push", message: "no credential" }];
		expect(build({ errors }).reapErrors).toBe(1);
		expect(build({}).reapErrors).toBe(0);
	});
});

describe("boxOf", () => {
	test("reads the fleet box out of the run handle", () => {
		expect(boxOf("mt5-wine/run_abc")).toBe("mt5-wine");
		expect(boxOf("run_abc")).toBeNull();
		expect(boxOf("/run_abc")).toBeNull();
		expect(boxOf(null)).toBeNull();
	});
});

describe("assembleScorecard", () => {
	const runRow = { id: "run_test", burrowRunId: null, costUsd: 1 },
		state = {
			branchPushed: true,
			commitsAhead: 1,
			droppedCommit: false,
			noChanges: false,
			prUrl: null,
			prBranch: null,
		};

	function assemble(overrides: {
		rows?: readonly { kind: string; stream: string | null; payloadJson: unknown }[];
		rowsThrow?: boolean;
		exec?: boolean;
		workspacePath?: string | null;
	}) {
		return assembleScorecard({
			run: runRow as unknown as RunRow,
			state,
			outcome: "succeeded",
			failureReason: null,
			errors: [],
			events: {
				listByRun: async () => {
					if (overrides.rowsThrow === true) throw new Error("db is gone");
					return overrides.rows ?? [];
				},
			},
			workspacePath: overrides.workspacePath === undefined ? "/ws" : overrides.workspacePath,
			baseBranch: "main",
			...(overrides.exec === false
				? {}
				: {
						exec: {
							run: async () => ({ stdout: "9\t1\tsrc/a.ts\n", stderr: "" }),
						},
					}),
			now: () => new Date("2026-10-15T12:00:00.000Z"),
		});
	}

	test("reads the stream, sizes the diff, and folds both in", async () => {
		const scorecard = await assemble({
			rows: [
				{ kind: "state_change", stream: "system", payloadJson: { type: "turn_end" } },
				{
					kind: "tool_use",
					stream: "stdout",
					payloadJson: toolStart("c1", "bun run test").payload,
				},
				{
					kind: "tool_result",
					stream: "stdout",
					payloadJson: toolEnd("c1", "ok\nEXIT=0").payload,
				},
			],
		});
		expect(scorecard.turns).toBe(1);
		expect(scorecard.gate?.ok).toBe(true);
		expect(scorecard.diff).toEqual({ files: 1, insertions: 9, deletions: 1 });
	});

	test("an unreadable event log empties the stream fields without failing", async () => {
		const scorecard = await assemble({ rowsThrow: true });
		expect(scorecard.turns).toBe(0);
		expect(scorecard.gate).toBeNull();
		// The diff read is independent, so it still lands.
		expect(scorecard.diff).not.toBeNull();
	});

	test("no workspace means no diff, and the rest still lands", async () => {
		const scorecard = await assemble({ workspacePath: null });
		expect(scorecard.diff).toBeNull();
		expect(scorecard.version).toBe(1);
	});
});
