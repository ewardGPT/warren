import type { RunFailureReason, RunRow, RunTerminalState } from "../db/schema.ts";
import { loadNotificationEndpoints } from "./config.ts";
import type { TerminalNotificationEnvelope } from "./signature.ts";
import { buildSignedNotification } from "./signature.ts";

export function buildTerminalNotification(
	run: Pick<RunRow, "id" | "projectId" | "seedId" | "prUrl" | "costUsd" | "startedAt" | "endedAt">,
	state: RunTerminalState,
	failureReason: RunFailureReason | null,
): TerminalNotificationEnvelope {
	const occurredAt = run.endedAt ?? new Date().toISOString();
	const started = run.startedAt === null ? null : Date.parse(run.startedAt);
	const ended = Date.parse(occurredAt);
	return {
		event: "warren.run.terminal",
		eventId: `run_terminal_${run.id}_${state}`,
		occurredAt,
		runId: run.id,
		projectId: run.projectId,
		seedId: run.seedId,
		state,
		plotId: null,
		prUrl: run.prUrl,
		costUsd: run.costUsd,
		durationMs: started !== null && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
		failureReason,
		uiUrl: null,
	};
}

export interface NotificationEndpoint {
	readonly id: string;
	readonly url: string;
	readonly secret: string;
	readonly enabled: boolean;
}

export interface NotificationAttempt {
	readonly eventId: string;
	readonly runId: string;
	readonly endpointId: string;
	readonly attempt: number;
	readonly status: "delivered" | "retrying" | "dead_letter";
	readonly responseStatus: number | null;
	readonly error: string | null;
	readonly attemptedAt: string;
	readonly nextAttemptAt: string | null;
}

export interface NotificationStore {
	/** Must be idempotent on eventId and complete before the first POST. */
	readonly persistEvent: (event: TerminalNotificationEnvelope) => Promise<boolean>;
	readonly persistAttempt: (attempt: NotificationAttempt) => Promise<void>;
}

export interface NotificationEventLog {
	readonly maxSeqForRun: (runId: string) => Promise<number | null>;
	readonly listByRun: (runId: string) => Promise<readonly { kind: string; payloadJson: unknown }[]>;
	readonly append: (input: {
		runId: string;
		burrowEventSeq: number;
		ts: string;
		kind: string;
		stream: "system";
		payload: unknown;
	}) => Promise<unknown>;
}

/** Durable store backed by Warren's append-only run event log. */
export function createEventLogNotificationStore(events: NotificationEventLog): NotificationStore {
	const append = async (runId: string, kind: string, payload: unknown): Promise<void> => {
		const next = ((await events.maxSeqForRun(runId)) ?? 0) + 1;
		await events.append({
			runId,
			burrowEventSeq: next,
			ts: new Date().toISOString(),
			kind,
			stream: "system",
			payload,
		});
	};
	return {
		persistEvent: async (event) => {
			const rows = await events.listByRun(event.runId);
			const exists = rows.some((row) => {
				if (row.kind !== "notification.event" || row.payloadJson === null) return false;
				const payload = row.payloadJson as { eventId?: unknown };
				return payload.eventId === event.eventId;
			});
			if (exists) return false;
			await append(event.runId, "notification.event", event);
			return true;
		},
		persistAttempt: async (attempt) => {
			await append(attempt.runId, "notification.attempt", attempt);
		},
	};
}

export interface NotificationTransportRequest {
	readonly url: string;
	readonly body: string;
	readonly headers: Readonly<Record<string, string>>;
}

export interface NotificationTransportResponse {
	readonly status: number;
}

export interface NotificationTransport {
	readonly post: (request: NotificationTransportRequest) => Promise<NotificationTransportResponse>;
}

export interface NotificationClock {
	readonly now: () => Date;
	readonly sleep: (milliseconds: number) => Promise<void>;
}

export interface DeliveryOptions {
	readonly maxAttempts?: number;
	readonly baseDelayMs?: number;
	readonly timestamp?: () => string;
}

export interface DeliveryResult {
	readonly endpointId: string;
	readonly status: "delivered" | "dead_letter" | "disabled";
	readonly attempts: number;
}

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 500;

/** Durable-before-POST, bounded webhook delivery with injectable seams. */
export class TerminalNotificationDispatcher {
	private readonly maxAttempts: number;
	private readonly baseDelayMs: number;
	private readonly timestamp: () => string;

	constructor(
		private readonly store: NotificationStore,
		private readonly transport: NotificationTransport,
		private readonly clock: NotificationClock,
		options: DeliveryOptions = {},
	) {
		this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
		this.timestamp = options.timestamp ?? (() => Math.floor(Date.now() / 1000).toString());
		if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
			throw new Error("notification maxAttempts must be a positive safe integer");
		}
		if (!Number.isFinite(this.baseDelayMs) || this.baseDelayMs < 0) {
			throw new Error("notification baseDelayMs must be non-negative");
		}
	}

	async deliver(
		event: TerminalNotificationEnvelope,
		endpoints: readonly NotificationEndpoint[],
	): Promise<readonly DeliveryResult[]> {
		const created = await this.store.persistEvent(event);
		if (!created) return [];
		const results: DeliveryResult[] = [];
		for (const endpoint of endpoints) {
			results.push(await this.deliverToEndpoint(event, endpoint));
		}
		return results;
	}

	private async deliverToEndpoint(
		event: TerminalNotificationEnvelope,
		endpoint: NotificationEndpoint,
	): Promise<DeliveryResult> {
		if (!endpoint.enabled) return { endpointId: endpoint.id, status: "disabled", attempts: 0 };
		const timestamp = this.timestamp();
		const signed = buildSignedNotification(event, endpoint.secret, timestamp);
		for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
			const attemptedAt = this.clock.now().toISOString();
			try {
				const response = await this.transport.post({
					url: endpoint.url,
					body: signed.body,
					headers: {
						"content-type": "application/json",
						"x-warren-event-id": event.eventId,
						"x-warren-timestamp": timestamp,
						"x-warren-signature": signed.signature,
					},
				});
				if (response.status >= 200 && response.status < 300) {
					await this.store.persistAttempt({
						eventId: event.eventId,
						runId: event.runId,
						endpointId: endpoint.id,
						attempt,
						status: "delivered",
						responseStatus: response.status,
						error: null,
						attemptedAt,
						nextAttemptAt: null,
					});
					return { endpointId: endpoint.id, status: "delivered", attempts: attempt };
				}
				if (response.status >= 400 && response.status < 500) {
					await this.store.persistAttempt({
						eventId: event.eventId,
						runId: event.runId,
						endpointId: endpoint.id,
						attempt,
						status: "dead_letter",
						responseStatus: response.status,
						error: `non_retryable_http_${response.status}`,
						attemptedAt,
						nextAttemptAt: null,
					});
					return { endpointId: endpoint.id, status: "dead_letter", attempts: attempt };
				}
				await this.persistRetry(event, endpoint, attempt, response.status, attemptedAt);
			} catch (error) {
				await this.persistRetry(event, endpoint, attempt, null, attemptedAt, error);
			}
			if (attempt < this.maxAttempts) {
				await this.clock.sleep(this.baseDelayMs * 2 ** (attempt - 1));
			}
		}
		return { endpointId: endpoint.id, status: "dead_letter", attempts: this.maxAttempts };
	}

	private async persistRetry(
		event: TerminalNotificationEnvelope,
		endpoint: NotificationEndpoint,
		attempt: number,
		responseStatus: number | null,
		attemptedAt: string,
		error?: unknown,
	): Promise<void> {
		const nextAttemptAt = new Date(
			this.clock.now().getTime() + this.baseDelayMs * 2 ** (attempt - 1),
		).toISOString();
		await this.store.persistAttempt({
			eventId: event.eventId,
			runId: event.runId,
			endpointId: endpoint.id,
			attempt,
			status: attempt >= this.maxAttempts ? "dead_letter" : "retrying",
			responseStatus,
			error:
				error instanceof Error ? error.message : error ? String(error) : `http_${responseStatus}`,
			attemptedAt,
			nextAttemptAt: attempt >= this.maxAttempts ? null : nextAttemptAt,
		});
	}
}

/** Build the production emitter; absent configuration disables delivery. */
export function createTerminalNotificationEmitter(
	events: NotificationEventLog,
	env: Readonly<Record<string, string | undefined>>,
	fetchImpl: typeof fetch = fetch,
): { readonly emit: (event: TerminalNotificationEnvelope) => Promise<void> } | undefined {
	const endpoints = loadNotificationEndpoints(env);
	if (endpoints.length === 0) return undefined;
	const dispatcher = new TerminalNotificationDispatcher(
		createEventLogNotificationStore(events),
		{
			post: async (request) => {
				const response = await fetchImpl(request.url, {
					method: "POST",
					headers: request.headers,
					body: request.body,
				});
				return { status: response.status };
			},
		},
		{
			now: () => new Date(),
			sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		},
	);
	return { emit: async (event) => void (await dispatcher.deliver(event, endpoints)) };
}
