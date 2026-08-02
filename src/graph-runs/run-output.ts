/**
 * Extract agent output text from Warren run event payloads (Sapling / burrow).
 */

import type { EventRow } from "../db/schema.ts";

const TEXT_KEYS = ["response", "text", "content", "output", "message"] as const;

/** Pull human-readable agent text from a single event payload. */
export function extractRunOutputText(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	for (const key of TEXT_KEYS) {
		const candidate = record[key];
		if (typeof candidate === "string" && candidate.trim() !== "") {
			return candidate;
		}
	}
	const data = record.data;
	if (typeof data === "object" && data !== null && !Array.isArray(data)) {
		for (const key of TEXT_KEYS) {
			const candidate = (data as Record<string, unknown>)[key];
			if (typeof candidate === "string" && candidate.trim() !== "") {
				return candidate;
			}
		}
	}
	return null;
}

/** Concatenate tail events into a single output blob for finding parsing. */
export function readRunOutputFromEvents(rows: readonly Pick<EventRow, "payloadJson">[]): string {
	return rows
		.map((row) => extractRunOutputText(row.payloadJson))
		.filter((text): text is string => text !== null)
		.join("\n")
		.slice(-12_000);
}
