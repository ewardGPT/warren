/**
 * Seed-relevant mulch failure priors at spawn (ubuntu-2bb5 / TTC phase 1).
 *
 * Retrieval-as-prior: before a run spends tokens on a dead end the project
 * already recorded, inject the matching failure records from the project's
 * own mulch corpus (`.mulch/expertise/*.jsonl`) into the dispatched prompt.
 *
 * The selection is deterministic and model-free: `dir_anchors` path matching
 * plus token overlap. The whole read is best-effort — a missing corpus, an
 * unreadable seed file, or a weak match returns an empty block, so dispatch
 * behaves exactly as before. Seeds come from the clone's
 * `.seeds/issues.jsonl`, never from `sd`, so a locked store cannot fail a
 * spawn (warren-5f07 keeps `sd` out of the spawn path; this module keeps it
 * out too).
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Domain directory reap merges (src/runs/reap/mulch.ts). */
export const MULCH_EXPERTISE_DIR = join(".mulch", "expertise");
/** Issue queue file `sd` rewrites on every change. */
export const SEEDS_ISSUES_FILE = join(".seeds", "issues.jsonl");

/** Maximum records injected into one prompt. */
export const MULCH_PRIOR_LIMIT = 5;
/** Maximum size of the rendered block, in characters. */
export const MULCH_PRIOR_MAX_CHARS = 1600;
/** Minimum score a record needs to be treated as relevant. */
const MIN_PRIOR_SCORE = 3;
const MAX_DESCRIPTION_CHARS = 220;
const MAX_RESOLUTION_CHARS = 220;

/** A failure record reduced to the fields the prior block uses. */
export interface MulchFailurePrior {
	readonly id: string;
	readonly description: string;
	readonly resolution: string;
	readonly dirAnchors: readonly string[];
	readonly recordedAt: string;
}

/**
 * Tokens that carry no retrieval signal. Words such as "run", "failed", and
 * "check" appear in every automatic failure record and in most seed texts,
 * so overlap on them says nothing.
 */
const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"into",
	"this",
	"that",
	"these",
	"those",
	"when",
	"then",
	"than",
	"will",
	"not",
	"but",
	"are",
	"was",
	"were",
	"has",
	"have",
	"had",
	"its",
	"also",
	"can",
	"could",
	"should",
	"would",
	"must",
	"may",
	"might",
	"any",
	"all",
	"new",
	"old",
	"one",
	"two",
	"run",
	"runs",
	"running",
	"seed",
	"seeds",
	"fail",
	"failed",
	"failure",
	"failures",
	"failing",
	"check",
	"checks",
	"checking",
	"unknown",
	"details",
	"log",
	"logs",
	"started",
	"via",
	"per",
	"fix",
	"fixes",
	"fixed",
	"work",
	"works",
	"working",
	"make",
	"makes",
	"made",
	"add",
	"adds",
	"added",
	"file",
	"files",
	"whenever",
	"without",
	"before",
	"after",
	"source",
	"target",
]);

const TOKEN_SEPARATORS = /[^a-z0-9/._]+/;
const PATH_SEPARATORS = /[/._]/;

/**
 * Split text into lowercase retrieval tokens. Path-like words keep their
 * segments ("src/runs/reap" yields "src", "runs", "reap"); everything else
 * splits on non-alphanumeric characters.
 */
export function tokenizeSeedText(text: string): ReadonlySet<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().split(TOKEN_SEPARATORS)) {
		if (raw === "") continue;
		for (const part of raw.split(PATH_SEPARATORS)) {
			if (part.length >= 3 && !STOPWORDS.has(part)) tokens.add(part);
		}
	}
	return tokens;
}

/**
 * Resolve the seed's text (title, description, design, acceptance criteria,
 * labels) from the clone's `.seeds/issues.jsonl`. Later lines win, mirroring
 * the last-write-wins storage shape. Returns null when the id is absent.
 */
export function seedTextFromIssues(issuesBody: string, seedId: string): string | null {
	let found: string | null = null;
	for (const line of issuesBody.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || !trimmed.includes(seedId)) continue;
		const record = parseJsonObject(trimmed);
		if (record === null || record.id !== seedId) continue;
		const labels = Array.isArray(record.labels)
			? record.labels.filter((label): label is string => typeof label === "string")
			: [];
		found = [
			record.title,
			record.description,
			record.design,
			record.acceptanceCriteria,
			labels.join(" "),
		]
			.filter((part): part is string => typeof part === "string" && part.trim() !== "")
			.join("\n");
	}
	return found;
}

/** Parse one JSONL line into a plain object, or null for anything else. */
function parseJsonObject(line: string): Record<string, unknown> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	return parsed as Record<string, unknown>;
}

/** Narrow one record to a failure prior, or null when it is not usable. */
function toFailurePrior(record: Record<string, unknown>): MulchFailurePrior | null {
	if (record.type !== "failure" || record.status === "archived") return null;
	if (typeof record.id !== "string" || record.id === "") return null;
	if (typeof record.description !== "string" || record.description.trim() === "") return null;
	if (typeof record.resolution !== "string" || record.resolution.trim() === "") return null;
	return {
		id: record.id,
		description: record.description.trim(),
		resolution: record.resolution.trim(),
		dirAnchors: Array.isArray(record.dir_anchors)
			? record.dir_anchors.filter((anchor): anchor is string => typeof anchor === "string")
			: [],
		recordedAt: typeof record.recorded_at === "string" ? record.recorded_at : "",
	};
}

/**
 * Parse mulch JSONL bodies into failure priors. Non-failure records,
 * archived records, records without a resolution, and malformed lines are
 * skipped; duplicate ids keep their first occurrence (files are read in
 * sorted order, so the result stays deterministic).
 */
export function parseFailurePriors(contents: readonly string[]): MulchFailurePrior[] {
	const priors: MulchFailurePrior[] = [];
	const seen = new Set<string>();
	for (const body of contents) {
		for (const line of body.split("\n")) {
			const record = parseJsonObject(line.trim());
			if (record === null) continue;
			const prior = toFailurePrior(record);
			if (prior === null || seen.has(prior.id)) continue;
			seen.add(prior.id);
			priors.push(prior);
		}
	}
	return priors;
}

/**
 * Score one anchor against the seed. A full path that appears in the seed
 * text is the strongest signal (4); otherwise each path segment the seed
 * also names adds 1, capped at 3.
 */
function scoreAnchor(seedLower: string, seedTokens: ReadonlySet<string>, anchor: string): number {
	const normalized = anchor
		.trim()
		.toLowerCase()
		.replace(/^\.?\//, "")
		.replace(/\/+$/, "");
	if (normalized === "") return 0;
	if (seedLower.includes(normalized)) return 4;
	let hits = 0;
	for (const segment of normalized.split("/")) {
		if (segment.length >= 3 && !STOPWORDS.has(segment) && seedTokens.has(segment)) {
			hits += 1;
		}
	}
	return Math.min(hits, 3);
}

/** Score one record: anchor matches (capped at 6) plus token overlap (capped at 3). */
export function scoreFailurePrior(
	seedText: string,
	seedTokens: ReadonlySet<string>,
	prior: MulchFailurePrior,
): number {
	const seedLower = seedText.toLowerCase();
	let anchorScore = 0;
	for (const anchor of prior.dirAnchors) {
		anchorScore += scoreAnchor(seedLower, seedTokens, anchor);
	}
	let overlap = 0;
	for (const token of tokenizeSeedText(`${prior.description} ${prior.resolution}`)) {
		if (seedTokens.has(token)) overlap += 1;
	}
	return Math.min(anchorScore, 6) + Math.min(overlap, 3);
}

/**
 * Rank the records for one seed and return the best `limit` above the
 * relevance floor. Ties break by newest `recorded_at`, then by id, so the
 * same inputs always produce the same block.
 */
export function selectFailurePriors(
	seedText: string,
	priors: readonly MulchFailurePrior[],
	limit: number = MULCH_PRIOR_LIMIT,
): MulchFailurePrior[] {
	const seedTokens = tokenizeSeedText(seedText);
	return priors
		.map((prior) => ({ prior, score: scoreFailurePrior(seedText, seedTokens, prior) }))
		.filter((entry) => entry.score >= MIN_PRIOR_SCORE)
		.sort((a, b) => {
			if (a.score !== b.score) return b.score - a.score;
			if (a.prior.recordedAt !== b.prior.recordedAt) {
				return a.prior.recordedAt < b.prior.recordedAt ? 1 : -1;
			}
			return a.prior.id < b.prior.id ? -1 : 1;
		})
		.slice(0, Math.max(0, limit))
		.map((entry) => entry.prior);
}

/**
 * Render the prompt block. Empty input yields "" so the caller can treat an
 * empty block as "no change". Entries are dropped once the character cap
 * would be crossed, so the block stays inside its budget.
 */
export function formatPriorBlock(priors: readonly MulchFailurePrior[]): string {
	if (priors.length === 0) return "";
	const header = [
		"## Known failure priors for this project",
		"",
		"Recorded dead ends from this repository's mulch corpus, matched by path anchors and keywords. Some entries may not apply. Read the full records under `.mulch/expertise/` before you rely on one.",
	].join("\n");
	const entries: string[] = [];
	let length = header.length;
	for (const prior of priors) {
		const description =
			prior.description.length <= MAX_DESCRIPTION_CHARS
				? prior.description
				: `${prior.description.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`;
		const resolution =
			prior.resolution.length <= MAX_RESOLUTION_CHARS
				? prior.resolution
				: `${prior.resolution.slice(0, MAX_RESOLUTION_CHARS - 1)}…`;
		const entry = `- [${prior.id}] ${description} Fix: ${resolution}`;
		if (length + entry.length + 1 > MULCH_PRIOR_MAX_CHARS) break;
		entries.push(entry);
		length += entry.length + 1;
	}
	if (entries.length === 0) return "";
	return `${header}\n\n${entries.join("\n")}`;
}

export interface BuildMulchPriorBlockInput {
	/** Host path of the project clone (holds `.mulch/` and `.seeds/`). */
	readonly projectPath: string;
	/** Operator prompt; the fallback seed text when no seed record is found. */
	readonly prompt: string;
	readonly seedId?: string;
	readonly limit?: number;
	/** Test seams; default to node:fs/promises. */
	readonly readFileFn?: (path: string) => Promise<string>;
	readonly readdirFn?: (path: string) => Promise<string[]>;
}

export interface MulchPriorBlockResult {
	readonly block: string;
	readonly count: number;
}

const EMPTY_RESULT: MulchPriorBlockResult = { block: "", count: 0 };

/**
 * Build the prior block for one spawn. Never throws: every failure path
 * (missing corpus, unreadable files, no relevant records) returns the empty
 * result, and the dispatch proceeds with the unchanged prompt.
 */
export async function buildMulchPriorBlock(
	input: BuildMulchPriorBlockInput,
): Promise<MulchPriorBlockResult> {
	const readFileFn = input.readFileFn ?? ((path: string) => readFile(path, "utf-8"));
	const readdirFn = input.readdirFn ?? ((path: string) => readdir(path));
	let seedText = input.prompt;
	if (input.seedId !== undefined && input.seedId !== "") {
		try {
			const issues = await readFileFn(join(input.projectPath, SEEDS_ISSUES_FILE));
			seedText = seedTextFromIssues(issues, input.seedId) ?? input.prompt;
		} catch {
			// No clone-side seed file — the operator prompt is the fallback.
		}
	}
	let contents: string[];
	try {
		const dir = join(input.projectPath, MULCH_EXPERTISE_DIR);
		const names = (await readdirFn(dir)).filter((name) => name.endsWith(".jsonl")).sort();
		contents = await Promise.all(names.map((name) => readFileFn(join(dir, name))));
	} catch {
		return EMPTY_RESULT;
	}
	const selected = selectFailurePriors(
		seedText,
		parseFailurePriors(contents),
		input.limit ?? MULCH_PRIOR_LIMIT,
	);
	return { block: formatPriorBlock(selected), count: selected.length };
}
