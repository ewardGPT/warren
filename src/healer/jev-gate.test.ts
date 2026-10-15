import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision } from "../decide/index.ts";
import {
	buildHealTriageEvidence,
	HEAL_GATE_ENV,
	type HealTriageEvidence,
	healGateEnabled,
	judgeHealFromEnv,
	judgeHealTriage,
	triageVerdict,
} from "./jev-gate.ts";

const decided = (noul: number): Decision => ({
	outcome: "decided",
	answers: { spend_run: { noul } },
	band: noul >= 0.9 ? "act" : noul <= 0.1 ? "hold" : "ask",
	provider: "stub",
	model: "jev-stub",
	ms: 3,
	via: "stub",
});

const EVIDENCE: HealTriageEvidence = {
	projectId: "p-1",
	fingerprint: "issue-99",
	source: "sentry",
	title: "TypeError in finalize",
	culprit: "src/runs/reap.ts",
	detail: "cannot read property 'id' of undefined",
	linkCount: 1,
	attempts: 0,
	maxRetries: 3,
	cooldownMinutes: 30,
	role: "healer",
};

describe("healGateEnabled", () => {
	test("off unless asked", () => {
		expect(healGateEnabled({})).toBe(false);
		expect(healGateEnabled({ [HEAL_GATE_ENV]: "0" })).toBe(false);
		expect(healGateEnabled({ [HEAL_GATE_ENV]: "no" })).toBe(false);
	});

	test("truthy values turn it on", () => {
		expect(healGateEnabled({ [HEAL_GATE_ENV]: "1" })).toBe(true);
		expect(healGateEnabled({ [HEAL_GATE_ENV]: "TRUE" })).toBe(true);
	});
});

describe("triageVerdict", () => {
	test("a confident answer dispatches", () => {
		expect(triageVerdict(decided(0.96))).toEqual({ kind: "dispatch" });
	});

	test("hold vetoes the run and names the band", () => {
		const verdict = triageVerdict(decided(0.02));
		expect(verdict.kind).toBe("skip");
		expect(verdict.kind === "skip" ? verdict.reason : "").toContain("jevs_hold");
	});

	test("ask leaves the rails' decision standing", () => {
		expect(triageVerdict(decided(0.71))).toEqual({ kind: "dispatch" });
	});

	test("an engine that could not answer changes nothing", () => {
		expect(triageVerdict({ outcome: "unavailable", reason: "no key" })).toEqual({
			kind: "dispatch",
		});
		expect(triageVerdict({ outcome: "unsure", reason: "unreadable answer" })).toEqual({
			kind: "dispatch",
		});
		expect(triageVerdict({ outcome: "over-budget", reason: "daily cap" })).toEqual({
			kind: "dispatch",
		});
	});
});

describe("buildHealTriageEvidence", () => {
	test("clips a long body and keeps the rest", () => {
		const evidence = buildHealTriageEvidence({
			...EVIDENCE,
			title: "t".repeat(500),
			detail: "d".repeat(500),
			culprit: "   ",
		});
		expect(evidence.detail?.length).toBe(401);
		expect(evidence.detail?.endsWith("…")).toBe(true);
		expect(evidence.title.length).toBe(201);
		expect(evidence.culprit).toBeNull();
	});

	test("an absent body stays null", () => {
		const evidence = buildHealTriageEvidence({ ...EVIDENCE, detail: null });
		expect(evidence.detail).toBeNull();
	});
});

describe("judgeHealTriage (offline provider)", () => {
	const dirs: string[] = [];

	async function envWith(noul: number): Promise<Record<string, string>> {
		const dir = await mkdtemp(join(tmpdir(), "jev-heal-"));
		dirs.push(dir);
		const path = join(dir, "fixture.json");
		await writeFile(
			path,
			JSON.stringify({ model: "fake", defaults: { noul: { noul } }, usage: {} }),
		);
		return {
			WARREN_JEV_STUB: "1",
			WARREN_JEV_STUB_FIXTURE: path,
			// Keep the written decision record out of the operator's real log.
			WARREN_DECISION_LOG: join(dir, "decisions.jsonl"),
		};
	}

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	test("a confident answer dispatches", async () => {
		expect(await judgeHealTriage(EVIDENCE, { env: await envWith(0.97) })).toEqual({
			kind: "dispatch",
		});
	});

	test("a low answer vetoes the run", async () => {
		const verdict = await judgeHealTriage(EVIDENCE, { env: await envWith(0.01) });
		expect(verdict.kind).toBe("skip");
		expect(verdict.kind === "skip" ? verdict.reason : "").toContain("jevs_hold");
	});
});

describe("judgeHealFromEnv", () => {
	const dirs: string[] = [];

	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	test("no gate when the switch is unset", () => {
		expect(judgeHealFromEnv({})).toBeUndefined();
	});

	test("a judge when the switch is on", async () => {
		const dir = await mkdtemp(join(tmpdir(), "jev-heal-env-"));
		dirs.push(dir);
		const judge = judgeHealFromEnv({
			[HEAL_GATE_ENV]: "1",
			WARREN_JEV_STUB: "1",
			WARREN_DECISION_LOG: join(dir, "decisions.jsonl"),
		});
		expect(judge).toBeDefined();
		// The shipped fixture answers 0.81 — `ask`, which leaves the rails'
		// decision standing, and only `hold` would veto it.
		expect(await judge?.(EVIDENCE)).toEqual({ kind: "dispatch" });
	});
});
