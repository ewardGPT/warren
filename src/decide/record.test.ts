import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	appendDecision,
	buildRecord,
	clip,
	decisionLogPath,
	hashJson,
	LOG_ENV,
	readLogTail,
	serializeRecord,
	stableStringify,
} from "./record.ts";
import {
	CHOICE_QUESTION,
	makeHarness,
	QUESTION_SET,
	SAMPLE_ANSWERS,
	SCORE_QUESTION,
} from "./test-helpers.ts";
import type { Decided, Decision } from "./types.ts";

const DECIDED: Decided = {
	outcome: "decided",
	answers: SAMPLE_ANSWERS,
	band: "act",
	provider: "typesafe",
	model: "jev-1.13.0",
	ms: 138,
	usage: { inputTokens: 502, outputTokens: 69 },
	via: "live",
};

function build(decision: Decision, subject?: string) {
	return buildRecord({
		feature: "merge-guard",
		subject,
		state: { diffLines: 41, testsGreen: true },
		questions: QUESTION_SET,
		decision,
		now: 1_760_000_000_000,
	});
}

describe("decisionLogPath", () => {
	test("WARREN_DECISION_LOG wins", () => {
		expect(decisionLogPath({ [LOG_ENV]: "/tmp/custom.jsonl", HOME: "/home/x" })).toBe(
			"/tmp/custom.jsonl",
		);
	});

	test("defaults to $HOME/.warren/decisions.jsonl", () => {
		expect(decisionLogPath({ HOME: "/home/x" })).toBe("/home/x/.warren/decisions.jsonl");
	});
});

describe("clip", () => {
	test("leaves short strings alone and marks cut ones", () => {
		expect(clip("abc", 10)).toBe("abc");
		expect(clip("abcdef", 3)).toBe("abc…[clipped]");
		expect(clip("x".repeat(200), 10)).toHaveLength(10 + "…[clipped]".length);
	});
});

describe("stableStringify / hashJson", () => {
	test("key order does not change the value", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
		expect(hashJson({ b: 1, a: [2, 3] })).toBe(hashJson({ a: [2, 3], b: 1 }));
	});

	test("array order does change it", () => {
		expect(hashJson({ a: [1, 2] })).not.toBe(hashJson({ a: [2, 1] }));
	});

	test("the hash is a short hex fingerprint", () => {
		expect(hashJson({})).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("buildRecord", () => {
	test("a decided outcome logs band, provenance, usage, answers and the state fingerprint", () => {
		const record = build(DECIDED, "run-7");
		expect(record.ts).toBe("2025-10-09T08:53:20.000Z");
		expect(record.feature).toBe("merge-guard");
		expect(record.subject).toBe("run-7");
		expect(record.outcome).toBe("decided");
		expect(record.band).toBe("act");
		expect(record.via).toBe("live");
		expect(record.provider).toBe("typesafe");
		expect(record.model).toBe("jev-1.13.0");
		expect(record.ms).toBe(138);
		expect(record.usage).toEqual({ inputTokens: 502, outputTokens: 69 });
		expect(record.answers).toEqual(SAMPLE_ANSWERS);
		expect(record.stateHash).toMatch(/^[0-9a-f]{16}$/);
		expect(record.questions.merge_ok?.instructions).toBe(
			"Is it safe to merge this branch without human review?",
		);
		expect(record.questions.risk?.criteria).toEqual(SCORE_QUESTION.criteria);
		expect(record.questions.band?.criteria).toEqual(CHOICE_QUESTION.criteria);
	});

	test("an undecided outcome logs the reason and no band", () => {
		const record = build({ outcome: "unavailable", reason: "HTTP 500 from Jev" });
		expect(record.reason).toBe("HTTP 500 from Jev");
		expect(record.band).toBeUndefined();
		expect(record.via).toBeUndefined();
		expect(JSON.parse(serializeRecord(record))).toEqual({
			ts: record.ts,
			feature: "merge-guard",
			outcome: "unavailable",
			stateHash: record.stateHash,
			questions: record.questions,
			reason: "HTTP 500 from Jev",
		});
	});

	test("long fields are clipped, including inside the questions", () => {
		const record = buildRecord({
			feature: "f",
			subject: "s".repeat(500),
			state: {},
			questions: {
				q: { type: "score", instructions: "i".repeat(5000), criteria: ["c".repeat(900)] },
			},
			decision: { outcome: "unavailable", reason: "r".repeat(5000) },
			now: 1_760_000_000_000,
		});
		expect(record.subject).toHaveLength(200 + "…[clipped]".length);
		expect(record.questions.q?.instructions).toHaveLength(500 + "…[clipped]".length);
		expect(record.questions.q?.criteria).toEqual([`${"c".repeat(160)}…[clipped]`]);
		expect(record.reason).toHaveLength(500 + "…[clipped]".length);
	});

	test("the state itself is never written, only its fingerprint", () => {
		const line = serializeRecord(build(DECIDED, "run-7"));
		expect(line).not.toContain("testsGreen");
		expect(line).toContain('"stateHash"');
	});
});

describe("appendDecision", () => {
	test("creates the directory and the file, appending one line per record", () => {
		const h = makeHarness({});
		const path = join(h.logPath, "..", "nested", "decisions.jsonl");
		appendDecision(build(DECIDED, "one"), { path });
		appendDecision(build(DECIDED, "two"), { path });
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "{}").subject).toBe("one");
		expect(JSON.parse(lines[1] ?? "{}").subject).toBe("two");
	});

	test("the log is 0600, and an existing looser file is tightened", () => {
		const h = makeHarness({});
		appendDecision(build(DECIDED), { path: h.logPath });
		expect(statSync(h.logPath).mode & 0o777).toBe(0o600);

		chmodSync(h.logPath, 0o644);
		appendDecision(build(DECIDED), { path: h.logPath });
		expect(statSync(h.logPath).mode & 0o777).toBe(0o600);
	});

	test("an unwritable path is swallowed, never thrown", () => {
		const h = makeHarness({});
		const blocker = join(h.logPath, "..", "blocker");
		writeFileSync(blocker, "not a directory");
		expect(() =>
			appendDecision(build(DECIDED), { path: join(blocker, "decisions.jsonl") }),
		).not.toThrow();
	});

	test("defaults to the env's log path", () => {
		const h = makeHarness({});
		appendDecision(build(DECIDED, "via-env"), { env: h.env });
		expect(existsSync(h.logPath)).toBe(true);
		expect(readFileSync(h.logPath, "utf8")).toContain("via-env");
	});
});

describe("readLogTail", () => {
	test("a missing file reads as empty", () => {
		expect(readLogTail("/nonexistent/warren/decisions.jsonl")).toBe("");
	});

	test("reads the whole file when it fits", () => {
		const h = makeHarness({});
		appendDecision(build(DECIDED), { path: h.logPath });
		expect(readLogTail(h.logPath)).toBe(readFileSync(h.logPath, "utf8"));
	});

	test("truncates to complete trailing lines only", () => {
		const h = makeHarness({});
		for (let index = 0; index < 6; index += 1) {
			appendDecision(
				buildRecord({
					feature: "f",
					subject: `row-${index}`,
					state: {},
					questions: { q: { type: "noul", instructions: "?" } },
					decision: { outcome: "unavailable", reason: "r" },
					now: 1_760_000_000_000,
				}),
				{ path: h.logPath },
			);
		}
		const lines = readFileSync(h.logPath, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(6);
		const lastLine = lines.at(-1) ?? "";
		const window = lastLine.length + 10;
		const tail = readLogTail(h.logPath, window);
		expect(tail).toBe(`${lastLine}\n`);
		expect(tail.length).toBeLessThanOrEqual(window);
		expect(JSON.parse(tail.trim()).subject).toBe("row-5");
	});
});
