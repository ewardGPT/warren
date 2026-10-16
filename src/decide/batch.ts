/**
 * `src/decide/batch.ts` — many states, one forward pass.
 *
 * A single Laya call answers one state. The batch route answers up to
 * `MAX_BATCH_STATES` of them in one forward pass, which is where the model
 * becomes interesting: the marginal cost of a state collapses, so a caller can
 * afford to judge a whole corpus instead of a hand-picked few.
 *
 * ## The measured ceiling
 *
 * `MAX_BATCH_STATES` is 64, and the limit is the **state count**, not the body
 * size. Measured against the lane on Hopper:
 *
 *   | states | body    | result |
 *   |--------|---------|--------|
 *   | 64     | 14 kB   | 200, 161 ms |
 *   | 72     | 16 kB   | 413 Payload Too Large |
 *   | 32     | 128 kB  | 200, 475 ms |
 *
 * The third row is the point: 32 states carrying 4 kB documents each pass a
 * 128 kB body, so a caller may batch a few long documents or many short ones
 * and only the count is bounded. At 64 states per 161 ms the marginal state
 * costs about 2.5 ms, against about 40 ms for a call of its own.
 *
 * ## The window
 *
 * The served English checkpoint takes 512 tokens, and that is the limit a
 * caller meets first. An oversized state is truncated rather than refused, and
 * the lane reports the loss as `truncated` and `state_tokens_dropped`. Measured
 * with one question set: an 8-state batch of 1200-character documents carried
 * 238 tokens each and passed, while 4000-character documents reported
 * `truncated` on all eight and dropped 300 tokens from each.
 *
 * A verdict computed from a truncated state answers a question the caller did
 * not ask, so this client refuses it. The state becomes `unavailable` with a
 * reason naming the loss, which tells a caller to shorten the document rather
 * than to trust a cut-down answer.
 *
 * ## Failure contract
 *
 * `decideMany` never throws and always returns one decision per input state,
 * in input order. A chunk that fails is not retried into a wall: every state in
 * it becomes `unavailable` with the reason, and the remaining chunks still run,
 * so one bad page cannot lose the other pages. A response that answers fewer
 * states than it was asked about fails its whole chunk, because a silently
 * short answer would misalign every decision after it.
 *
 * Each state is written to the decision log as its own record, so an audit
 * reads the same way it does for single calls. The daily cap counts decisions
 * rather than requests, which is why it is checked once for the whole call.
 */

import { bandFor, foldBands } from "./band.ts";
import { checkDailyCap, resolveTimeoutMs } from "./budget.ts";
import { type DecideDeps, defaultDeps } from "./client.ts";
import { errorText, unavailable } from "./internal.ts";
import {
	buildHeaders,
	DEFAULT_TITLE,
	envString,
	extractErrorMessage,
	isRecord,
	readAnswer,
	resolveProvider,
	TITLE_ENV,
} from "./provider.ts";
import { buildRecord, decisionLogPath } from "./record.ts";
import type { Answer, Band, Decision, Question } from "./types.ts";

/**
 * States per request. The lane accepts 64 and refuses 72 with a 413, and the
 * refusal follows the count rather than the body size.
 */
export const MAX_BATCH_STATES = 64;

/** A batch request: one question set asked about many states. */
export interface DecideManyRequest {
	feature: string;
	states: readonly Record<string, unknown>[];
	questions: Record<string, Question>;
	subject?: string;
	/** Per chunk, not for the whole call: each chunk is one request. */
	timeoutMs?: number;
	actAt?: number;
	denyAt?: number;
}

/** One state's outcome: its answers, or the reason it has none. */
export type BatchEntry =
	| { ok: true; answers: Record<string, Answer> }
	| { ok: false; reason: string };

/** One chunk of the answer, or the reason the whole chunk produced none. */
type ChunkResult = { ok: true; entries: BatchEntry[] } | { ok: false; reason: string };

/** Split the states into requests the lane will accept. */
function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size)
		out.push(items.slice(index, index + size));
	return out;
}

/** The body of a batch request. The lane ignores a `model` field, so none is sent. */
export function buildBatchBody(
	states: readonly Record<string, unknown>[],
	questions: Record<string, Question>,
): string {
	return JSON.stringify({ states, questions });
}

/**
 * The reason the lane could not honour this state in full, or `undefined`.
 *
 * The served checkpoint has a 512-token window and `laya-serve` truncates an
 * oversized state instead of refusing it, reporting the loss in the per-state
 * usage. A verdict from a truncated state answers a question the caller did not
 * ask, so it is refused rather than returned.
 */
function truncationReason(value: unknown): string | undefined {
	if (!isRecord(value) || !isRecord(value.usage)) return undefined;
	const usage = value.usage;
	const dropped = typeof usage.state_tokens_dropped === "number" ? usage.state_tokens_dropped : 0;
	if (usage.truncated !== true && dropped <= 0) return undefined;
	const detail = dropped > 0 ? `, ${dropped} tokens dropped` : "";
	return `the lane truncated this state${detail}`;
}

/**
 * Read one `results` entry. A short answer and a truncated answer are both
 * failures rather than partial successes, because the caller pairs decisions
 * with states by position.
 */
export function readBatchResult(value: unknown, questions: Record<string, Question>): BatchEntry {
	if (!isRecord(value) || !isRecord(value.answers)) {
		return { ok: false, reason: "a result was not an answer object" };
	}
	const truncated = truncationReason(value);
	if (truncated !== undefined) return { ok: false, reason: truncated };
	const answers: Record<string, Answer> = {};
	for (const name of Object.keys(questions)) {
		const answer = readAnswer(value.answers[name]);
		if (answer === null) return { ok: false, reason: `a result was missing the "${name}" answer` };
		answers[name] = answer;
	}
	return { ok: true, answers };
}

/** Parse a whole batch body into one outcome per state, in request order. */
export function parseBatchResponse(
	raw: unknown,
	count: number,
	questions: Record<string, Question>,
): ChunkResult {
	if (!isRecord(raw)) return { ok: false, reason: "response body was not a JSON object" };
	if (!Array.isArray(raw.results)) return { ok: false, reason: 'response had no "results" array' };
	if (raw.results.length !== count) {
		return { ok: false, reason: `answered ${raw.results.length} of ${count} states` };
	}
	return { ok: true, entries: raw.results.map((entry) => readBatchResult(entry, questions)) };
}

/** Fold one answer set into a decision. */
function decideFrom(
	answers: Record<string, Answer>,
	provider: string,
	model: string,
	ms: number,
): Decision {
	const band: Band = foldBands(Object.values(answers).map((answer) => bandFor(answer)));
	return { outcome: "decided", answers, band, provider, model, ms, via: "live" };
}

/** Post one chunk and read it back. Every failure is a reason, never a throw. */
async function postChunk(
	url: string,
	key: string,
	title: string,
	body: string,
	states: readonly Record<string, unknown>[],
	questions: Record<string, Question>,
	deps: DecideDeps,
	timeoutMs: number,
): Promise<ChunkResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await deps.fetch(url, {
			method: "POST",
			headers: buildHeaders(key, title),
			body,
			signal: controller.signal,
		});
		if (res.status !== 200) {
			const raw: unknown = await res.json().catch(() => undefined);
			const detail = extractErrorMessage(raw);
			return {
				ok: false,
				reason: `HTTP ${res.status} from the batch route${detail ? `: ${detail}` : ""}`,
			};
		}
		const parsed: unknown = await res.json().catch(() => undefined);
		return parseBatchResponse(parsed, states.length, questions);
	} catch (err) {
		return { ok: false, reason: `batch call failed: ${errorText(err)}` };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Ask one question set about many states. Returns one decision per state, in
 * input order, and never rejects.
 */
export async function decideMany(
	req: DecideManyRequest,
	overrides?: Partial<DecideDeps>,
): Promise<Decision[]> {
	const env = overrides?.env ?? process.env;
	const deps: DecideDeps = { ...defaultDeps(env), ...overrides };
	const count = req.states.length;
	if (count === 0) return [];
	if (Object.keys(req.questions).length === 0) {
		return req.states.map(() => ({ outcome: "unsure", reason: "no questions requested" }));
	}
	const resolved = resolveProvider(env);
	if (!resolved.ok) return req.states.map(() => unavailable(resolved.reason));
	const provider = resolved.provider;
	if (provider.batchUrl === undefined) {
		return req.states.map(() => unavailable(`${provider.name} provider has no batch route`));
	}
	const cap = checkDailyCap({
		feature: req.feature,
		env: deps.env,
		logText: deps.readLog(decisionLogPath(deps.env)),
		now: deps.now(),
	});
	if (!cap.ok) return req.states.map(() => ({ outcome: "over-budget", reason: cap.reason }));

	const timeoutMs = resolveTimeoutMs({ feature: req.feature, timeoutMs: req.timeoutMs, env });
	const title = envString(env, TITLE_ENV) ?? DEFAULT_TITLE;
	const decisions: Decision[] = [];
	for (const states of chunk(req.states, MAX_BATCH_STATES)) {
		const started = deps.now();
		const result = await postChunk(
			provider.batchUrl,
			provider.key,
			title,
			buildBatchBody(states, req.questions),
			states,
			req.questions,
			deps,
			timeoutMs,
		);
		const ms = deps.now() - started;
		if (!result.ok) {
			decisions.push(...states.map(() => unavailable(result.reason)));
			continue;
		}
		for (const entry of result.entries) {
			decisions.push(
				entry.ok
					? decideFrom(entry.answers, provider.name, provider.model, ms)
					: unavailable(entry.reason),
			);
		}
	}
	logAll(deps, req, decisions);
	return decisions;
}

/** Write one log record per state, best effort, the way a single call does. */
function logAll(deps: DecideDeps, req: DecideManyRequest, decisions: readonly Decision[]): void {
	const now = deps.now();
	for (let index = 0; index < decisions.length; index += 1) {
		const decision = decisions[index];
		const state = req.states[index];
		if (decision === undefined || state === undefined) continue;
		try {
			deps.append(
				buildRecord({
					feature: req.feature,
					subject: req.subject,
					state,
					questions: req.questions,
					decision,
					now,
				}),
			);
		} catch {
			// Logging is best effort by contract, exactly as it is for one call.
		}
	}
}

/** One state that a screen kept, with the decision that kept it. */
export interface Screened {
	index: number;
	decision: Decision;
}

/**
 * Keep the states the engine acted on, in input order. This is the shape the
 * volume is for: judge a corpus in a few requests, then send only the kept
 * states to a slower and more expensive reader.
 */
export async function screen(
	req: DecideManyRequest,
	overrides?: Partial<DecideDeps>,
): Promise<Screened[]> {
	const decisions = await decideMany(req, overrides);
	const kept: Screened[] = [];
	for (let index = 0; index < decisions.length; index += 1) {
		const decision = decisions[index];
		if (decision !== undefined && decision.outcome === "decided" && decision.band === "act") {
			kept.push({ index, decision });
		}
	}
	return kept;
}
