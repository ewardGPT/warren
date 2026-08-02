import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CANONICAL_HOME,
	canonicalNames,
	declaredName,
	isDomainName,
	scan,
	scanText,
} from "./check-wire-types.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** A stand-in for src/core/wire.ts carrying one of every declaration shape. */
const FIXTURE_HOME = [
	"export const RUN_STATES = ['queued', 'running'] as const;",
	"export type RunState = (typeof RUN_STATES)[number];",
	"export function isTerminalRunState(state: RunState): boolean {",
	"\treturn state === 'running';",
	"}",
	"export type AgentSource = 'builtin' | 'library';",
	"/** export const RUN_MODES = ['batch'] as const; — a doc comment, not a decl. */",
	"export const MAX_ATTEMPTS = 3;",
].join("\n");

/** Write a fake repo whose `src/` tree holds `files`, plus the canonical home. */
function writeFixtureRepo(dir: string, files: Record<string, string>): void {
	const all = { [CANONICAL_HOME]: `${FIXTURE_HOME}\n`, ...files };
	for (const [rel, text] of Object.entries(all)) {
		const abs = join(dir, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, text);
	}
}

function withFixtureRepo(files: Record<string, string>, run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "warren-wire-types-"));
	try {
		writeFixtureRepo(dir, files);
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("isDomainName", () => {
	test("accepts wire vocabulary carrying a domain stem", () => {
		for (const name of ["RUN_STATES", "PlanRunChildState", "InboxPriority", "AgentSource"]) {
			expect(isDomainName(name)).toBe(true);
		}
	});

	test("rejects generic names so an accidental collision cannot fail the build", () => {
		for (const name of ["MAX_ATTEMPTS", "Status", "Limits"]) {
			expect(isDomainName(name)).toBe(false);
		}
	});
});

describe("canonicalNames", () => {
	test("derives the enforced list from the home's own source", () => {
		expect(canonicalNames(FIXTURE_HOME)).toEqual([
			"AgentSource",
			"RUN_STATES",
			"RunState",
			"isTerminalRunState",
		]);
	});

	test("drops generic exports and doc-comment mentions", () => {
		const names = canonicalNames(FIXTURE_HOME);
		expect(names).not.toContain("MAX_ATTEMPTS");
		expect(names).not.toContain("RUN_MODES");
	});

	test("the real src/core/wire.ts yields the names warren-b229 hoisted", () => {
		const names = canonicalNames(readFileSync(resolve(REPO_ROOT, CANONICAL_HOME), "utf8"));
		expect(names).toContain("RUN_FAILURE_REASONS");
		expect(names).toContain("RunFailureReason");
		expect(names).toContain("PLAN_RUN_CHILD_TERMINAL_STATES");
		expect(names).toContain("isActivePreviewState");
		expect(names).toContain("AgentSource");
	});
});

describe("declaredName", () => {
	test("sees value, type and function declarations, exported or not", () => {
		expect(declaredName("export const RUN_STATES = ['queued'] as const;")).toBe("RUN_STATES");
		expect(declaredName("type RunFailureReason = 'crashed';")).toBe("RunFailureReason");
		expect(declaredName("\texport interface RunRow {")).toBe("RunRow");
		expect(declaredName("export function isTerminalRunState(s: RunState) {")).toBe(
			"isTerminalRunState",
		);
	});

	test("ignores re-export and import forms", () => {
		for (const line of [
			'export * from "../../core/wire.ts";',
			'export { RUN_STATES } from "../core/wire.ts";',
			'export type { RunState } from "../core/wire.ts";',
			'import { type RunState, RUN_STATES } from "../core/wire.ts";',
			"\ttype RunState,",
			"\tRUN_STATES,",
			"\ttype RunState as WireRunState,",
		]) {
			expect(declaredName(line)).toBeUndefined();
		}
	});

	test("ignores comment lines", () => {
		expect(declaredName("// export const RUN_STATES = [] as const;")).toBeUndefined();
		expect(declaredName(" * type RunState = string;")).toBeUndefined();
	});
});

describe("scanText", () => {
	const names = new Set(["RUN_STATES", "RunState"]);

	test("reports the 1-based line of each redeclaration", () => {
		const text = ["import x from 'y';", "", "export type RunState = 'queued';"].join("\n");
		expect(scanText("src/ui/src/api/types.ts", text, names)).toEqual([
			{ file: "src/ui/src/api/types.ts", line: 3, name: "RunState" },
		]);
	});

	test("stays silent on a pure re-export file", () => {
		const text = 'export { RUN_STATES, type RunState } from "../core/wire.ts";\n';
		expect(scanText("src/client/types.ts", text, names)).toEqual([]);
	});
});

describe("scan", () => {
	test("passes on a tree that only re-exports the canonical home", () => {
		withFixtureRepo(
			{
				"src/db/schema/columns.ts": 'export * from "../../core/wire.ts";\n',
				"src/client/types.ts": [
					'import type { RunState } from "../core/wire.ts";',
					'export { isTerminalRunState, RUN_STATES, type RunState } from "../core/wire.ts";',
					"export interface RunRow {",
					"\tstate: RunState;",
					"}",
					"",
				].join("\n"),
			},
			(dir) => {
				expect(scan(dir)).toEqual([]);
			},
		);
	});

	test("flags a redeclaration in the UI package, which biome and check:size skip", () => {
		withFixtureRepo(
			{
				"src/ui/src/api/types.ts": [
					"// Hand-copied instead of re-exported — the warren-b229 drift.",
					"export type RunState = 'queued' | 'running' | 'paused';",
					"",
				].join("\n"),
			},
			(dir) => {
				expect(scan(dir)).toEqual([{ file: "src/ui/src/api/types.ts", line: 2, name: "RunState" }]);
			},
		);
	});

	test("flags a non-exported local copy too", () => {
		withFixtureRepo({ "src/runs/state.ts": "const RUN_STATES = ['queued'];\n" }, (dir) => {
			expect(scan(dir).map((v) => v.name)).toEqual(["RUN_STATES"]);
		});
	});

	test("exempts test files, test helpers and the canonical home itself", () => {
		withFixtureRepo(
			{
				"src/runs/state.test.ts": "export type RunState = 'queued';\n",
				"src/runs/state.test-helpers.ts": "export const RUN_STATES = ['queued'];\n",
			},
			(dir) => {
				expect(scan(dir)).toEqual([]);
			},
		);
	});

	test("ignores generic names the home also exports", () => {
		withFixtureRepo({ "src/runs/limits.ts": "export const MAX_ATTEMPTS = 9;\n" }, (dir) => {
			expect(scan(dir)).toEqual([]);
		});
	});

	test("the real repository tree is clean", () => {
		expect(scan(REPO_ROOT)).toEqual([]);
	});
});
