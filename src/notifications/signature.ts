import { createHmac, timingSafeEqual } from "node:crypto";

/** Canonical terminal notification payload before signing. */
export interface TerminalNotificationEnvelope {
	readonly event: "warren.run.terminal";
	readonly eventId: string;
	readonly occurredAt: string;
	readonly runId: string;
	readonly projectId: string | null;
	readonly seedId: string | null;
	readonly plotId: string | null;
	readonly state: "succeeded" | "failed" | "cancelled" | "timed_out";
	readonly prUrl: string | null;
	readonly costUsd: number | null;
	readonly durationMs: number | null;
	readonly failureReason: string | null;
	readonly uiUrl: string | null;
}

export interface SignedNotification {
	readonly body: string;
	readonly signature: string;
	readonly timestamp: string;
	readonly eventId: string;
}

/** Serialize with stable key order so retries produce the same signature. */
export function canonicalNotificationBody(event: TerminalNotificationEnvelope): string {
	return JSON.stringify({
		event: event.event,
		event_id: event.eventId,
		occurred_at: event.occurredAt,
		run_id: event.runId,
		project_id: event.projectId,
		seed_id: event.seedId,
		plot_id: event.plotId,
		state: event.state,
		pr_url: event.prUrl,
		cost_usd: event.costUsd,
		duration_ms: event.durationMs,
		failure_reason: event.failureReason,
		ui_url: event.uiUrl,
	});
}

/** HMAC-SHA256 over `<unix timestamp>.<body>` encoded as lowercase hex. */
export function signNotification(body: string, secret: string, timestamp: string): string {
	if (secret.length === 0) throw new Error("notification secret must not be empty");
	if (!/^\d+$/.test(timestamp)) throw new Error("notification timestamp must be unix seconds");
	return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

export function buildSignedNotification(
	event: TerminalNotificationEnvelope,
	secret: string,
	timestamp: string,
): SignedNotification {
	const body = canonicalNotificationBody(event);
	return {
		body,
		signature: signNotification(body, secret, timestamp),
		timestamp,
		eventId: event.eventId,
	};
}

/** Verify a signed request and reject stale timestamps to limit replay windows. */
export function verifyNotificationSignature(
	body: string,
	signature: string,
	secret: string,
	timestamp: string,
	nowSeconds: number,
	maxAgeSeconds = 300,
): boolean {
	if (!/^\d+$/.test(timestamp) || maxAgeSeconds < 0) return false;
	const age = Math.abs(nowSeconds - Number(timestamp));
	if (!Number.isSafeInteger(Number(timestamp)) || age > maxAgeSeconds) return false;
	const expected = signNotification(body, secret, timestamp);
	const actualBytes = Buffer.from(signature, "hex");
	const expectedBytes = Buffer.from(expected, "hex");
	return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
