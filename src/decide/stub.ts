/**
 * `src/decide/stub.ts` — the offline provider.
 *
 * `WARREN_JEV_STUB=1` (or `JEV_PROVIDER=stub`) answers every question from a
 * fixture instead of the network, so a test or a CI run exercises the whole
 * decision path with no key and no cost. The shipped fixture mirrors a recorded
 * live 200 body, so a stubbed decision and a live one stay comparable.
 */

import { fileURLToPath } from "node:url";
import type { DecideDeps, DecideRequest } from "./client.ts";
import { errorText, settled, unavailable } from "./internal.ts";
import { envString, isFiniteNumber, isRecord, readAnswer, readUsage } from "./provider.ts";
import type { Answer, BandOptions, Decided, Decision, Question } from "./types.ts";

/** Stub fixture used when `WARREN_JEV_STUB_FIXTURE` is unset. */
export const STUB_FIXTURE_ENV = "WARREN_JEV_STUB_FIXTURE";

/** The fixture the stub provider reads when the env does not point elsewhere. */
export function defaultStubFixturePath(): string {
	return fileURLToPath(new URL("./fixtures/jev-stub.json", import.meta.url));
}

/* Stub provider                                                           */
/* ----------------------------------------------------------------------- */

interface StubFixture {
	model: string;
	defaults: Record<string, unknown>;
	answers: Record<string, unknown>;
	usage: Decided["usage"];
}

export function parseStubFixture(raw: unknown): StubFixture | null {
	if (!isRecord(raw) || !isRecord(raw.defaults)) return null;
	return {
		model: typeof raw.model === "string" ? raw.model : "jev-stub",
		defaults: raw.defaults,
		answers: isRecord(raw.answers) ? raw.answers : {},
		usage: readUsage(raw.usage),
	};
}

/**
 * Answer from the fixture: `answers[<question name>]` wins, `defaults[<type>]`
 * fills the rest. A `choice` outside the question's criteria (or an absent
 * one) falls back to the first criterion key, so a fixture never produces
 * an answer the engine would reject.
 */
export function stubAnswer(name: string, question: Question, fixture: StubFixture): Answer | null {
	const merged: Answer = {
		...readAnswer(fixture.defaults[question.type]),
		...readAnswer(fixture.answers[name]),
	};
	const confidence = isFiniteNumber(merged.confidence) ? merged.confidence : undefined;
	switch (question.type) {
		case "noul":
			return isFiniteNumber(merged.noul) ? { noul: merged.noul, confidence } : null;
		case "score":
			return isFiniteNumber(merged.score) ? { score: merged.score, confidence } : null;
		case "choice": {
			const keys = Object.keys(question.criteria);
			const chosen =
				merged.choice !== undefined && keys.includes(merged.choice) ? merged.choice : keys[0];
			return chosen === undefined ? null : { choice: chosen, confidence };
		}
	}
}

export function decideWithStub(
	req: DecideRequest,
	deps: DecideDeps,
	started: number,
	thresholds: BandOptions,
): Decision {
	const path = envString(deps.env, STUB_FIXTURE_ENV) ?? defaultStubFixturePath();
	let raw: unknown;
	try {
		raw = JSON.parse(deps.readFixture(path));
	} catch (err) {
		return unavailable(`stub fixture ${path} could not be used: ${errorText(err)}`);
	}
	const fixture = parseStubFixture(raw);
	if (fixture === null) {
		return unavailable(`stub fixture ${path} has no "defaults" object`);
	}
	const answers: Record<string, Answer> = {};
	const unanswerable: string[] = [];
	for (const [name, question] of Object.entries(req.questions)) {
		const answer = stubAnswer(name, question, fixture);
		if (answer === null) unanswerable.push(`${name} (${question.type})`);
		else answers[name] = answer;
	}
	if (unanswerable.length > 0) {
		return unavailable(`stub fixture ${path} cannot answer: ${unanswerable.join(", ")}`);
	}
	return settled({
		started,
		now: deps.now(),
		provider: "stub",
		model: fixture.model,
		via: "stub",
		usage: fixture.usage,
		answers,
		thresholds,
	});
}
