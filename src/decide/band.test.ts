import { describe, expect, test } from "bun:test";
import {
	bandFor,
	DEFAULT_ACT_AT,
	DEFAULT_DENY_AT,
	foldBands,
	SCORE_CRITERIA_MEDIAN,
} from "./band.ts";
import type { Band } from "./types.ts";

describe("bandFor — defaults", () => {
	test("the exported defaults are the documented 0.9 / 0.1", () => {
		expect(DEFAULT_ACT_AT).toBe(0.9);
		expect(DEFAULT_DENY_AT).toBe(0.1);
		expect(SCORE_CRITERIA_MEDIAN).toBe(2);
	});

	test("an answer that says nothing is ask", () => {
		expect(bandFor(undefined)).toBe("ask");
		expect(bandFor({})).toBe("ask");
	});
});

describe("bandFor — noul boundaries", () => {
	const cases: ReadonlyArray<[number, Band]> = [
		[1, "act"],
		[0.9, "act"],
		[0.899_999, "ask"],
		[0.5, "ask"],
		[0.100_001, "ask"],
		[0.1, "hold"],
		[0, "hold"],
	];

	for (const [noul, band] of cases) {
		test(`noul ${noul} → ${band}`, () => {
			expect(bandFor({ noul })).toBe(band);
		});
	}

	test("thresholds are configurable", () => {
		expect(bandFor({ noul: 0.75 }, { act: 0.75, deny: 0.25 })).toBe("act");
		expect(bandFor({ noul: 0.74 }, { act: 0.75, deny: 0.25 })).toBe("ask");
		expect(bandFor({ noul: 0.25 }, { act: 0.75, deny: 0.25 })).toBe("hold");
	});

	test("a non-finite noul falls through instead of banding", () => {
		expect(bandFor({ noul: Number.NaN, choice: "hold" })).toBe("hold");
		expect(bandFor({ noul: Number.POSITIVE_INFINITY })).toBe("ask");
	});
});

describe("bandFor — choice", () => {
	test("act / ask / hold criteria band directly", () => {
		expect(bandFor({ choice: "act" })).toBe("act");
		expect(bandFor({ choice: "ask" })).toBe("ask");
		expect(bandFor({ choice: "hold" })).toBe("hold");
	});

	test("criterion names are trimmed and case-folded", () => {
		expect(bandFor({ choice: " ACT " })).toBe("act");
		expect(bandFor({ choice: "Hold" })).toBe("hold");
	});

	test("an unknown criterion degrades to ask, never to act", () => {
		expect(bandFor({ choice: "defer" })).toBe("ask");
		expect(bandFor({ choice: "" })).toBe("ask");
	});

	test("choice outranks score when a noul is absent", () => {
		expect(bandFor({ choice: "hold", score: 4 })).toBe("hold");
	});
});

describe("bandFor — score (criteria legend)", () => {
	const cases: ReadonlyArray<[number, Band]> = [
		[4, "act"],
		[1.8, "act"],
		[1.799, "ask"],
		[1, "ask"],
		[0.201, "ask"],
		[0.2, "hold"],
		[0, "hold"],
	];

	for (const [score, band] of cases) {
		test(`score ${score} → ${band}`, () => {
			expect(bandFor({ score })).toBe(band);
		});
	}

	test("the act bar scales with the threshold", () => {
		expect(bandFor({ score: 1 }, { act: 0.5 })).toBe("act");
		expect(bandFor({ score: 0.999 }, { act: 0.5 })).toBe("ask");
		expect(bandFor({ score: 0.4 }, { deny: 0.2 })).toBe("hold");
	});

	test("the real 200 body's risk score (1.76 on a five-point legend) is ask", () => {
		expect(bandFor({ score: 1.76, confidence: 0.62 })).toBe("ask");
	});
});

describe("bandFor — field priority", () => {
	test("noul wins over choice and score", () => {
		expect(bandFor({ noul: 0.95, choice: "hold", score: 0 })).toBe("act");
		expect(bandFor({ noul: 0.01, choice: "act", score: 4 })).toBe("hold");
	});
});

describe("foldBands", () => {
	test("worst-first: any hold wins, then any ask, then all-act", () => {
		expect(foldBands(["act", "hold", "ask"])).toBe("hold");
		expect(foldBands(["act", "ask"])).toBe("ask");
		expect(foldBands(["act", "act"])).toBe("act");
		expect(foldBands(["hold"])).toBe("hold");
	});

	test("nothing to fold is ask", () => {
		expect(foldBands([])).toBe("ask");
	});
});
