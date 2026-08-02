import { describe, expect, test } from "bun:test";
import { wakeSession } from "./session.ts";

describe("wakeSession", () => {
	test("reconstitutes ordered brain/hands events and assistant output", () => {
		const snapshot = wakeSession("run_session", [
			{
				burrowEventSeq: 1,
				ts: "2026-08-02T00:00:00Z",
				kind: "thinking",
				stream: "stdout",
				payloadJson: { text: "plan" },
			},
			{
				burrowEventSeq: 2,
				ts: "2026-08-02T00:00:01Z",
				kind: "tool_use",
				stream: "system",
				payloadJson: { name: "git" },
			},
			{
				burrowEventSeq: 3,
				ts: "2026-08-02T00:00:02Z",
				kind: "tool_result",
				stream: "stdout",
				payloadJson: { output: "ok" },
			},
			{
				burrowEventSeq: 4,
				ts: "2026-08-02T00:00:03Z",
				kind: "text",
				stream: "stdout",
				payloadJson: { text: "done" },
			},
		]);
		expect(snapshot.sessionId).toBe("run_session");
		expect(snapshot.lastSeq).toBe(4);
		expect(snapshot.events.map((event) => event.class)).toEqual([
			"thought",
			"tool_call",
			"observation",
			"assistant",
		]);
		expect(snapshot.assistantOutput).toBe("done");
	});

	test("supports incremental wake from a sequence boundary", () => {
		const snapshot = wakeSession(
			"run_session",
			[
				{
					burrowEventSeq: 1,
					ts: "a",
					kind: "text",
					stream: "stdout",
					payloadJson: { text: "old" },
				},
				{
					burrowEventSeq: 2,
					ts: "b",
					kind: "text",
					stream: "stdout",
					payloadJson: { text: "new" },
				},
			],
			{ sinceSeq: 1 },
		);
		expect(snapshot.lastSeq).toBe(2);
		expect(snapshot.assistantOutput).toBe("new");
	});
});
