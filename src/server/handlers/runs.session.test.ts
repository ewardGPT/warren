import { describe, expect, test } from "bun:test";
import { wakeSessionHandler } from "./runs/session.ts";

function context(url: string) {
	return {
		params: { id: "run_session" },
		url: new URL(url),
	} as never;
}

function deps() {
	return {
		repos: {
			runs: { require: async () => ({ id: "run_session" }) },
			events: {
				listByRun: async () => [
					{
						burrowEventSeq: 1,
						ts: "2026-08-02T00:00:00Z",
						kind: "text",
						stream: "stdout",
						payloadJson: { text: "hello" },
					},
				],
			},
		},
	} as never;
}

describe("GET /runs/:id/session", () => {
	test("returns the event-log session projection", async () => {
		const response = await wakeSessionHandler(deps())(
			context("http://localhost/runs/run_session/session"),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			sessionId: "run_session",
			lastSeq: 1,
			assistantOutput: "hello",
		});
	});

	test("rejects malformed incremental sequence", async () => {
		await expect(
			wakeSessionHandler(deps())(context("http://localhost/runs/run_session/session?sinceSeq=-1")),
		).rejects.toThrow("sinceSeq");
	});
});
