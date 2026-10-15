import { describe, expect, test } from "bun:test";
import {
	buildHeaders,
	buildRequestBody,
	envString,
	extractErrorMessage,
	parseJevResponse,
	parseRetryAfterMs,
	readAnswer,
	readPositiveInt,
	readUsage,
	resolveProvider,
} from "./provider.ts";
import { QUESTION_SET, SAMPLE_RESPONSE } from "./test-helpers.ts";

describe("resolveProvider", () => {
	test("defaults to typesafe when TYPESAFE_API_KEY is present", () => {
		const result = resolveProvider({ TYPESAFE_API_KEY: "ts-key" });
		expect(result.ok).toBe(true);
		expect(result.ok ? result.provider : null).toEqual({
			name: "typesafe",
			url: "https://api.typesafe.ai/v1/systemone",
			model: "jev-1.13.0",
			key: "ts-key",
		});
	});

	test("JEV_API_KEY is the alias for the typesafe key", () => {
		const result = resolveProvider({ JEV_API_KEY: "jev-key" });
		expect(result.ok ? result.provider.key : null).toBe("jev-key");
	});

	test("TYPESAFE_API_KEY wins over the JEV_API_KEY alias", () => {
		const result = resolveProvider({ TYPESAFE_API_KEY: "primary", JEV_API_KEY: "alias" });
		expect(result.ok ? result.provider.key : null).toBe("primary");
	});

	test("falls back to openrouter when only its key is present", () => {
		const result = resolveProvider({ OPENROUTER_API_KEY: "or-key" });
		expect(result.ok ? result.provider : null).toEqual({
			name: "openrouter",
			url: "https://openrouter.ai/api/alpha/decisions",
			model: "typesafe/jev-1.13",
			key: "or-key",
		});
	});

	test("JEV_PROVIDER selects a provider explicitly, case-insensitively", () => {
		const result = resolveProvider({ JEV_PROVIDER: "Vercel", AI_GATEWAY_API_KEY: "gw" });
		expect(result.ok ? result.provider.url : null).toBe(
			"https://ai-gateway.vercel.sh/typesafe/v1/systemone",
		);
		expect(result.ok ? result.provider.model : null).toBe("typesafe-ai/jev");
	});

	test("an unknown JEV_PROVIDER is reported", () => {
		const result = resolveProvider({ JEV_PROVIDER: "mystery", TYPESAFE_API_KEY: "ts" });
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toContain('unknown JEV_PROVIDER "mystery"');
	});

	test("a selected provider with no key reports the env vars it needs", () => {
		const result = resolveProvider({ JEV_PROVIDER: "vercel" });
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toContain("AI_GATEWAY_API_KEY");
	});

	test("no key anywhere reports the default provider's vars", () => {
		const result = resolveProvider({});
		expect(result.ok).toBe(false);
		expect(result.ok ? "" : result.reason).toContain("TYPESAFE_API_KEY or JEV_API_KEY");
	});

	test("a blank key reads as absent", () => {
		const result = resolveProvider({ TYPESAFE_API_KEY: "   ", OPENROUTER_API_KEY: "or" });
		expect(result.ok ? result.provider.name : null).toBe("openrouter");
	});

	test("JEV_MODEL overrides the provider's model", () => {
		const result = resolveProvider({ TYPESAFE_API_KEY: "ts", JEV_MODEL: "jev-1.14.0" });
		expect(result.ok ? result.provider.model : null).toBe("jev-1.14.0");
	});

	test("the stub provider needs no key", () => {
		const result = resolveProvider({ JEV_PROVIDER: "stub" });
		expect(result.ok ? result.provider.name : null).toBe("stub");
	});

	test("WARREN_JEV_STUB=1 selects the stub without JEV_PROVIDER", () => {
		const result = resolveProvider({ WARREN_JEV_STUB: "1", TYPESAFE_API_KEY: "ts" });
		expect(result.ok ? result.provider.name : null).toBe("stub");
	});
});

describe("env readers", () => {
	test("envString trims and treats blanks as absent", () => {
		expect(envString({ A: "  x  " }, "A")).toBe("x");
		expect(envString({ A: "   " }, "A")).toBeUndefined();
		expect(envString({}, "A")).toBeUndefined();
	});

	test("readPositiveInt accepts integers ≥ 1 and rejects everything else", () => {
		expect(readPositiveInt({ A: "5" }, "A")).toBe(5);
		expect(readPositiveInt({ A: " 5 " }, "A")).toBe(5);
		expect(readPositiveInt({ A: "0" }, "A")).toBeUndefined();
		expect(readPositiveInt({ A: "-1" }, "A")).toBeUndefined();
		expect(readPositiveInt({ A: "2.5" }, "A")).toBeUndefined();
		expect(readPositiveInt({ A: "lots" }, "A")).toBeUndefined();
		expect(readPositiveInt({}, "A")).toBeUndefined();
	});
});

describe("the wire request", () => {
	test("headers carry the bearer key, JSON content type and title", () => {
		expect(buildHeaders("k", "warren")).toEqual({
			authorization: "Bearer k",
			"content-type": "application/json",
			"x-title": "warren",
		});
	});

	test("the body is exactly model + state + questions", () => {
		const body = buildRequestBody(
			"jev-1.13.0",
			{ a: 1 },
			{ q: { type: "noul", instructions: "?" } },
		);
		expect(JSON.parse(body)).toEqual({
			model: "jev-1.13.0",
			state: { a: 1 },
			questions: { q: { type: "noul", instructions: "?" } },
		});
	});
});

describe("parseJevResponse", () => {
	test("parses the real 200 body into answers, model and usage", () => {
		const parsed = parseJevResponse(SAMPLE_RESPONSE, QUESTION_SET);
		expect(parsed.ok).toBe(true);
		expect(parsed.ok ? parsed.value.answers : null).toEqual({
			merge_ok: { noul: 0.81, confidence: 0.79 },
			risk: { score: 1.76, confidence: 0.62 },
			band: { choice: "act", confidence: 0.79 },
		});
		expect(parsed.ok ? parsed.value.model : null).toBe("jev-1.13.0");
		expect(parsed.ok ? parsed.value.usage : null).toEqual({ inputTokens: 502, outputTokens: 69 });
	});

	test("a missing requested key fails, naming it", () => {
		const parsed = parseJevResponse(
			{ answers: { merge_ok: { noul: 0.81 }, band: { choice: "act" } } },
			QUESTION_SET,
		);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok ? "" : parsed.reason).toContain("risk");
	});

	test("the answers object itself must be there", () => {
		expect(parseJevResponse({ model: "m" }, QUESTION_SET).ok).toBe(false);
		expect(parseJevResponse({ answers: [] }, QUESTION_SET).ok).toBe(false);
		expect(parseJevResponse("nope", QUESTION_SET).ok).toBe(false);
	});

	test("camelCase usage is accepted too", () => {
		const parsed = parseJevResponse(
			{ answers: { q: { noul: 1 } }, usage: { inputTokens: 7, outputTokens: 2 } },
			{ q: { type: "noul", instructions: "?" } },
		);
		expect(parsed.ok ? parsed.value.usage : null).toEqual({ inputTokens: 7, outputTokens: 2 });
	});

	test("an extra unrequested answer is ignored", () => {
		const parsed = parseJevResponse(
			{ answers: { q: { noul: 1 }, noise: { noul: 0 } } },
			{ q: { type: "noul", instructions: "?" } },
		);
		expect(parsed.ok ? Object.keys(parsed.value.answers) : []).toEqual(["q"]);
	});
});

describe("answer readers", () => {
	test("readAnswer keeps only the fields that were present", () => {
		expect(readAnswer({ type: "noul", noul: 0.5, confidence: 0.4, legend: { 0: "x" } })).toEqual({
			noul: 0.5,
			confidence: 0.4,
		});
		expect(readAnswer({ confidence: 0.9 })).toBeNull();
		expect(readAnswer({ noul: "high" })).toBeNull();
		expect(readAnswer(null)).toBeNull();
	});

	test("readUsage ignores anything without a token count", () => {
		expect(readUsage({ input_tokens: 1 })).toEqual({ inputTokens: 1, outputTokens: undefined });
		expect(readUsage({})).toBeUndefined();
		expect(readUsage(undefined)).toBeUndefined();
	});
});

describe("parseRetryAfterMs", () => {
	test("honours delta-seconds", () => {
		expect(parseRetryAfterMs("30")).toBe(30_000);
		expect(parseRetryAfterMs(" 1 ")).toBe(1000);
		expect(parseRetryAfterMs("0")).toBe(0);
	});

	test("rejects the forms it cannot honour", () => {
		expect(parseRetryAfterMs(null)).toBeNull();
		expect(parseRetryAfterMs("1.5")).toBeNull();
		expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
		expect(parseRetryAfterMs("-5")).toBeNull();
	});
});

describe("extractErrorMessage", () => {
	test("pulls the message out of openrouter's error envelope", () => {
		expect(extractErrorMessage({ error: { message: "Key limit exceeded" } })).toBe(
			"Key limit exceeded",
		);
		expect(extractErrorMessage({ message: "boom" })).toBe("boom");
		expect(extractErrorMessage({ detail: "d" })).toBe("d");
		expect(extractErrorMessage("plain text")).toBe("plain text");
		expect(extractErrorMessage({})).toBeUndefined();
		expect(extractErrorMessage(null)).toBeUndefined();
	});

	test("clips a verbose body", () => {
		const message = extractErrorMessage({ error: { message: "x".repeat(500) } });
		expect(message?.length).toBe(200);
	});
});
