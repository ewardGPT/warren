/**
 * `src/decide/record.ts` — the append-only JSONL decision log.
 *
 * Every call to `decide` — decided, unavailable, unsure or over-budget —
 * appends one JSON object per line to `WARREN_DECISION_LOG`
 * (default `$HOME/.warren/decisions.jsonl`) so a run can be audited after
 * the fact: which question set was asked, what Jev answered, which band
 * the engine settled on, which provider/model answered, how long it took,
 * what it cost in tokens, and the caller's `subject` (run id, seed id,
 * qitem id) that ties the row back to the thing being decided.
 *
 * Rules this module holds to:
 *
 *   - **Never throws.** Every filesystem operation is wrapped; a log that
 *     cannot be written degrades to no log, never to a failed decision.
 *   - **0600 / 0700.** The log can carry project state, so the file is
 *     created `0600` (and re-`fchmod`ed on every append, so a
 *     pre-existing world-readable file is tightened) under a `0700`
 *     directory.
 *   - **Bounded.** Long fields are clipped (`clip`) and the whole `state`
 *     is kept only as a sha256 fingerprint (`hashJson`) — the state can
 *     hold tokens and file bodies, and the audit needs identity, not a
 *     copy. Readers use `readLogTail`, which never pulls more than
 *     `MAX_LOG_READ_BYTES` off the disk.
 */

import { createHash } from "node:crypto";
import { closeSync, fchmodSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envString } from "./provider.ts";
import type { Answer, Band, Decision, DecisionUsage, DecisionVia, Env, Question } from "./types.ts";

export const LOG_ENV = "WARREN_DECISION_LOG";
export const DEFAULT_LOG_DIR = ".warren";
export const DEFAULT_LOG_FILE = "decisions.jsonl";

/** Per-field clip lengths. Every one exists to keep a log line readable. */
export const CLIP_INSTRUCTIONS = 500;
export const CLIP_CRITERION = 160;
export const CLIP_REASON = 500;
export const CLIP_SUBJECT = 200;
export const CLIP_ANSWER_CHOICE = 200;

/** Ceiling for `readLogTail`; the daily cap only ever needs today's rows. */
export const MAX_LOG_READ_BYTES = 2_000_000;

/** One question as it appears in the log: type + clipped prompt/criteria. */
export interface LoggedQuestion {
	type: Question["type"];
	instructions: string;
	criteria?: string[] | Record<string, string>;
}

export interface DecisionRecord {
	ts: string;
	feature: string;
	subject?: string;
	outcome: Decision["outcome"];
	band?: Band;
	via?: DecisionVia;
	provider?: string;
	model?: string;
	ms?: number;
	usage?: DecisionUsage;
	/** sha256 (first 16 hex) of the request's `state` — identity without the payload. */
	stateHash?: string;
	questions: Record<string, LoggedQuestion>;
	answers?: Record<string, Answer>;
	reason?: string;
}

/** Clip `value` to `limit` characters, marking that it was cut. */
export function clip(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, limit)}…[clipped]`;
}

/** Clip one answer's string payload so a runaway `choice` cannot bloat a line. */
function clipAnswer(answer: Answer): Answer {
	return {
		noul: answer.noul,
		score: answer.score,
		choice: answer.choice === undefined ? undefined : clip(answer.choice, CLIP_ANSWER_CHOICE),
		confidence: answer.confidence,
	};
}

function clipMap(criteria: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(criteria)) {
		if (value !== undefined) out[key] = clip(value, CLIP_CRITERION);
	}
	return out;
}

function clipCriteria(question: Question): string[] | Record<string, string> | undefined {
	switch (question.type) {
		case "noul":
			return question.criteria === undefined ? undefined : clipMap(question.criteria);
		case "score":
			return question.criteria.map((entry) => clip(entry, CLIP_CRITERION));
		case "choice":
			return clipMap(question.criteria);
	}
}

function clipQuestions(questions: Record<string, Question>): Record<string, LoggedQuestion> {
	const out: Record<string, LoggedQuestion> = {};
	for (const [name, question] of Object.entries(questions)) {
		out[name] = {
			type: question.type,
			instructions: clip(question.instructions, CLIP_INSTRUCTIONS),
			criteria: clipCriteria(question),
		};
	}
	return out;
}

function clipAnswers(answers: Record<string, Answer>): Record<string, Answer> {
	const out: Record<string, Answer> = {};
	for (const [name, answer] of Object.entries(answers)) out[name] = clipAnswer(answer);
	return out;
}

/**
 * Deterministic JSON: object keys sorted, so the same logical value
 * always hashes and keys the cache identically regardless of insertion
 * order. Arrays keep their order (it is meaningful in criteria legends).
 */
export function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** sha256 (first 16 hex chars) of `value`'s stable JSON. */
export function hashJson(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

/** Resolve the log path: `$WARREN_DECISION_LOG`, else `$HOME/.warren/decisions.jsonl`. */
export function decisionLogPath(env: Env): string {
	const configured = envString(env, LOG_ENV);
	if (configured !== undefined) return configured;
	const home = envString(env, "HOME") ?? homedir();
	return join(home, DEFAULT_LOG_DIR, DEFAULT_LOG_FILE);
}

export interface BuildRecordInput {
	feature: string;
	subject?: string;
	state: Record<string, unknown>;
	questions: Record<string, Question>;
	decision: Decision;
	now: number;
}

/**
 * Project a decision into its log row. Optional keys that do not apply to
 * this outcome are left `undefined` and disappear at serialize time, so
 * the JSONL stays compact.
 */
export function buildRecord(input: BuildRecordInput): DecisionRecord {
	const base: DecisionRecord = {
		ts: new Date(input.now).toISOString(),
		feature: input.feature,
		subject: input.subject === undefined ? undefined : clip(input.subject, CLIP_SUBJECT),
		outcome: input.decision.outcome,
		stateHash: hashJson(input.state),
		questions: clipQuestions(input.questions),
	};
	if (input.decision.outcome !== "decided") {
		return { ...base, reason: clip(input.decision.reason, CLIP_REASON) };
	}
	return {
		...base,
		band: input.decision.band,
		via: input.decision.via,
		provider: input.decision.provider,
		model: input.decision.model,
		ms: input.decision.ms,
		usage: input.decision.usage,
		answers: clipAnswers(input.decision.answers),
	};
}

/** One log line (record + trailing newline). */
export function serializeRecord(record: DecisionRecord): string {
	return `${JSON.stringify(record)}\n`;
}

export interface AppendOptions {
	path?: string;
	env?: Env;
}

/**
 * Append one record. Sync on purpose: the line is a few hundred bytes and
 * the caller has already paid for a network round-trip, so ordering (the
 * cap reads this file back) matters far more than the microseconds an
 * async write would save. Never throws — see the module header.
 */
export function appendDecision(record: DecisionRecord, opts?: AppendOptions): void {
	const path = opts?.path ?? decisionLogPath(opts?.env ?? process.env);
	try {
		const dir = dirname(path);
		if (dir.length > 0) mkdirSync(dir, { recursive: true, mode: 0o700 });
		const fd = openSync(path, "a", 0o600);
		try {
			writeSync(fd, serializeRecord(record));
			fchmodSync(fd, 0o600);
		} finally {
			closeSync(fd);
		}
	} catch {
		// A decision must never fail because the audit log could not be
		// written (read-only volume, quota, missing HOME).
	}
}

/**
 * Read at most the last `maxBytes` of the log, dropping the leading and
 * trailing partial lines so every returned line is a complete record. The
 * daily cap only ever needs today's rows, so a months-old log costs the
 * same as an empty one. Missing/unreadable files read as `""`.
 */
export function readLogTail(path: string, maxBytes = MAX_LOG_READ_BYTES): string {
	try {
		const size = statSync(path).size;
		const length = Math.min(size, maxBytes);
		if (length === 0) return "";
		const buffer = Buffer.alloc(length);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		const text = buffer.toString("utf8");
		if (length === size) return text;
		const firstBreak = text.indexOf("\n");
		const lastBreak = text.lastIndexOf("\n");
		return lastBreak <= firstBreak ? "" : text.slice(firstBreak + 1, lastBreak + 1);
	} catch {
		return "";
	}
}
