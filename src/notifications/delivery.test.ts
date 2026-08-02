import { describe, expect, test } from "bun:test";
import { type NotificationAttempt, TerminalNotificationDispatcher } from "./delivery.ts";
import type { TerminalNotificationEnvelope } from "./signature.ts";

const event: TerminalNotificationEnvelope = {
	event: "warren.run.terminal",
	eventId: "evt_delivery",
	occurredAt: "2026-08-02T00:00:00.000Z",
	runId: "run_1",
	projectId: null,
	seedId: null,
	plotId: null,
	state: "failed",
	prUrl: null,
	costUsd: null,
	durationMs: null,
	failureReason: "crashed",
	uiUrl: null,
};

function harness(statuses: Array<number | Error>) {
	const attempts: NotificationAttempt[] = [];
	let eventPersisted = 0;
	let cursor = 0;
	const sleeps: number[] = [];
	const dispatcher = new TerminalNotificationDispatcher(
		{
			persistEvent: async () => {
				eventPersisted += 1;
				return true;
			},
			persistAttempt: async (attempt) => {
				attempts.push(attempt);
			},
		},
		{
			post: async () => {
				const status = statuses[cursor++];
				if (status === undefined) throw new Error("test transport script exhausted");
				if (status instanceof Error) throw status;
				return { status };
			},
		},
		{
			now: () => new Date("2026-08-02T00:00:00.000Z"),
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		},
		{ maxAttempts: 3, baseDelayMs: 10, timestamp: () => "1785628800" },
	);
	return {
		dispatcher,
		attempts,
		sleeps,
		get eventPersisted() {
			return eventPersisted;
		},
	};
}

describe("TerminalNotificationDispatcher", () => {
	test("persists before posting and retries transient failures", async () => {
		const h = harness([503, new Error("dns"), 204]);
		const result = await h.dispatcher.deliver(event, [
			{ id: "endpoint_1", url: "https://example.test", secret: "secret", enabled: true },
		]);
		expect(result).toEqual([{ endpointId: "endpoint_1", status: "delivered", attempts: 3 }]);
		expect(h.eventPersisted).toBe(1);
		expect(h.attempts.map((a) => a.status)).toEqual(["retrying", "retrying", "delivered"]);
		expect(h.attempts.every((a) => a.runId === event.runId)).toBe(true);
		expect(h.sleeps).toEqual([10, 20]);
	});

	test("dead-letters 4xx and exhausts retries", async () => {
		const configError = harness([401]);
		const configResult = await configError.dispatcher.deliver(event, [
			{ id: "endpoint_1", url: "https://example.test", secret: "secret", enabled: true },
		]);
		expect(configResult[0]?.status).toBe("dead_letter");
		expect(configError.attempts[0]?.attempt).toBe(1);

		const exhausted = harness([500, 502, 503]);
		const exhaustedResult = await exhausted.dispatcher.deliver(event, [
			{ id: "endpoint_1", url: "https://example.test", secret: "secret", enabled: true },
		]);
		expect(exhaustedResult[0]?.status).toBe("dead_letter");
		expect(exhausted.attempts.at(-1)?.status).toBe("dead_letter");
	});
});
