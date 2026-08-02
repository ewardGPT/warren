import { describe, expect, test } from "bun:test";
import {
	buildResumeFeedback,
	completionSignalFromEvents,
	lastCompletionSignal,
	outputObject,
	parseStructuredOutput,
	scanCompletionSignals,
} from "./completion-signal.ts";

describe("completion signals", () => {
	test("scans XML-tagged structured output and uses the last signal", () => {
		const text = [
			"working",
			`<warren:complete>${JSON.stringify(outputObject("draft", 1, { ok: false }))}</warren:complete>`,
			"corrected",
			`<warren:complete>${JSON.stringify(outputObject("final", 1, { ok: true }))}</warren:complete>`,
		].join("\n");
		expect(scanCompletionSignals(text)).toHaveLength(2);
		expect(lastCompletionSignal(text)).toEqual({ tag: "final", schema: 1, output: { ok: true } });
	});

	test("ignores malformed signals and validates object shape", () => {
		expect(lastCompletionSignal("<warren:complete>{bad}</warren:complete>")).toBeNull();
		expect(parseStructuredOutput({ tag: "x", schema: 0, output: true })).toBeNull();
		expect(parseStructuredOutput({ tag: "x", schema: 1, output: true })).toEqual({
			tag: "x",
			schema: 1,
			output: true,
		});
		expect(() => outputObject("", 1, null)).toThrow("tag");
	});

	test("recovers the last signal from persisted stdout events", () => {
		const events = [
			{ kind: "text", stream: "system", payload: { text: "ignored" } },
			{
				kind: "text",
				stream: "stdout",
				payload: {
					text: `<warren:complete>${JSON.stringify(outputObject("final", 2, { ok: true }))}</warren:complete>`,
				},
			},
		];
		const signal = completionSignalFromEvents(events);
		expect(signal).toEqual({ tag: "final", schema: 2, output: { ok: true } });
		expect(buildResumeFeedback(signal, "crashed", "boom")).toContain("Last completion tag: final");
	});
});
