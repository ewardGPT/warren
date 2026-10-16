/**
 * `src/decide/` — Warren's decision engine over TypeSafe's Jev ("System
 * One"). Import from here; the individual modules are the shape of the
 * implementation, not the API.
 *
 * ```ts
 * const decision = await decide({
 *   feature: "merge-guard",
 *   subject: runId,
 *   state: { diffLines: 41, testsGreen: true },
 *   questions: { merge_ok: { type: "noul", instructions: "…" } },
 * });
 * if (decision.outcome !== "decided") return; // unavailable | unsure | over-budget
 * if (decision.band !== "act") return;        // ask | hold
 * ```
 */

export {
	bandFor,
	DEFAULT_ACT_AT,
	DEFAULT_DENY_AT,
	foldBands,
	SCORE_CRITERIA_MEDIAN,
} from "./band.ts";
export type { BatchEntry, DecideManyRequest, Screened } from "./batch.ts";
export {
	buildBatchBody,
	decideMany,
	MAX_BATCH_STATES,
	parseBatchResponse,
	readBatchResult,
	screen,
} from "./batch.ts";
export {
	checkDailyCap,
	countLiveCalls,
	DAILY_CAP_ENV,
	DEFAULT_TIMEOUT_MS,
	dailyCap,
	featureTimeoutEnv,
	MAX_TIMEOUT_MS,
	MIN_TIMEOUT_MS,
	resolveTimeoutMs,
	TIMEOUT_ENV,
	utcDay,
} from "./budget.ts";
export type { CacheEntry } from "./cache.ts";

export { CACHE_MAX_ENTRIES, CACHE_TTL_ENV } from "./cache.ts";
export {
	CASCADE_ENV,
	CONFIDENCE_ENV,
	cascadeEnabled,
	decideWithCascade,
	foldCascade,
	LAYA_CONFIDENT_AT,
	LAYA_PROVIDER,
	needsEscalation,
	weakestConfidence,
} from "./cascade.ts";
export type { DecideDeps, DecideRequest, FetchLike } from "./client.ts";
export {
	DEFAULT_RETRY_DELAY_MS,
	decide,
	defaultDeps,
	MAX_RETRIES,
	MIN_RETRY_BUDGET_MS,
} from "./client.ts";
export type { ParsedResponse, ParseResult, ProviderChoice, ProviderSpec } from "./provider.ts";
export {
	buildHeaders,
	buildRequestBody,
	extractErrorMessage,
	isFiniteNumber,
	isRecord,
	MODEL_ENV,
	PROVIDER_ENV,
	PROVIDERS,
	parseJevResponse,
	parseRetryAfterMs,
	readAnswer,
	readUsage,
	resolveProvider,
	STUB_ENV,
	TITLE_ENV,
} from "./provider.ts";
export type { DecisionRecord, LoggedQuestion } from "./record.ts";
export {
	appendDecision,
	buildRecord,
	CLIP_CRITERION,
	CLIP_INSTRUCTIONS,
	CLIP_REASON,
	CLIP_SUBJECT,
	clip,
	decisionLogPath,
	hashJson,
	LOG_ENV,
	MAX_LOG_READ_BYTES,
	readLogTail,
	stableStringify,
} from "./record.ts";
export {
	decideWithStub,
	defaultStubFixturePath,
	parseStubFixture,
	STUB_FIXTURE_ENV,
} from "./stub.ts";

export type {
	Answer,
	Band,
	BandOptions,
	Decided,
	Decision,
	DecisionUsage,
	DecisionVia,
	Env,
	Question,
	Undecided,
} from "./types.ts";
