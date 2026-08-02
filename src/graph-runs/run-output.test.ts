import { describe, expect, test } from "bun:test";
import { extractRunOutputText, readRunOutputFromEvents } from "./run-output.ts";

describe("extractRunOutputText", () => {
	test("reads Sapling response field", () => {
		const text = extractRunOutputText({
			success: true,
			command: "response",
			response: '```json\n[{"file":"a.ts","claim":"missing auth"}]\n```',
		});
		expect(text).toContain("missing auth");
	});

	test("reads plain text field", () => {
		expect(extractRunOutputText({ text: "hello" })).toBe("hello");
	});
});

describe("readRunOutputFromEvents", () => {
	test("joins text from multiple events", () => {
		const out = readRunOutputFromEvents([
			{ payloadJson: { message: "ignore" } },
			{ payloadJson: { response: '[{"file":"x.ts","claim":"hit"}]' } },
		]);
		expect(out).toContain("hit");
	});
});
