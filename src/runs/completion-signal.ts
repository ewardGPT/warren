/** Structured completion protocol for loop-engineering agents. */

export interface CompletionSignal<T = unknown> {
	readonly tag: string;
	readonly schema: number;
	readonly output: T;
}

export interface CompletionSignalEvent {
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

const SIGNAL_PATTERN = /<warren:complete>([\s\S]*?)<\/warren:complete>/g;

/** Parse every valid signal; callers can select the last one for retries. */
export function scanCompletionSignals(text: string): readonly CompletionSignal[] {
	const signals: CompletionSignal[] = [];
	for (const match of text.matchAll(SIGNAL_PATTERN)) {
		const body = match[1];
		if (body === undefined) continue;
		let value: unknown;
		try {
			value = JSON.parse(body);
		} catch {
			continue;
		}
		const parsed = parseStructuredOutput(value);
		if (parsed !== null) signals.push(parsed);
	}
	return signals;
}

/** Last-match-wins makes a later corrective signal authoritative. */
export function lastCompletionSignal(text: string): CompletionSignal | null {
	const signals = scanCompletionSignals(text);
	return signals.length === 0 ? null : (signals[signals.length - 1] ?? null);
}

/** Recover the signal from persisted bridge events, including after restart. */
export function completionSignalFromEvents(
	events: readonly CompletionSignalEvent[],
): CompletionSignal | null {
	const text = events
		.filter((event) => event.kind === "text" && event.stream === "stdout")
		.map((event) => {
			if (event.payload === null || typeof event.payload !== "object") return "";
			const value = (event.payload as Record<string, unknown>).text;
			return typeof value === "string" ? value : "";
		})
		.join("");
	return lastCompletionSignal(text);
}

/** Feedback for a caller that wants to re-run a failed attempt. */
export function buildResumeFeedback(
	signal: CompletionSignal | null,
	failureReason: string,
	providerError: string | null,
): string {
	const lines = [
		"The previous Warren attempt failed.",
		`failure_reason: ${failureReason}`,
		providerError === null ? null : `provider_error: ${providerError}`,
		signal === null
			? "No structured completion output was produced."
			: `Last completion tag: ${signal.tag} (schema ${signal.schema}).`,
		"Review the previous events and correct the failure before continuing.",
	];
	return lines.filter((line): line is string => line !== null).join("\n");
}

export function parseStructuredOutput(value: unknown): CompletionSignal | null {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.tag !== "string" || record.tag.length === 0) return null;
	if (!Number.isSafeInteger(record.schema) || (record.schema as number) < 1) return null;
	return {
		tag: record.tag,
		schema: record.schema as number,
		output: record.output,
	};
}

export function outputObject<T>(tag: string, schema: number, output: T): CompletionSignal<T> {
	if (tag.length === 0) throw new Error("completion tag must be non-empty");
	if (!Number.isSafeInteger(schema) || schema < 1) {
		throw new Error("completion schema must be a positive safe integer");
	}
	return { tag, schema, output };
}
