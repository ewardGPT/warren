#!/usr/bin/env bun
/**
 * Scoped copy-paste guard (warren-032a, plan pl-b82d step 31).
 *
 * The repo-wide jscpd run (`.jscpd.json`) is a PERCENTAGE budget: 100 tokens
 * minimum, 3% of duplicated lines allowed. It reported the three `defaultSpawn`
 * copies for as long as they existed and still exited 0, because 26 clones came
 * to 0.94% of the tree. A percentage budget over a growing codebase can only
 * get easier to pass, so it never sees an individual clone — that is why a
 * three-copy cross-layer duplicate survived long enough to grow a comment
 * justifying itself.
 *
 * This gate is the other half: a SECOND jscpd run (`.jscpd.scoped.json`) over
 * the four surfaces where a cross-layer copy actually hurts —
 *
 *   src/cli, src/client, src/ui/src/api, src/server/handlers
 *
 * — at 40 tokens and a 0% threshold, so every clone is a failure. False
 * positives are real at 40 tokens, so the escape hatch is an explicit
 * allowlist (`scripts/dups-allowlist.json`) keyed by FILE PAIR, with a `why`
 * on every entry. jscpd itself has no allowlist, hence this wrapper: it runs
 * the scoped config, reads the JSON report, and fails on any pair that is not
 * grandfathered.
 *
 * The allowlist is a ratchet in both directions. An unlisted clone fails, and
 * so does a listed pair that no longer clones — a stale entry means the clone
 * was fixed and the grandfather line should go, exactly as
 * `check-debt-markers.ts` and `check-file-sizes.ts` behave.
 *
 * Chained into `bun run check:dups` after the repo-wide run rather than
 * registered as its own gate: `scripts/check-all.ts` is byte-identical to the
 * l5-toolkit template and its gate vocabulary is frozen, so a repo-specific
 * assertion folds into an existing gate.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The scoped jscpd config, repo-relative POSIX. */
export const SCOPED_CONFIG = ".jscpd.scoped.json";

/** The clone allowlist, repo-relative POSIX. */
export const ALLOWLIST = "scripts/dups-allowlist.json";

/** One grandfathered clone, keyed by the pair of files it spans. */
export interface AllowEntry {
	readonly a: string;
	readonly b: string;
	readonly why: string;
}

/** One clone as jscpd reports it, reduced to what this gate prints. */
export interface Clone {
	readonly a: string;
	readonly aStart: number;
	readonly b: string;
	readonly bStart: number;
	readonly lines: number;
	readonly tokens: number;
}

/**
 * Order-independent key for a file pair, so `a | b` and `b | a` are the same
 * entry and the allowlist never depends on which side jscpd reports first.
 */
export function pairKey(a: string, b: string): string {
	return [a, b].sort().join(" | ");
}

/** Read + validate the allowlist. Every entry must carry a `why`. */
export function loadAllowlist(repoRoot: string = REPO_ROOT): AllowEntry[] {
	const path = resolve(repoRoot, ALLOWLIST);
	const parsed = JSON.parse(readFileSync(path, "utf8")) as { allowlist?: unknown };
	if (!Array.isArray(parsed.allowlist)) {
		throw new Error(`${ALLOWLIST}: expected an "allowlist" array`);
	}
	return parsed.allowlist.map((raw, i) => {
		const entry = raw as Partial<AllowEntry>;
		if (
			typeof entry.a !== "string" ||
			typeof entry.b !== "string" ||
			typeof entry.why !== "string" ||
			entry.why.trim() === ""
		) {
			throw new Error(`${ALLOWLIST}: entry ${i} needs string "a", "b" and a non-empty "why"`);
		}
		return { a: entry.a, b: entry.b, why: entry.why };
	});
}

interface JscpdReportFile {
	readonly name?: unknown;
	readonly start?: unknown;
}

interface JscpdReportDuplicate {
	readonly firstFile?: JscpdReportFile;
	readonly secondFile?: JscpdReportFile;
	readonly lines?: unknown;
	readonly tokens?: unknown;
}

/** Normalize jscpd's JSON report into `Clone`s, POSIX-slashed. */
export function parseReport(json: string): Clone[] {
	const parsed = JSON.parse(json) as { duplicates?: JscpdReportDuplicate[] };
	const out: Clone[] = [];
	for (const dup of parsed.duplicates ?? []) {
		const a = String(dup.firstFile?.name ?? "")
			.split("\\")
			.join("/");
		const b = String(dup.secondFile?.name ?? "")
			.split("\\")
			.join("/");
		if (a === "" || b === "") continue;
		out.push({
			a,
			aStart: Number(dup.firstFile?.start ?? 0),
			b,
			bStart: Number(dup.secondFile?.start ?? 0),
			lines: Number(dup.lines ?? 0),
			tokens: Number(dup.tokens ?? 0),
		});
	}
	return out;
}

/**
 * Partition clones against the allowlist. `unlisted` fails the gate; `stale`
 * (allowlisted pairs with no clone left) fails it too, so the list shrinks as
 * duplication is paid off.
 */
export function classify(
	clones: readonly Clone[],
	allowlist: readonly AllowEntry[],
): { unlisted: Clone[]; stale: AllowEntry[] } {
	const allowed = new Map(allowlist.map((e) => [pairKey(e.a, e.b), e]));
	const seen = new Set<string>();
	const unlisted: Clone[] = [];
	for (const clone of clones) {
		const key = pairKey(clone.a, clone.b);
		if (allowed.has(key)) seen.add(key);
		else unlisted.push(clone);
	}
	const stale = allowlist.filter((e) => !seen.has(pairKey(e.a, e.b)));
	return { unlisted, stale };
}

/**
 * Run the scoped jscpd config into a throwaway report directory and return the
 * clones it found. jscpd exits non-zero whenever it is over threshold — which
 * at 0% means "found anything at all" — so the exit code is not an error
 * signal here; a missing report is.
 */
async function runJscpd(repoRoot: string = REPO_ROOT): Promise<Clone[]> {
	const outDir = mkdtempSync(join(tmpdir(), "warren-jscpd-"));
	try {
		const proc = Bun.spawn({
			cmd: ["./node_modules/.bin/jscpd", "--config", SCOPED_CONFIG, "--output", outDir],
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		let json: string;
		try {
			json = readFileSync(join(outDir, "jscpd-report.json"), "utf8");
		} catch {
			throw new Error(`jscpd wrote no report for ${SCOPED_CONFIG}\n${stderr.trim()}`);
		}
		return parseReport(json);
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const allowlist = loadAllowlist();
	const clones = await runJscpd();
	const { unlisted, stale } = classify(clones, allowlist);

	if (stale.length > 0) {
		console.error(`${ALLOWLIST} has entries that no longer clone:\n`);
		for (const e of stale) console.error(`  - ${pairKey(e.a, e.b)}`);
		console.error("\nThe duplication is gone — delete the entry so the ratchet holds.\n");
	}

	if (unlisted.length > 0) {
		console.error(`check:dups (scoped) — ${unlisted.length} un-grandfathered clone(s):\n`);
		for (const c of unlisted) {
			console.error(
				`  ${c.a}:${c.aStart} <-> ${c.b}:${c.bStart}  (${c.lines} lines, ${c.tokens} tokens)`,
			);
		}
		console.error(
			`\nDefine the shared code once and import it, the way src/projects/clone.ts owns\n` +
				`\`defaultSpawn\` for the CLI, the boot wiring and the handlers. If the copy is\n` +
				`genuinely deliberate, add the file pair to ${ALLOWLIST} with a \`why\` saying what\n` +
				"makes it legitimate.",
		);
	}

	if (unlisted.length > 0 || stale.length > 0) process.exit(1);
	console.log(
		`check:dups (scoped) — ok (${clones.length} clone(s), all ${allowlist.length} grandfathered pairs still matched)`,
	);
}

if (import.meta.main) await main();
