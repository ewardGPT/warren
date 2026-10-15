import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { DEFAULT_RETRY_DELAY_MS, decide } from "./client.ts";
import {
	abortableResponse,
	FIXED_NOW,
	jsonResponse,
	makeHarness,
	NOUL_QUESTION,
	QUESTION_SET,
	SAMPLE_ANSWERS,
	SAMPLE_RESPONSE,
	textResponse,
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

describe("decide — a 200 with all three question types", () => {
	test("parses noul, score and choice answers, their confidence and the usage", async () => {
		const h = makeHarness({
			responses: [jsonResponse(200, SAMPLE_RESPONSE)],
			now: () => FIXED_NOW,
		});
		const result = await decide(
			{ ...REQUEST, subject: "run-7", questions: { ...QUESTION_SET } },
			h.deps,
		);
		expect(result).toEqual({
			outcome: "decided",
			answers: SAMPLE_ANSWERS,
			band: "act",
			provider: "typesafe",
			model: "jev-1.13.0",
			ms: 0,
			usage: { inputTokens: 502, outputTokens: 69 },
			via: "live",
		});
	});

	test("posts exactly the agreed request", async () => {
		const h = makeHarness({ responses: [jsonResponse(200, SAMPLE_RESPONSE)] });
		await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(h.calls).toHaveLength(1);
		const call = h.calls[0];
		expect(call?.url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(call?.method).toBe("POST");
		expect(call?.headers.authorization).toBe("Bearer test-key");
		expect(call?.headers["content-type"]).toBe("application/json");
		expect(call?.headers["x-title"]).toBe("warren");
		expect(JSON.parse(call?.body ?? "null")).toEqual({
			model: "jev-1.13.0",
			state: { diffLines: 41, testsGreen: true },
			questions: QUESTION_SET,
		});
	});

	test("the request's timeoutMs becomes an abort signal on the fetch", async () => {
		const h = makeHarness({ responses: [jsonResponse(200, SAMPLE_RESPONSE)] });
		await decide({ ...REQUEST, timeoutMs: 1500 }, h.deps);
		expect(h.calls[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(h.calls[0]?.signal?.aborted).toBe(false);
	});

	test("JEV_MODEL and JEV_PROVIDER=openrouter are honoured on the wire", async () => {
		const h = makeHarness({
			responses: [jsonResponse(200, { ...SAMPLE_RESPONSE, model: undefined })],
			env: {
				JEV_PROVIDER: "openrouter",
				JEV_MODEL: "typesafe/jev-pinned",
				OPENROUTER_API_KEY: "or-key",
			},
		});
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(h.calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions");
		expect(h.calls[0]?.headers.authorization).toBe("Bearer or-key");
		expect(JSON.parse(h.calls[0]?.body ?? "null").model).toBe("typesafe/jev-pinned");
		expect(result.model).toBe("typesafe/jev-pinned");
		expect(result.provider).toBe("openrouter");
	});

	test("the response model wins over the requested one", async () => {
		const h = makeHarness({ responses: [jsonResponse(200, SAMPLE_RESPONSE)] });
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result.model).toBe("jev-1.13.0");
	});

	test("ms measures the call, not the clock's epoch", async () => {
		let clock = FIXED_NOW;
		const h = makeHarness({
			responses: [
				() => {
					clock += 150;
					return jsonResponse(200, SAMPLE_RESPONSE);
				},
			],
			now: () => clock,
		});
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result.ms).toBe(150);
	});

	test("band folds worst-first when no question is named `band`", async () => {
		const h = makeHarness({
			responses: [
				jsonResponse(200, {
					model: "jev-1.13.0",
					answers: { go: { noul: 0.99 }, stop: { noul: 0.02 } },
				}),
			],
		});
		const result = decided(
			await decide(
				{
					feature: "merge-guard",
					state: {},
					questions: {
						go: { type: "noul", instructions: "go?" },
						stop: { type: "noul", instructions: "stop?" },
					},
				},
				h.deps,
			),
		);
		expect(result.band).toBe("hold");
	});

	test("actAt / denyAt steer the band", async () => {
		const h = makeHarness({
			responses: [jsonResponse(200, { model: "m", answers: { merge_ok: { noul: 0.81 } } })],
		});
		const questions = { merge_ok: NOUL_QUESTION };
		expect(decided(await decide({ ...REQUEST, questions }, h.deps)).band).toBe("ask");
		const h2 = makeHarness({
			responses: [jsonResponse(200, { model: "m", answers: { merge_ok: { noul: 0.81 } } })],
		});
		expect(decided(await decide({ ...REQUEST, questions, actAt: 0.8 }, h2.deps)).band).toBe("act");
	});
});

describe("decide — failure contract", () => {
	test("a missing answer key is unavailable, naming the key", async () => {
		const h = makeHarness({
			responses: [
				jsonResponse(200, {
					model: "jev-1.13.0",
					answers: { merge_ok: { noul: 0.81 }, band: { choice: "act" } },
				}),
			],
		});
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("risk");
	});

	test("an answer with only a confidence is not an answer", async () => {
		const h = makeHarness({
			responses: [jsonResponse(200, { answers: { merge_ok: { confidence: 0.9 } } })],
		});
		const result = await decide({ ...REQUEST, questions: { merge_ok: NOUL_QUESTION } }, h.deps);
		expect(result.outcome).toBe("unavailable");
	});

	test("HTTP 500 is unavailable, surfaces the provider message and never throws", async () => {
		const h = makeHarness({
			responses: [jsonResponse(500, { error: { message: "upstream exploded" } })],
		});
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("HTTP 500");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("upstream exploded");
		expect(h.calls).toHaveLength(1);
	});

	test("a non-JSON 200 body is unavailable", async () => {
		const h = makeHarness({ responses: [textResponse(200, "<html>gone</html>")] });
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("not JSON");
	});

	test("a 200 with no answers object is unavailable", async () => {
		const h = makeHarness({ responses: [jsonResponse(200, { model: "jev-1.13.0" })] });
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain('"answers"');
	});

	test("no key anywhere is unavailable before any network call", async () => {
		const h = makeHarness({
			responses: [],
			env: { TYPESAFE_API_KEY: undefined, JEV_API_KEY: undefined, OPENROUTER_API_KEY: undefined },
		});
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("TYPESAFE_API_KEY");
		expect(h.calls).toHaveLength(0);
	});

	test("an unknown JEV_PROVIDER is reported, not ignored", async () => {
		const h = makeHarness({ responses: [], env: { JEV_PROVIDER: "mystery" } });
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("unknown JEV_PROVIDER");
		expect(h.calls).toHaveLength(0);
	});

	test("nothing to ask is unsure", async () => {
		const h = makeHarness({ responses: [] });
		const result = await decide({ ...REQUEST, questions: {} }, h.deps);
		expect(result).toEqual({ outcome: "unsure", reason: "no questions requested" });
		expect(h.calls).toHaveLength(0);
	});
});

describe("decide — retries", () => {
	test("a dropped connection is retried exactly once", async () => {
		const h = makeHarness({
			responses: [
				() => {
					throw new Error("ECONNRESET");
				},
				jsonResponse(200, SAMPLE_RESPONSE),
			],
		});
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result.via).toBe("live");
		expect(h.calls).toHaveLength(2);
		expect(h.sleeps).toEqual([DEFAULT_RETRY_DELAY_MS]);
	});

	test("a dropped connection is not retried when the budget cannot absorb the wait", async () => {
		const h = makeHarness({
			responses: [
				() => {
					throw new Error("ECONNRESET");
				},
			],
		});
		const result = await decide(
			{ ...REQUEST, questions: { ...QUESTION_SET }, timeoutMs: 10 },
			h.deps,
		);
		expect(result.outcome).toBe("unavailable");
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toEqual([]);
	});

	test("429 with retry-after is retried once when the budget allows", async () => {
		const h = makeHarness({
			responses: [
				jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "1" }),
				jsonResponse(200, SAMPLE_RESPONSE),
			],
		});
		const result = decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(result.outcome).toBe("decided");
		expect(h.calls).toHaveLength(2);
		expect(h.sleeps).toEqual([1000]);
	});

	test("429 without retry-after waits the default delay", async () => {
		const h = makeHarness({
			responses: [jsonResponse(429, {}), jsonResponse(200, SAMPLE_RESPONSE)],
		});
		decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(h.sleeps).toEqual([DEFAULT_RETRY_DELAY_MS]);
	});

	test("429 is not retried when retry-after exceeds the remaining budget", async () => {
		const h = makeHarness({
			responses: [
				jsonResponse(429, { error: { message: "slow down" } }, { "retry-after": "5" }),
				jsonResponse(200, SAMPLE_RESPONSE),
			],
		});
		const result = await decide(
			{ ...REQUEST, questions: { ...QUESTION_SET }, timeoutMs: 50 },
			h.deps,
		);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("not retried");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("HTTP 429");
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toEqual([]);
	});

	test("529 is retryable, and a second 429 stops there", async () => {
		const h = makeHarness({
			responses: [
				jsonResponse(529, {}, { "retry-after": "1" }),
				jsonResponse(429, {}, { "retry-after": "1" }),
			],
		});
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("unavailable");
		expect(h.calls).toHaveLength(2);
		expect(h.sleeps).toEqual([1000]);
	});

	test("a timeout is never retried", async () => {
		const h = makeHarness({ responses: [abortableResponse()] });
		const result = await decide(
			{ ...REQUEST, questions: { ...QUESTION_SET }, timeoutMs: 30 },
			h.deps,
		);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("timed out after");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("not retried");
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toEqual([]);
	});

	test("a fetch that ignores its abort signal still returns at the deadline", async () => {
		const h = makeHarness({ responses: [() => Promise.withResolvers<Response>().promise] });
		const result = await decide(
			{ ...REQUEST, questions: { ...QUESTION_SET }, timeoutMs: 25 },
			h.deps,
		);
		expect(result.outcome).toBe("unavailable");
		expect(result.outcome === "unavailable" ? result.reason : "").toContain("timed out after");
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toEqual([]);
	});
});

describe("decide — budget cap", () => {
	const todayRecord = (extra: Record<string, unknown>) =>
		`${JSON.stringify({ ts: new Date().toISOString(), feature: "merge-guard", via: "live", ...extra })}\n`;

	test("the cap blocks the call once today's live calls are spent", async () => {
		const h = makeHarness({ responses: [jsonResponse(200, SAMPLE_RESPONSE)] });
		writeFileSync(h.logPath, `${todayRecord({})}${todayRecord({ band: "act" })}`);
		h.env.WARREN_JEV_DAILY_CAP = "2";
		const result = await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps);
		expect(result.outcome).toBe("over-budget");
		expect(result.outcome === "over-budget" ? result.reason : "").toContain("2/2");
		expect(h.calls).toHaveLength(0);
	});

	test("a stub or cache record does not count against the cap", async () => {
		const h = makeHarness({
			responses: [jsonResponse(200, SAMPLE_RESPONSE)],
			env: { WARREN_JEV_DAILY_CAP: "1" },
		});
		writeFileSync(
			h.logPath,
			`${todayRecord({ via: "stub" })}${todayRecord({ via: "cache" })}${todayRecord({ feature: "other", via: "live" })}`,
		);
		decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(h.calls).toHaveLength(1);
	});

	test("the cap is off by default", async () => {
		const h = makeHarness({ responses: [jsonResponse(200, SAMPLE_RESPONSE)] });
		writeFileSync(h.logPath, todayRecord({}));
		decided(await decide({ ...REQUEST, questions: { ...QUESTION_SET } }, h.deps));
		expect(h.calls).toHaveLength(1);
	});
});
