/**
 * `src/decide/cascade.test.ts` — the Laya → Jev tandem.
 *
 * The two properties worth guarding are the ones that make the pair useful
 * and safe at once: a confident Laya verdict costs no Jev call at all, and
 * a Jev verdict can never lift a band Laya already refused to act on.
 */

import { describe, expect, test } from "bun:test";
import {
	CASCADE_ENV,
	CONFIDENCE_ENV,
	decideWithCascade,
	foldCascade,
	needsEscalation,
	weakestConfidence,
} from "./cascade.ts";
import { PROVIDERS, resolveProvider } from "./provider.ts";
import { jsonResponse, makeHarness } from "./test-helpers.ts";
import type { Answer, Band, Decided, Decision, Env, Question } from "./types.ts";

const QUESTIONS: Record<string, Question> = {
	ok: {
		type: "noul",
		instructions: "Is it safe to proceed?",
		criteria: { true: "safe", false: "not safe" },
	},
};

const REQUEST = { feature: "cascade-test", state: { attempts: 1 }, questions: QUESTIONS };

const LAYA_URL = "http://127.0.0.1:18091/v1/systemone";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/** A 200 whose single `noul` answer carries this probability and confidence. */
function answer(noul: number, confidence: number): Response {
	return jsonResponse(200, {
		model: "test-model",
		answers: { ok: { type: "noul", noul, confidence } },
		usage: { input_tokens: 5, output_tokens: 0 },
	});
}

function decided(decision: Decision): Decided {
	if (decision.outcome !== "decided") {
		throw new Error(`expected a decided outcome, got ${decision.outcome}: ${decision.reason}`);
	}
	return decision;
}

function verdict(provider: string, band: Band, answers: Record<string, Answer> = {}): Decided {
	return { outcome: "decided", answers, band, provider, model: "m", ms: 1, via: "live" };
}

const ON: Env = { [CASCADE_ENV]: "1" };

describe("decideWithCascade — a confident first opinion never reaches Jev", () => {
	test("an act from Laya answers alone, on one call", async () => {
		const h = makeHarness({ env: ON, responses: [answer(0.95, 0.9)] });
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls.map((call) => call.url)).toEqual([LAYA_URL]);
		expect(result.band).toBe("act");
		expect(result.provider).toBe("laya");
		expect(result.answers).toEqual({ ok: { noul: 0.95, confidence: 0.9 } });
	});

	test("a hold from Laya answers alone, and is never sent to Jev for a second look", async () => {
		const h = makeHarness({ env: ON, responses: [answer(0.02, 0.99)] });
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls.map((call) => call.url)).toEqual([LAYA_URL]);
		expect(result.band).toBe("hold");
	});

	test("an unsure Laya still answers alone when its confidence clears the bar", async () => {
		const h = makeHarness({ env: ON, responses: [answer(0.5, 0.9)] });
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls).toHaveLength(1);
		expect(result.band).toBe("ask");
	});

	test("the escalation bar is readable from the environment", async () => {
		const h = makeHarness({
			env: { ...ON, [CONFIDENCE_ENV]: "0.2" },
			responses: [answer(0.5, 0.4)],
		});
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls).toHaveLength(1);
		expect(result.band).toBe("ask");
	});

	test("a junk bar narrows nothing and widens nothing", async () => {
		const h = makeHarness({
			env: { ...ON, [CONFIDENCE_ENV]: "nonsense" },
			responses: [answer(0.5, 0.4), answer(0.02, 0.9)],
		});
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls).toHaveLength(2);
		expect(result.band).toBe("hold");
	});
});

describe("decideWithCascade — the second look may add a block and never remove one", () => {
	test("both routes run in order when Laya is unsure", async () => {
		const h = makeHarness({ env: ON, responses: [answer(0.5, 0.4), answer(0.02, 0.9)] });
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls.map((call) => call.url)).toEqual([LAYA_URL, TYPESAFE_URL]);
		expect(result.band).toBe("hold");
		expect(result.provider).toBe("laya+typesafe");
	});

	test("Jev acting cannot lift an ask that Laya already returned", async () => {
		const h = makeHarness({ env: ON, responses: [answer(0.5, 0.3), answer(0.98, 0.99)] });
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls.map((call) => call.url)).toEqual([LAYA_URL, TYPESAFE_URL]);
		expect(result.band).toBe("ask");
		expect(result.provider).toBe("laya+typesafe");
		// The stage that landed on the folded band supplies the answers, so the
		// verdict cannot be read as Jev's `act`.
		expect(result.answers).toEqual({ ok: { noul: 0.5, confidence: 0.3 } });
	});
});

describe("decideWithCascade — degrade, never block", () => {
	test("an unreachable Laya turns the tandem into a plain Jev call", async () => {
		const h = makeHarness({
			env: ON,
			responses: [jsonResponse(503, { error: "relay down" }), answer(0.95, 0.9)],
		});
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls.map((call) => call.url)).toEqual([LAYA_URL, TYPESAFE_URL]);
		expect(result.provider).toBe("typesafe");
		expect(result.band).toBe("act");
	});

	test("an unreachable Jev leaves the first opinion standing", async () => {
		const h = makeHarness({
			env: ON,
			responses: [answer(0.5, 0.3), jsonResponse(503, { error: "hosted route down" })],
		});
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls.map((call) => call.url)).toEqual([LAYA_URL, TYPESAFE_URL]);
		expect(result.provider).toBe("laya");
		expect(result.band).toBe("ask");
	});
});

describe("decideWithCascade — the single-opinion paths", () => {
	test("the tandem is off without the switch, and Jev answers alone", async () => {
		const h = makeHarness({ responses: [answer(0.95, 0.9)] });
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls.map((call) => call.url)).toEqual([TYPESAFE_URL]);
		expect(result.provider).toBe("typesafe");
	});

	test("an engine already aimed at Laya is not asked twice", async () => {
		const h = makeHarness({
			env: { ...ON, JEV_PROVIDER: "laya" },
			responses: [answer(0.95, 0.9)],
		});
		const result = decided(await decideWithCascade(REQUEST, h.deps));
		expect(h.calls).toHaveLength(1);
		expect(result.provider).toBe("laya");
	});

	test("the forced stub stays offline and never dials either route", async () => {
		const h = makeHarness({
			env: { ...ON, JEV_PROVIDER: "stub" },
			responses: [],
		});
		const result = await decideWithCascade(REQUEST, h.deps);
		expect(h.calls).toHaveLength(0);
		expect(result.outcome).toBe("decided");
	});

	test("LAYA_URL moves the first opinion to the operator's own address", async () => {
		const h = makeHarness({
			env: { ...ON, LAYA_URL: "http://laya.test/v1/systemone" },
			responses: [answer(0.95, 0.9)],
		});
		await decideWithCascade(REQUEST, h.deps);
		expect(h.calls.map((call) => call.url)).toEqual(["http://laya.test/v1/systemone"]);
	});
});

describe("weakestConfidence — worst-first, like the band fold", () => {
	test("returns the lowest confidence on the set", () => {
		expect(
			weakestConfidence({ a: { noul: 0.9, confidence: 0.8 }, b: { noul: 0.2, confidence: 0.3 } }),
		).toBe(0.3);
	});

	test("ignores answers that carry no confidence", () => {
		expect(weakestConfidence({ a: { noul: 0.9, confidence: 0.4 }, b: { noul: 0.2 } })).toBe(0.4);
	});

	test("treats a set with no confidence at all as unsure rather than certain", () => {
		expect(weakestConfidence({ a: { noul: 0.99 } })).toBe(0);
		expect(weakestConfidence({})).toBe(0);
	});
});

describe("needsEscalation", () => {
	test("never escalates a hold, at any confidence", () => {
		expect(
			needsEscalation(verdict("laya", "hold", { ok: { noul: 0.01, confidence: 0 } }), 0.7),
		).toBe(false);
	});

	test("escalates below the bar and rests at or above it", () => {
		const unsure = verdict("laya", "ask", { ok: { noul: 0.5, confidence: 0.69 } });
		const sure = verdict("laya", "ask", { ok: { noul: 0.5, confidence: 0.7 } });
		expect(needsEscalation(unsure, 0.7)).toBe(true);
		expect(needsEscalation(sure, 0.7)).toBe(false);
	});
});

describe("foldCascade", () => {
	test("takes the worse band in either direction", () => {
		expect(foldCascade(verdict("laya", "act"), verdict("typesafe", "hold")).band).toBe("hold");
		expect(foldCascade(verdict("laya", "ask"), verdict("typesafe", "act")).band).toBe("ask");
		expect(foldCascade(verdict("laya", "act"), verdict("typesafe", "act")).band).toBe("act");
	});

	test("names both stages, because the verdict came from the pair", () => {
		const folded = foldCascade(verdict("laya", "act"), verdict("typesafe", "ask"));
		expect(folded.provider).toBe("laya+typesafe");
		expect(folded.band).toBe("ask");
	});
});

describe("the laya provider is an addition, never a substitute", () => {
	test("defaults to the relay address and can be overridden", () => {
		expect(PROVIDERS.laya.url).toBe(LAYA_URL);
		expect(PROVIDERS.laya.urlEnv).toBe("LAYA_URL");
	});

	test("a Laya key alone does not move ordinary calls off Jev", () => {
		// `laya` is absent from DEFAULT_PROVIDER_ORDER on purpose: an operator
		// who sets a Laya key must not silently reroute every existing call.
		const resolved = resolveProvider({ TYPESAFE_API_KEY: "k", LAYA_API_KEY: "l" });
		expect(resolved.ok).toBe(true);
		if (resolved.ok) expect(resolved.provider.name).toBe("typesafe");
	});

	test("resolves without a key, because the relay authenticates on its side", () => {
		const resolved = resolveProvider({ JEV_PROVIDER: "laya" });
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.provider.name).toBe("laya");
			expect(resolved.provider.key).toBe("");
			expect(resolved.provider.url).toBe(LAYA_URL);
		}
	});
});
