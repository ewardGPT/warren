import { describe, expect, test } from "bun:test";
import {
	checkDailyCap,
	countLiveCalls,
	DAILY_CAP_ENV,
	DEFAULT_TIMEOUT_MS,
	dailyCap,
	featureTimeoutEnv,
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	resolveTimeoutMs,
	TIMEOUT_ENV,
	utcDay,
} from "./budget.ts";

describe("resolveTimeoutMs", () => {
	test("defaults to 4000 ms", () => {
		expect(resolveTimeoutMs({ feature: "merge-guard", env: {} })).toBe(DEFAULT_TIMEOUT_MS);
	});

	test("the request's timeoutMs wins over the global env", () => {
		expect(resolveTimeoutMs({ feature: "f", timeoutMs: 900, env: { [TIMEOUT_ENV]: "7000" } })).toBe(
			900,
		);
	});

	test("the global env applies when the request is silent", () => {
		expect(resolveTimeoutMs({ feature: "f", env: { [TIMEOUT_ENV]: "7000" } })).toBe(7000);
	});

	test("the per-feature env beats everything else", () => {
		const env = { [TIMEOUT_ENV]: "7000", [featureTimeoutEnv("merge-guard")]: "250" };
		expect(resolveTimeoutMs({ feature: "merge-guard", timeoutMs: 900, env })).toBe(250);
	});

	test("feature names are mangled into an env-safe suffix", () => {
		expect(featureTimeoutEnv("merge-guard")).toBe("WARREN_JEV_TIMEOUT_MS_MERGE_GUARD");
		expect(featureTimeoutEnv("Preview Launch")).toBe("WARREN_JEV_TIMEOUT_MS_PREVIEW_LAUNCH");
		expect(featureTimeoutEnv("a/b.c")).toBe("WARREN_JEV_TIMEOUT_MS_A_B_C");
	});

	test("nonsense timeouts fall back rather than deciding for the caller", () => {
		expect(resolveTimeoutMs({ feature: "f", timeoutMs: 0, env: {} })).toBe(DEFAULT_TIMEOUT_MS);
		expect(resolveTimeoutMs({ feature: "f", timeoutMs: -5, env: {} })).toBe(DEFAULT_TIMEOUT_MS);
		expect(resolveTimeoutMs({ feature: "f", timeoutMs: Number.NaN, env: {} })).toBe(
			DEFAULT_TIMEOUT_MS,
		);
		expect(resolveTimeoutMs({ feature: "f", env: { [TIMEOUT_ENV]: "soon" } })).toBe(
			DEFAULT_TIMEOUT_MS,
		);
	});

	test("the result is clamped", () => {
		expect(resolveTimeoutMs({ feature: "f", timeoutMs: 1, env: {} })).toBe(MIN_TIMEOUT_MS);
		expect(resolveTimeoutMs({ feature: "f", timeoutMs: 10 ** 9, env: {} })).toBe(MAX_TIMEOUT_MS);
	});
});

describe("dailyCap", () => {
	test("is off unless a positive integer is configured", () => {
		expect(dailyCap({})).toBeNull();
		expect(dailyCap({ [DAILY_CAP_ENV]: "0" })).toBeNull();
		expect(dailyCap({ [DAILY_CAP_ENV]: "-3" })).toBeNull();
		expect(dailyCap({ [DAILY_CAP_ENV]: "1.5" })).toBeNull();
		expect(dailyCap({ [DAILY_CAP_ENV]: "many" })).toBeNull();
		expect(dailyCap({ [DAILY_CAP_ENV]: "25" })).toBe(25);
	});
});

describe("countLiveCalls", () => {
	const day = "2026-10-15";
	const lines = [
		JSON.stringify({ ts: "2026-10-15T09:00:00.000Z", feature: "merge-guard", via: "live" }),
		JSON.stringify({ ts: "2026-10-15T23:59:59.000Z", feature: "merge-guard", via: "live" }),
		JSON.stringify({ ts: "2026-10-15T10:00:00.000Z", feature: "merge-guard", via: "stub" }),
		JSON.stringify({ ts: "2026-10-15T10:00:00.000Z", feature: "merge-guard", via: "cache" }),
		JSON.stringify({ ts: "2026-10-15T10:00:00.000Z", feature: "other", via: "live" }),
		JSON.stringify({ ts: "2026-10-14T10:00:00.000Z", feature: "merge-guard", via: "live" }),
		"{ not json",
		"",
		'"a string"',
	].join("\n");

	test("counts only today's live calls for this feature", () => {
		expect(countLiveCalls(lines, "merge-guard", day)).toBe(2);
		expect(countLiveCalls(lines, "other", day)).toBe(1);
		expect(countLiveCalls(lines, "absent", day)).toBe(0);
	});

	test("an empty log counts zero", () => {
		expect(countLiveCalls("", "merge-guard", day)).toBe(0);
	});

	test("utcDay is the UTC date", () => {
		expect(utcDay(Date.parse("2026-10-15T23:59:59.000Z"))).toBe("2026-10-15");
		expect(utcDay(Date.parse("2026-10-16T00:00:00.000Z"))).toBe("2026-10-16");
	});
});

describe("checkDailyCap", () => {
	const now = Date.parse("2026-10-15T12:00:00.000Z");
	const record = JSON.stringify({ ts: "2026-10-15T11:00:00.000Z", feature: "f", via: "live" });

	test("no cap configured always allows", () => {
		const result = checkDailyCap({ feature: "f", env: {}, logText: record, now });
		expect(result.ok).toBe(true);
	});

	test("allows while under the cap and refuses at it", () => {
		const env = { [DAILY_CAP_ENV]: "2" };
		expect(checkDailyCap({ feature: "f", env, logText: record, now }).ok).toBe(true);
		const spent = checkDailyCap({
			feature: "f",
			env: { [DAILY_CAP_ENV]: "1" },
			logText: record,
			now,
		});
		expect(spent.ok).toBe(false);
		expect(spent.ok ? "" : spent.reason).toContain("1/1 live calls on 2026-10-15");
	});
});
