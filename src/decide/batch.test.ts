/**
 * `src/decide/batch.test.ts` — many states, one forward pass.
 *
 * The properties worth guarding are alignment and isolation. Every decision
 * must line up with the state it judges, so a short answer has to fail its
 * whole chunk, and one bad chunk must not take the other chunks down with it.
 */

import { describe, expect, test } from "bun:test";
import { decideMany, MAX_BATCH_STATES, parseBatchResponse, screen } from "./batch.ts";
import { resolveProvider } from "./provider.ts";
import { jsonResponse, makeHarness } from "./test-helpers.ts";
import type { Decision, Question } from "./types.ts";

const LAYA_BATCH_URL = "http://172.17.0.1:18091/v1/systemone/batch";

const QUESTIONS: Record<string, Question> = {
	ok: {
		type: "noul",
		instructions: "Is it safe to proceed?",
		criteria: { true: "safe", false: "not safe" },
	},
};

const ON_LAYA = { JEV_PROVIDER: "laya" };

function states(count: number): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => ({ document: `candidate ${index}` }));
}

/** A batch body that answers every state the same way. */
function batchAnswer(count: number, noul = 0.95, confidence = 0.9): Response {
	return jsonResponse(200, {
		results: Array.from({ length: count }, () => ({
			model: "laya-rl-agent",
			answers: { ok: { type: "noul", noul, confidence } },
			usage: { input_tokens: 12, output_tokens: 0 },
		})),
	});
}

function decided(decision: Decision | undefined): Extract<Decision, { outcome: "decided" }> {
	if (decision === undefined || decision.outcome !== "decided") {
		throw new Error(`expected a decided outcome, got ${decision?.outcome ?? "nothing"}`);
	}
	return decision;
}

function request(count: number) {
	return { feature: "batch-test", states: states(count), questions: QUESTIONS };
}

/** The number of states each recorded request carried. */
function sizes(calls: readonly { body: string | null }[]): number[] {
	return calls.map(
		(call) => (JSON.parse(call.body ?? "{}") as { states: unknown[] }).states.length,
	);
}

describe("decideMany — chunking", () => {
	test("one request carries up to the measured ceiling of 64 states", async () => {
		const h = makeHarness({ env: ON_LAYA, responses: [batchAnswer(64)] });
		const out = await decideMany(request(64), h.deps);
		expect(h.calls).toHaveLength(1);
		expect(sizes(h.calls)).toEqual([64]);
		expect(out).toHaveLength(64);
		expect(decided(out[0]).band).toBe("act");
	});

	test("a larger set splits into requests the lane will accept", async () => {
		const h = makeHarness({
			env: ON_LAYA,
			responses: [batchAnswer(MAX_BATCH_STATES), batchAnswer(MAX_BATCH_STATES), batchAnswer(2)],
		});
		const out = await decideMany(request(130), h.deps);
		expect(sizes(h.calls)).toEqual([64, 64, 2]);
		expect(h.calls.map((call) => call.url)).toEqual([
			LAYA_BATCH_URL,
			LAYA_BATCH_URL,
			LAYA_BATCH_URL,
		]);
		expect(out).toHaveLength(130);
	});

	test("every decision lines up with the state it judges, in input order", async () => {
		const h = makeHarness({ env: ON_LAYA, responses: [batchAnswer(3)] });
		const out = await decideMany(request(3), h.deps);
		const kept = h.records.map((record) => record.stateHash);
		expect(kept).toHaveLength(3);
		expect(new Set(kept).size).toBe(3);
		expect(out.every((decision) => decision.outcome === "decided")).toBe(true);
	});

	test("the batch address follows the endpoint override", async () => {
		const h = makeHarness({
			env: { ...ON_LAYA, LAYA_URL: "http://laya.test/v1/systemone" },
			responses: [batchAnswer(1)],
		});
		await decideMany(request(1), h.deps);
		expect(h.calls.map((call) => call.url)).toEqual(["http://laya.test/v1/systemone/batch"]);
	});

	test("no states is no requests", async () => {
		const h = makeHarness({ env: ON_LAYA, responses: [] });
		expect(await decideMany(request(0), h.deps)).toEqual([]);
		expect(h.calls).toHaveLength(0);
	});
});

describe("decideMany — alignment and isolation", () => {
	test("a short answer fails its chunk instead of shifting every later decision", async () => {
		const h = makeHarness({ env: ON_LAYA, responses: [batchAnswer(5)] });
		const out = await decideMany(request(10), h.deps);
		expect(out).toHaveLength(10);
		expect(out.every((decision) => decision.outcome === "unavailable")).toBe(true);
	});

	test("a result missing a requested answer fails that state alone", async () => {
		const h = makeHarness({
			env: ON_LAYA,
			responses: [
				jsonResponse(200, {
					results: [
						{ model: "m", answers: { ok: { type: "noul", noul: 0.9 } } },
						{ model: "m", answers: {} },
					],
				}),
			],
		});
		const out = await decideMany(request(2), h.deps);
		expect(out[0]?.outcome).toBe("decided");
		expect(out[1]?.outcome).toBe("unavailable");
		expect(decidedOutcomeReason(out[1])).toContain("missing the");
	});

	test("one failed chunk does not take the other chunks down", async () => {
		const h = makeHarness({
			env: ON_LAYA,
			responses: [batchAnswer(64), jsonResponse(503, { error: "lane busy" }), batchAnswer(2)],
		});
		const out = await decideMany(request(130), h.deps);
		expect(out).toHaveLength(130);
		expect(out.slice(0, 64).every((decision) => decision.outcome === "decided")).toBe(true);
		expect(out.slice(64, 128).every((decision) => decision.outcome === "unavailable")).toBe(true);
		expect(out.slice(128).every((decision) => decision.outcome === "decided")).toBe(true);
	});

	test("a truncated state is refused alone, and its neighbours still decide", async () => {
		const h = makeHarness({
			env: ON_LAYA,
			responses: [
				jsonResponse(200, {
					results: [
						{
							answers: { ok: { type: "noul", noul: 0.95, confidence: 0.9 } },
							usage: { truncated: false },
						},
						{
							answers: { ok: { type: "noul", noul: 0.95, confidence: 0.9 } },
							usage: { truncated: true, state_tokens_dropped: 300 },
						},
					],
				}),
			],
		});
		const out = await decideMany(request(2), h.deps);
		expect(out[0]?.outcome).toBe("decided");
		expect(out[1]?.outcome).toBe("unavailable");
		expect(decidedOutcomeReason(out[1])).toContain("truncated");
	});

	test("a provider without a batch route is reported, never attempted", async () => {
		const h = makeHarness({ responses: [batchAnswer(2)] });
		const out = await decideMany(request(2), h.deps);
		expect(h.calls).toHaveLength(0);
		expect(out.every((decision) => decision.outcome === "unavailable")).toBe(true);
		expect(decidedOutcomeReason(out[0])).toContain("no batch route");
	});
});

function decidedOutcomeReason(decision: Decision | undefined): string {
	if (decision === undefined || decision.outcome === "decided") return "";
	return decision.reason;
}

describe("screen — keep only what the engine acted on", () => {
	test("returns the act states with their input indices", async () => {
		const h = makeHarness({
			env: ON_LAYA,
			responses: [
				jsonResponse(200, {
					results: [
						{ answers: { ok: { type: "noul", noul: 0.95, confidence: 0.9 } } },
						{ answers: { ok: { type: "noul", noul: 0.5, confidence: 0.9 } } },
						{ answers: { ok: { type: "noul", noul: 0.02, confidence: 0.9 } } },
					],
				}),
			],
		});
		const kept = await screen(request(3), h.deps);
		expect(kept.map((entry) => entry.index)).toEqual([0]);
		expect(kept[0]?.decision.outcome === "decided" && kept[0].decision.band).toBe("act");
	});
});

describe("parseBatchResponse", () => {
	test("reads a full answer set", () => {
		const parsed = parseBatchResponse(
			{ results: [{ answers: { ok: { noul: 0.8, confidence: 0.7 } } }] },
			1,
			QUESTIONS,
		);
		expect(parsed.ok).toBe(true);
		if (parsed.ok)
			expect(parsed.entries[0]).toEqual({
				ok: true,
				answers: { ok: { noul: 0.8, confidence: 0.7 } },
			});
	});

	test("refuses a state the lane truncated", () => {
		const parsed = parseBatchResponse(
			{
				results: [
					{ answers: { ok: { noul: 0.9 } }, usage: { truncated: true, state_tokens_dropped: 300 } },
				],
			},
			1,
			QUESTIONS,
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const entry = parsed.entries[0];
		expect(entry?.ok).toBe(false);
		if (entry !== undefined && !entry.ok) expect(entry.reason).toContain("truncated");
	});

	test("refuses a body with no results array", () => {
		const parsed = parseBatchResponse({ answers: {} }, 1, QUESTIONS);
		expect(parsed.ok).toBe(false);
	});
});

describe("the batch route is derived, not a second knob", () => {
	test("the laya provider advertises it and the default endpoint is the relay", () => {
		const resolved = resolveProvider({ JEV_PROVIDER: "laya" });
		expect(resolved.ok).toBe(true);
		if (resolved.ok) {
			expect(resolved.provider.url).toBe("http://172.17.0.1:18091/v1/systemone");
			expect(resolved.provider.batchUrl).toBe(LAYA_BATCH_URL);
		}
	});

	test("a hosted route that serves no batch endpoint reports none", () => {
		const resolved = resolveProvider({ TYPESAFE_API_KEY: "k" });
		expect(resolved.ok).toBe(true);
		if (resolved.ok) expect(resolved.provider.batchUrl).toBeUndefined();
	});
});

describe("the batch request names its checkpoint", () => {
	// An unnamed request is auto-routed by the lane, per request, so it does not
	// reliably reach the checkpoint the run was configured for. Omitting `model`
	// here is therefore a wrong decision, not a neutral one.
	test("sends the checkpoint the provider resolved", async () => {
		const h = makeHarness({ env: ON_LAYA, responses: [batchAnswer(2)] });
		await decideMany(request(2), h.deps);
		const [call] = h.calls;
		const body = JSON.parse(call?.body ?? "{}") as { model?: string };
		expect(body.model).toBe("typed-decisions");
	});

	test("sends an override, so a measurement says what it measured", async () => {
		const h = makeHarness({
			env: { ...ON_LAYA, JEV_MODEL: "multilingual" },
			responses: [batchAnswer(1)],
		});
		await decideMany(request(1), h.deps);
		const [call] = h.calls;
		expect((JSON.parse(call?.body ?? "{}") as { model?: string }).model).toBe("multilingual");
	});
});
