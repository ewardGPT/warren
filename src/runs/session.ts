import type { EventRow } from "../db/schema.ts";

/** Normalized event classes used when reconstructing a session. */
export type SessionEventClass = "thought" | "tool_call" | "observation" | "assistant" | "system";

export interface SessionEvent {
	readonly seq: number;
	readonly ts: string;
	readonly class: SessionEventClass;
	readonly kind: string;
	readonly payload: unknown;
}

export interface SessionSnapshot {
	readonly sessionId: string;
	readonly lastSeq: number;
	readonly events: readonly SessionEvent[];
	readonly assistantOutput: string;
}

/**
 * Reconstitute a session from Warren's append-only event log.
 *
 * The run id is the v1 session id. This projection deliberately does not
 * infer mutable lifecycle state or replay tools; it gives a wake caller the
 * ordered brain/hands history needed to resume safely after a process restart.
 */
export function wakeSession(
	sessionId: string,
	rows: readonly Pick<EventRow, "burrowEventSeq" | "ts" | "kind" | "stream" | "payloadJson">[],
	options: { readonly sinceSeq?: number } = {},
): SessionSnapshot {
	const sinceSeq = options.sinceSeq ?? 0;
	const events: SessionEvent[] = [];
	let assistantOutput = "";
	for (const row of rows) {
		if (row.burrowEventSeq <= sinceSeq) continue;
		const eventClass = classifyEvent(row.kind, row.stream);
		events.push({
			seq: row.burrowEventSeq,
			ts: row.ts,
			class: eventClass,
			kind: row.kind,
			payload: row.payloadJson,
		});
		if (eventClass === "assistant") {
			const text = extractText(row.payloadJson);
			if (text !== null) assistantOutput += text;
		}
	}
	return {
		sessionId,
		lastSeq: events.at(-1)?.seq ?? sinceSeq,
		events,
		assistantOutput,
	};
}

function classifyEvent(kind: string, stream: string | null): SessionEventClass {
	if (kind === "thinking") return "thought";
	if (kind === "tool_use") return "tool_call";
	if (kind === "tool_result") return "observation";
	if (kind === "text" && stream === "stdout") return "assistant";
	if (kind === "state_change" || stream === "system") return "system";
	return "observation";
}

function extractText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return null;
	const text = (value as Record<string, unknown>).text;
	return typeof text === "string" ? text : null;
}
