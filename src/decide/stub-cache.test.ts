import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "./client.ts";
import {
	FIXED_NOW,
	jsonResponse,
	makeHarness,
	QUESTION_SET,
	SAMPLE_ANSWERS,
	SAMPLE_RESPONSE,
	SCORE_QUESTION,
} from "./test-helpers.ts";
import type { Decided, Decision } from "./types.ts";

const REQUEST = {
	feature: "merge-guard",
	state: { diffLines: 41, testsGreen: true },
	questions: QUESTION_SET,
} as const;

function decided(decision: Decision): Decided {
	if (decision.outcome !== "decided") {
		throw new Error(`expected a decided outcome, got ${decision.outcome}: ${decision.reason}`);
	}
	return decision;
}

describe("decide — stub provider", () => {
	test("WARREN_JEV_STUB=1 answers from the fixture without any network call", async () => {
		const h = makeHarness({ responses: [], env: { WARREN_JEV_STUB: "1" }, now: () => FIXED_NOW });
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result).toEqual({
			outcome: "decided",
			answers: SAMPLE_ANSWERS,
			band: "act",
			provider: "stub",
			model: "jev-stub-1",
			ms: 0,
			usage: { inputTokens: 0, outputTokens: 0 },
			via: "stub",
		});
		expect(h.calls).toHaveLength(0);
	});

	test("JEV_PROVIDER=stub selects the same path", async () => {
		const h = makeHarness({ responses: [], env: { JEV_PROVIDER: "stub" } });
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result.via).toBe("stub");
	});

	test("a missing fixture is unavailable, not a throw", async () => {
		const h = makeHarness({
			responses: [],
			env: { WARREN_JEV_STUB: "1", WARREN_JEV_STUB_FIXTURE: "/nonexistent/jev-stub.json" },
		});
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("could not be used");
	});

	test("WARREN_JEV_STUB_FIXTURE overrides per question, and an off-legend choice falls back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-decide-fixture-"));
		const fixture = join(dir, "custom.json");
		writeFileSync(
			fixture,
			JSON.stringify({
				model: "jev-stub-custom",
				defaults: { noul: { noul: 0.2 }, score: { score: 0.1 }, choice: { choice: "nope" } },
				answers: { merge_ok: { noul: 0.95, confidence: 0.99 } },
			}),
		);
		const h = makeHarness({
			responses: [],
			env: { WARREN_JEV_STUB: "1", WARREN_JEV_STUB_FIXTURE: fixture },
			now: () => FIXED_NOW,
		});
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result.model).toBe("jev-stub-custom");
		expect(result.answers.merge_ok).toEqual({ noul: 0.95, confidence: 0.99 });
		expect(result.answers.risk).toEqual({ score: 0.1 });
		expect(result.answers.band).toEqual({ choice: "act" });
		expect(result.usage).toBeUndefined();
	});

	test("a fixture that cannot answer a question type is unavailable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-decide-fixture-"));
		const fixture = join(dir, "thin.json");
		writeFileSync(fixture, JSON.stringify({ model: "thin", defaults: { noul: { noul: 0.5 } } }));
		const h = makeHarness({
			responses: [],
			env: { WARREN_JEV_STUB: "1", WARREN_JEV_STUB_FIXTURE: fixture },
		});
		const result = await decide({ ...REQUEST, questions: { risk: SCORE_QUESTION } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("cannot answer: risk");
	});

	test("the stub is not blocked by an exhausted cap", async () => {
		const h = makeHarness({
			responses: [],
			env: { WARREN_JEV_STUB: "1", WARREN_JEV_DAILY_CAP: "1" },
		});
		writeFileSync(h.logPath, `${todayRecordOf()}\n`);
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result.via).toBe("stub");
	});
});

function todayRecordOf(): string {
	return JSON.stringify({ ts: new Date().toISOString(), feature: "merge-guard", via: "live" });
}

describe("decide — cache", () => {
	test("WARREN_JEV_CACHE_TTL_MS serves the second identical call from the cache", async () => {
		const h = makeHarness({
			responses: [jsonResponse(200, SAMPLE_RESPONSE)],
			env: { WARREN_JEV_CACHE_TTL_MS: "60000" },
			now: () => FIXED_NOW,
		});
		const first = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		const second = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(first.via).toBe("live");
		expect(second.via).toBe("cache");
		expect(second.answers).toEqual(first.answers);
		expect(h.calls).toHaveLength(1);
	});

	test("a different state is a different cache key", async () => {
		const h = makeHarness({
			responses: [jsonResponse(200, SAMPLE_RESPONSE), jsonResponse(200, SAMPLE_RESPONSE)],
			env: { WARREN_JEV_CACHE_TTL_MS: "60000" },
		});
		await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		await decide({ ...REQUEST, state: { diffLines: 42 }, questions: { ...QUESTION_SET } }, h.deps);
		expect(h.calls).toHaveLength(2);
	});

	test("the cache is off by default", async () => {
		const h = makeHarness({
			responses: [jsonResponse(200, SAMPLE_RESPONSE), jsonResponse(200, SAMPLE_RESPONSE)],
		});
		await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(h.calls).toHaveLength(2);
	});
});

describe("decide — the decision log", () => {
	test("appends one row per call to WARREN_DECISION_LOG, with the caller's subject", async () => {
		const h = makeHarness({ responses: [jsonResponse(200, SAMPLE_RESPONSE)] });
		await decide({ ...REQUEST, subject: "run-7", questions: { ...QUESTION_SET } }, h.deps);
		expect(h.records).toHaveLength(1);
		const record = h.records[0];
		expect(record?.feature).toBe("merge-guard");
		expect(record?.subject).toBe("run-7");
		expect(record?.outcome).toBe("decided");
		expect(record?.band).toBe("act");
		expect(record?.via).toBe("live");
		expect(record?.provider).toBe("typesafe");
		expect(record?.model).toBe("jev-1.13.0");
		expect(record?.usage).toEqual({ inputTokens: 502, outputTokens: 69 });
		expect(record?.answers).toEqual(SAMPLE_ANSWERS);
		expect(record?.questions.band).toEqual({
			type: "choice",
			instructions: "What should Warren do next?",
			criteria: { act: "merge now", ask: "ask a human", hold: "stop" },
		});
		expect(record?.stateHash).toMatch(/^[0-9a-f]{16}$/);
		expect(record?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("logs failures too, and writes the real file when `append` is left alone", async () => {
		const h = makeHarness({ responses: [jsonResponse(500, { error: { message: "boom" } })] });
		delete h.deps.append;
		const result = await decide(
			{ ...REQUEST, subject: "run-8", questions: { ...QUESTION_SET } },
			h.deps,
		);
		expect(result.outcome).toBe("unavailable");
		const lines = readFileSync(h.logPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0] ?? "{}");
		expect(record.outcome).toBe("unavailable");
		expect(record.subject).toBe("run-8");
		expect(record.reason).toContain("HTTP 500");
		expect(record.band).toBeUndefined();
	});

	test("a throwing appender cannot break the decision", async () => {
		const h = makeHarness({ responses: [jsonResponse(200, SAMPLE_RESPONSE)] });
		h.deps.append = () => {
			throw new Error("disk full");
		};
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result.band).toBe("act");
	});
});
