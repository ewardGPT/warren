import { describe, expect, test } from "bun:test";
import { tokenUsageDelta } from "./token-budget.ts";

const event = (payload: unknown) => ({ kind: "state_change", stream: "system", payload }) as never;

describe("tokenUsageDelta", () => {
	test("extracts turn usage and tool identity", () => {
		expect(
			tokenUsageDelta(
				event({
					type: "turn_end",
					tool_name: "bash",
					message: { usage: { input: 12, output: 8 } },
				}),
			),
		).toEqual({ input: 12, output: 8, tool: "bash" });
	});

	test("extracts result usage and failure", () => {
		expect(
			tokenUsageDelta(
				event({ type: "result", is_error: true, usage: { input_tokens: 20, output_tokens: 5 } }),
			),
		).toEqual({ input: 20, output: 5, successful: false });
	});

	test("ignores malformed and non-system events", () => {
		expect(tokenUsageDelta({ kind: "text", stream: "stdout", payload: {} } as never)).toBeNull();
		expect(
			tokenUsageDelta(event({ type: "turn_end", message: { usage: { input: "bad" } } })),
		).toEqual({ input: 0, output: 0 });
		expect(tokenUsageDelta(event(null))).toBeNull();
	});
});
