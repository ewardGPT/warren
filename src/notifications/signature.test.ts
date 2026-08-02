import { describe, expect, test } from "bun:test";
import {
	buildSignedNotification,
	canonicalNotificationBody,
	verifyNotificationSignature,
} from "./signature.ts";

const event = {
	event: "warren.run.terminal" as const,
	eventId: "evt_1",
	occurredAt: "2026-08-02T00:00:00.000Z",
	runId: "run_1",
	projectId: null,
	seedId: "warren-ee6f",
	plotId: null,
	state: "succeeded" as const,
	prUrl: null,
	costUsd: 0.42,
	durationMs: 123,
	failureReason: null,
	uiUrl: null,
};

describe("terminal notification signatures", () => {
	test("canonicalizes and verifies a signed envelope", () => {
		const signed = buildSignedNotification(event, "secret", "1785628800");
		expect(signed.body).toBe(canonicalNotificationBody(event));
		expect(
			verifyNotificationSignature(
				signed.body,
				signed.signature,
				"secret",
				signed.timestamp,
				1785628801,
			),
		).toBe(true);
	});

	test("rejects tampering, wrong secrets, and stale requests", () => {
		const signed = buildSignedNotification(event, "secret", "1785628800");
		expect(
			verifyNotificationSignature(
				`${signed.body}x`,
				signed.signature,
				"secret",
				signed.timestamp,
				1785628801,
			),
		).toBe(false);
		expect(
			verifyNotificationSignature(
				signed.body,
				signed.signature,
				"wrong",
				signed.timestamp,
				1785628801,
			),
		).toBe(false);
		expect(
			verifyNotificationSignature(
				signed.body,
				signed.signature,
				"secret",
				signed.timestamp,
				1785629200,
			),
		).toBe(false);
	});
});
