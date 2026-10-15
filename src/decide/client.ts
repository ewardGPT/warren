/**
 * `src/decide/client.ts` — `decide()`: one Jev round-trip, one band, one
 * log line, and never a throw.
 *
 * ## Shape
 *
 * `decide({ feature, state, questions, … })` asks every question in one
 * `POST`, then folds the answers into a single band:
 *
 *   - an answer to a question literally named `band` is authoritative —
 *     it is Jev's own verdict on the action — and is mapped by `bandFor`;
 *   - otherwise the questions fold worst-first (`foldBands`): any `hold`
 *     wins, then any `ask`, and only an all-`act` answer set acts. Acting
 *     because one sub-question said "go" while another said "stop" is the
 *     failure mode this exists to prevent.
 *
 * `actAt` / `denyAt` on the request are the `act` / `deny` thresholds
 * handed to `bandFor` (defaults 0.9 / 0.1 — see `band.ts` for the exact
 * band contract, including the `score` legend rule).
 *
 * ## Failure contract (never throws, never blocks a caller)
 *
 * Every outcome is a value, not an exception:
 *
 *   - **no key / unknown `JEV_PROVIDER` / unparseable body / an `answers`
 *     object missing a requested key** → `unavailable` with a reason. A
 *     partially answered set is treated as no answer at all, so the
 *     engine can never act on a subset of what it asked.
 *   - **timeout** → `unavailable`, and deliberately *not* retried: a
 *     deadline that already blew cannot be repaired by spending it again.
 *     The timeout is a whole-call wall clock (`budget.resolveTimeoutMs`,
 *     default 4000 ms) that also covers the retry, and the call is raced
 *     against it, so a `fetch` that ignores its `AbortSignal` still
 *     returns control at the deadline.
 *   - **dropped connection** → exactly one retry.
 *   - **429 / 529** → exactly one retry, waiting `retry-after` (or
 *     `DEFAULT_RETRY_DELAY_MS`), but only when the remaining budget can
 *     still absorb that wait plus a real attempt.
 *   - **anything else non-200** → `unavailable` naming the status (and
 *     the provider's own error message when it sent one).
 *   - **nothing to ask** → `unsure`. This is the only producer of that
 *     outcome: the engine ran but had no question to judge.
 *   - **daily cap spent** (`WARREN_JEV_DAILY_CAP`) → `over-budget`, before
 *     any network call, with the count and the cap in the reason.
 *
 * Every one of those outcomes — including the failures — is appended to
 * the decision log, so an audit shows what was attempted and refused.
 *
 * ## Caching and the stub
 *
 * `WARREN_JEV_CACHE_TTL_MS` (default off) memoizes successful live
 * decisions in-process, keyed by a hash of provider + model + state +
 * questions; a hit returns `via: "cache"` and costs nothing. The cache is
 * bounded (`CACHE_MAX_ENTRIES`) and is injected through `deps.cache` so
 * tests get a fresh one. `WARREN_JEV_STUB=1` (or `JEV_PROVIDER=stub`)
 * answers from a fixture instead of the network — see
 * `fixtures/jev-stub.json` and `WARREN_JEV_STUB_FIXTURE`.
 *
 * ## Beyond the frozen signature
 *
 * The request adds one optional field the log needs and the base contract
 * cannot express: `subject` (run id, seed id, qitem id) is recorded with
 * every decision. Everything else matches the agreed signature.
 */

import { readFileSync } from "node:fs";
import { checkDailyCap, resolveTimeoutMs } from "./budget.ts";
import { type CacheEntry, cacheKey, readCache, writeCache } from "./cache.ts";
import { errorText, settled, unavailable } from "./internal.ts";
import {
	buildHeaders,
	buildRequestBody,
	DEFAULT_TITLE,
	envString,
	extractErrorMessage,
	type ProviderChoice,
	parseJevResponse,
	parseRetryAfterMs,
	resolveProvider,
	TITLE_ENV,
} from "./provider.ts";
import {
	appendDecision,
	buildRecord,
	clip,
	type DecisionRecord,
	decisionLogPath,
	readLogTail,
} from "./record.ts";
import { decideWithStub } from "./stub.ts";
import type { BandOptions, Decision, Env, Question } from "./types.ts";

/** Retries allowed per call — one, for a dropped connection or a 429/529. */
export const MAX_RETRIES = 1;

/** Delay before a retry that carried no `retry-after`. */
export const DEFAULT_RETRY_DELAY_MS = 250;

/** A retry needs at least this much budget left after the wait to be worth starting. */
export const MIN_RETRY_BUDGET_MS = 100;

/**
 * The fetch seam. Deliberately the *call signature* rather than
 * `typeof fetch`: the global also carries `preconnect`, which an injected
 * fake has no business implementing. `globalThis.fetch` is assignable to
 * this, and so is a two-line test double.

 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Everything `decide` touches outside itself. Injected so tests stay offline. */
export interface DecideDeps {
	env: Env;
	fetch: FetchLike;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	append: (record: DecisionRecord) => void;
	readLog: (path: string) => string;
	readFixture: (path: string) => string;
	cache: Map<string, CacheEntry>;
}

/**
 * `decide`'s request. Same shape as the agreed contract plus the optional
 * `subject` that `record.ts` needs (see the header).
 */
export interface DecideRequest {
	feature: string;
	state: Record<string, unknown>;
	questions: Record<string, Question>;
	subject?: string;
	timeoutMs?: number;
	actAt?: number;
	denyAt?: number;
}

const sharedCache = new Map<string, CacheEntry>();

/** Default fake out of `env`: real fetch, real clock, real log, real fixture reader. */
export function defaultDeps(env: Env = process.env): DecideDeps {
	return {
		env,
		fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
		now: () => Date.now(),
		sleep: (ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		},
		append: (record) => appendDecision(record, { env }),
		readLog: (path) => readLogTail(path),
		readFixture: (path) => readFileSync(path, "utf8"),
		cache: sharedCache,
	};
}

/** Raised by our own deadline timer, so it is distinguishable from a real abort. */
class JevDeadlineError extends Error {
	constructor(ms: number) {
		super(`timed out after ${ms}ms`);
		this.name = "JevDeadlineError";
	}
}

/**
 * Ask Jev. Resolves to a `Decision` for every input — see the failure
 * contract in the header; this function never rejects.
 */
export async function decide(
	req: DecideRequest,
	overrides?: Partial<DecideDeps>,
): Promise<Decision> {
	const env = overrides?.env ?? process.env;
	const deps: DecideDeps = { ...defaultDeps(env), ...overrides };
	const started = deps.now();
	let decision: Decision;
	try {
		const timeoutMs = resolveTimeoutMs({ feature: req.feature, timeoutMs: req.timeoutMs, env });
		decision = await dispatch(req, deps, started, timeoutMs);
	} catch (err) {
		decision = unavailable(`decision engine error: ${errorText(err)}`);
	}
	try {
		deps.append(
			buildRecord({
				feature: req.feature,
				subject: req.subject,
				state: req.state,
				questions: req.questions,
				decision,
				now: deps.now(),
			}),
		);
	} catch {
		// Logging is best-effort by contract: a failed append must not turn
		// a perfectly good decision into a thrown error.
	}
	return decision;
}

async function dispatch(
	req: DecideRequest,
	deps: DecideDeps,
	started: number,
	timeoutMs: number,
): Promise<Decision> {
	if (Object.keys(req.questions).length === 0) {
		return { outcome: "unsure", reason: "no questions requested" };
	}
	const resolved = resolveProvider(deps.env);
	if (!resolved.ok) return unavailable(resolved.reason);
	const provider = resolved.provider;
	const thresholds: BandOptions = { act: req.actAt, deny: req.denyAt };
	if (provider.name === "stub") return decideWithStub(req, deps, started, thresholds);

	const key = cacheKey(provider, req);
	const cached = readCache(deps, key, started);
	if (cached !== null) return cached;

	const cap = checkDailyCap({
		feature: req.feature,
		env: deps.env,
		logText: deps.readLog(decisionLogPath(deps.env)),
		now: started,
	});
	if (!cap.ok) return { outcome: "over-budget", reason: cap.reason };

	const decision = await runLive({
		req,
		deps,
		provider,
		started,
		deadline: started + timeoutMs,
		thresholds,
	});
	if (decision.outcome === "decided") writeCache(deps, key, decision, deps.now());
	return decision;
}

interface LiveContext {
	req: DecideRequest;
	deps: DecideDeps;
	provider: ProviderChoice;
	started: number;
	deadline: number;
	thresholds: BandOptions;
}

type StepResult =
	| { kind: "retry"; delayMs: number; reason: string }
	| { kind: "done"; decision: Decision };

/** One attempt plus, at most, one retry inside the shared deadline. */
async function runLive(ctx: LiveContext): Promise<Decision> {
	let lastRetry: { delayMs: number; reason: string } | null = null;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
		if (attempt > 0 && lastRetry !== null) await ctx.deps.sleep(lastRetry.delayMs);
		const step = await attemptJev(ctx);
		if (step.kind === "done") return step.decision;
		lastRetry = step;
	}
	const reason = lastRetry?.reason ?? "provider call failed";
	return unavailable(`${reason}; retry budget spent`);
}

async function attemptJev(ctx: LiveContext): Promise<StepResult> {
	const remaining = ctx.deadline - ctx.deps.now();
	if (remaining <= 0) {
		return { kind: "done", decision: unavailable("Jev budget was exhausted before the call") };
	}
	const outcome = await postOnce(ctx, remaining);
	if (outcome.kind === "timeout") {
		return {
			kind: "done",
			decision: unavailable(`${outcome.reason}; a timed-out call is not retried`),
		};
	}
	if (outcome.kind === "transport") {
		return retryOrFail({ reason: outcome.reason, retryable: true, retryAfterMs: null }, remaining);
	}
	if (outcome.res.status === 200) {
		return { kind: "done", decision: await readSuccess(ctx, outcome.res) };
	}
	return retryOrFail(await describeHttpFailure(outcome.res), remaining);
}

interface FailureInfo {
	reason: string;
	retryable: boolean;
	retryAfterMs: number | null;
}

/** Retry once, but only when the remaining budget still covers the wait and an attempt. */
function retryOrFail(info: FailureInfo, remaining: number): StepResult {
	if (!info.retryable) return { kind: "done", decision: unavailable(info.reason) };
	const delayMs = info.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS;
	if (remaining <= delayMs + MIN_RETRY_BUDGET_MS) {
		return {
			kind: "done",
			decision: unavailable(
				`${info.reason}; not retried — needs ${delayMs}ms of the ${Math.round(remaining)}ms left`,
			),
		};
	}
	return { kind: "retry", delayMs, reason: info.reason };
}

type PostOutcome =
	| { kind: "ok"; res: Response }
	| { kind: "timeout"; reason: string }
	| { kind: "transport"; reason: string };

/**
 * One POST, raced against the deadline. The race — not the `AbortSignal`
 * — is what guarantees return, so an injected `fetch` that ignores its
 * signal cannot hang the engine.
 */
async function postOnce(ctx: LiveContext, remaining: number): Promise<PostOutcome> {
	const controller = new AbortController();
	const expired = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		controller.abort();
		expired.reject(new JevDeadlineError(Math.round(remaining)));
	}, remaining);
	const title = envString(ctx.deps.env, TITLE_ENV) ?? DEFAULT_TITLE;
	try {
		const res = await Promise.race([
			ctx.deps.fetch(ctx.provider.url, {
				method: "POST",
				headers: buildHeaders(ctx.provider.key, title),
				body: buildRequestBody(ctx.provider.model, ctx.req.state, ctx.req.questions),
				signal: controller.signal,
			}),
			expired.promise,
		]);
		return { kind: "ok", res };
	} catch (err) {
		if (err instanceof JevDeadlineError) return { kind: "timeout", reason: err.message };
		// An AbortError here is always our own deadline: we own the controller and
		// only the timer aborts it, so it reads as a timeout to the caller too.
		if (err instanceof Error && err.name === "AbortError") {
			return { kind: "timeout", reason: `timed out after ${Math.round(remaining)}ms` };
		}
		return { kind: "transport", reason: `transport error: ${errorText(err)}` };
	} finally {
		clearTimeout(timer);
	}
}

async function describeHttpFailure(res: Response): Promise<FailureInfo> {
	const status = res.status;
	let detail: string | undefined;
	try {
		const text = await res.text();
		try {
			detail = extractErrorMessage(JSON.parse(text));
		} catch {
			detail = text.trim().length === 0 ? undefined : clip(text.trim(), 120);
		}
	} catch {
		detail = undefined;
	}
	const retryable = status === 429 || status === 529;
	return {
		reason: `HTTP ${status} from Jev${detail === undefined ? "" : `: ${detail}`}`,
		retryable,
		retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
	};
}

async function readSuccess(ctx: LiveContext, res: Response): Promise<Decision> {
	let text: string;
	try {
		text = await res.text();
	} catch (err) {
		return unavailable(`could not read the Jev response body: ${errorText(err)}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return unavailable(`Jev sent a body that was not JSON: ${clip(text.trim(), 120)}`);
	}
	const parsed = parseJevResponse(raw, ctx.req.questions);
	if (!parsed.ok) return unavailable(parsed.reason);
	return settled({
		started: ctx.started,
		now: ctx.deps.now(),
		provider: ctx.provider.name,
		model: parsed.value.model ?? ctx.provider.model,
		via: "live",
		usage: parsed.value.usage,
		answers: parsed.value.answers,
		thresholds: ctx.thresholds,
	});
}
