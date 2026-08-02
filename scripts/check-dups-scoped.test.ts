import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	ALLOWLIST,
	type AllowEntry,
	type Clone,
	classify,
	loadAllowlist,
	pairKey,
	parseReport,
	SCOPED_CONFIG,
} from "./check-dups-scoped.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

function clone(a: string, b: string, over: Partial<Clone> = {}): Clone {
	return { a, aStart: 1, b, bStart: 1, lines: 10, tokens: 50, ...over };
}

function allow(a: string, b: string): AllowEntry {
	return { a, b, why: "fixture" };
}

describe("pairKey", () => {
	test("is order independent", () => {
		expect(pairKey("src/a.ts", "src/b.ts")).toBe(pairKey("src/b.ts", "src/a.ts"));
	});

	test("keeps an intra-file pair distinct from a cross-file one", () => {
		expect(pairKey("src/a.ts", "src/a.ts")).not.toBe(pairKey("src/a.ts", "src/b.ts"));
	});
});

describe("parseReport", () => {
	test("normalizes jscpd's duplicates into clones", () => {
		const clones = parseReport(
			JSON.stringify({
				duplicates: [
					{
						firstFile: { name: "src/cli/output.ts", start: 62 },
						secondFile: { name: "src/server/handlers/index.ts", start: 95 },
						lines: 25,
						tokens: 163,
					},
				],
			}),
		);
		expect(clones).toEqual([
			{
				a: "src/cli/output.ts",
				aStart: 62,
				b: "src/server/handlers/index.ts",
				bStart: 95,
				lines: 25,
				tokens: 163,
			},
		]);
	});

	test("slashes Windows paths and tolerates an empty report", () => {
		const clones = parseReport(
			JSON.stringify({
				duplicates: [
					{ firstFile: { name: "src\\cli\\a.ts", start: 1 }, secondFile: { name: "src\\b.ts" } },
					{ firstFile: {}, secondFile: { name: "src/b.ts" } },
				],
			}),
		);
		expect(clones).toHaveLength(1);
		expect(clones[0]?.a).toBe("src/cli/a.ts");
		expect(clones[0]?.b).toBe("src/b.ts");
		expect(parseReport(JSON.stringify({}))).toEqual([]);
	});
});

describe("classify", () => {
	test("an un-grandfathered clone fails; a grandfathered one does not", () => {
		const result = classify(
			[clone("src/cli/output.ts", "src/server/handlers/index.ts"), clone("src/x.ts", "src/y.ts")],
			[allow("src/x.ts", "src/y.ts")],
		);
		expect(result.unlisted.map((c) => pairKey(c.a, c.b))).toEqual([
			pairKey("src/cli/output.ts", "src/server/handlers/index.ts"),
		]);
		expect(result.stale).toEqual([]);
	});

	test("matches an allowlist entry whichever way round jscpd reports it", () => {
		const result = classify([clone("src/b.ts", "src/a.ts")], [allow("src/a.ts", "src/b.ts")]);
		expect(result.unlisted).toEqual([]);
		expect(result.stale).toEqual([]);
	});

	test("a listed pair that no longer clones is stale, so the ratchet only goes down", () => {
		const result = classify([], [allow("src/a.ts", "src/b.ts")]);
		expect(result.stale.map((e) => pairKey(e.a, e.b))).toEqual([pairKey("src/a.ts", "src/b.ts")]);
	});

	test("every clone of a grandfathered pair is covered by the one entry", () => {
		const result = classify(
			[
				clone("src/a.ts", "src/b.ts", { aStart: 10 }),
				clone("src/a.ts", "src/b.ts", { aStart: 90 }),
			],
			[allow("src/a.ts", "src/b.ts")],
		);
		expect(result.unlisted).toEqual([]);
		expect(result.stale).toEqual([]);
	});
});

describe("the shipped allowlist", () => {
	test("parses, and every entry carries a non-empty why", () => {
		const entries = loadAllowlist(REPO_ROOT);
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) expect(entry.why.trim().length).toBeGreaterThan(0);
	});

	test("holds no duplicate pairs", () => {
		const keys = loadAllowlist(REPO_ROOT).map((e) => pairKey(e.a, e.b));
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("the loader rejects an entry with a blank why", () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-dups-"));
		try {
			mkdirSync(join(dir, "scripts"), { recursive: true });
			writeFileSync(
				join(dir, ALLOWLIST),
				JSON.stringify({ allowlist: [{ a: "src/a.ts", b: "src/b.ts", why: "  " }] }),
			);
			expect(() => loadAllowlist(dir)).toThrow(/non-empty "why"/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the loader rejects a file with no allowlist array", () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-dups-"));
		try {
			mkdirSync(join(dir, "scripts"), { recursive: true });
			writeFileSync(join(dir, ALLOWLIST), JSON.stringify({}));
			expect(() => loadAllowlist(dir)).toThrow(/expected an "allowlist" array/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the scoped jscpd config", () => {
	const config = JSON.parse(readFileSync(resolve(REPO_ROOT, SCOPED_CONFIG), "utf8")) as {
		pattern: string;
		minTokens: number;
		threshold: number;
	};

	test("is zero-tolerance and reads fewer tokens than the repo-wide run", () => {
		const main = JSON.parse(readFileSync(resolve(REPO_ROOT, ".jscpd.json"), "utf8")) as {
			minTokens: number;
		};
		expect(config.threshold).toBe(0);
		expect(config.minTokens).toBeLessThan(main.minTokens);
	});

	test("covers the four surfaces a cross-layer clone spans", () => {
		for (const dir of ["src/cli", "src/client", "src/ui/src/api", "src/server/handlers"]) {
			expect(config.pattern).toContain(dir);
		}
	});
});

describe("defaultSpawn", () => {
	test("is defined once, in the module that owns the SpawnFn contract", () => {
		const home = readFileSync(resolve(REPO_ROOT, "src/projects/clone.ts"), "utf8");
		expect(home).toContain("export const defaultSpawn: SpawnFn");
		for (const surface of [
			"src/cli/output.ts",
			"src/server/main/utils.ts",
			"src/server/handlers/index.ts",
		]) {
			const text = readFileSync(resolve(REPO_ROOT, surface), "utf8");
			expect(text).not.toContain("export const defaultSpawn");
			expect(text).toContain("export { defaultSpawn }");
		}
	});

	test("the allowlist does not grandfather the pair this seed removed", () => {
		const keys = loadAllowlist(REPO_ROOT).map((e) => pairKey(e.a, e.b));
		expect(keys).not.toContain(pairKey("src/cli/output.ts", "src/server/handlers/index.ts"));
	});
});

test("the allowlist path constant points at the shipped file", () => {
	expect(ALLOWLIST).toBe("scripts/dups-allowlist.json");
	expect(() => readFileSync(resolve(REPO_ROOT, ALLOWLIST), "utf8")).not.toThrow();
});
