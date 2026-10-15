/**
 * The deterministic run scorecard (ubuntu-c929).
 *
 * Reap's terminal verdict is the runtime's own envelope, and the deployed
 * build's stop-check is a model's opinion over a text sample. Neither is
 * execution evidence. This module assembles the evidence a run leaves behind,
 * and it reads nothing with a model in it.
 *
 * Two rules keep it honest:
 *
 * 1. **Every field is observed, never judged.** A count, a flag, an exit code
 *    or an id. Where an observation is unavailable the field is `null`, and a
 *    `null` means "not observed", never "not done".
 * 2. **The stream half is a sample.** The bridge persists a bounded slice of a
 *    chatty run's events, so turn, tool and gate counts describe what reached
 *    the event table. `gateCommands: 0` says no gate-shaped command was in the
 *    sample, not that the agent skipped its gate.
 *
 * The scorecard lands on a `run.scorecard` event at reap, and reap returns it.
 * Consumers are budget triage and best-of-N selection; both read deterministic
 * facts, which is the point.
 */

import type { CheckRunsVerdict } from "../../ci-fixer/check-runs.ts";
import { classifyCheckRuns, fetchCheckRuns } from "../../ci-fixer/check-runs.ts";
import type { RunFailureReason, RunTerminalState } from "../../db/schema.ts";
import { checkPullRequestMerged, parsePullRequestUrl } from "../pr-checks.ts";
import type { ReapStepError } from "./types.ts";

/** The branch half: what the run's work did on origin. */
export interface ScorecardBranch {
	readonly pushed: boolean;
	/** Commits the pushed branch is ahead of its base; null when uncomputable. */
	readonly commitsAhead: number | null;
	/** A real change was dropped: the push carried nothing although work existed. */
	readonly droppedCommit: boolean;
	/** A deliberate no-op: the tree held no change worth shipping. */
	readonly noChanges: boolean;
}

/** Size of the run's diff against its base branch. */
export interface ScorecardDiff {
	readonly files: number;
	readonly insertions: number;
	readonly deletions: number;
}

/**
 * The last gate-shaped command the agent ran, with its outcome.
 *
 * `exitCode` comes from an `EXIT=<n>` marker the command printed; it is null
 * when the command printed none. `ok` is the runtime's own `isError` flag, so
 * the two can disagree when a command swallows its exit status.
 */
export interface ScorecardGate {
	readonly command: string;
	readonly ok: boolean;
	readonly exitCode: number | null;
}

/** Pull request facts. Both upstream fields are null when unobserved. */
export interface ScorecardPr {
	readonly opened: boolean;
	readonly url: string | null;
	readonly merged: "merged" | "open" | "closed_unmerged" | null;
	readonly checks: CheckRunsVerdict | null;
}

/** Cost and token totals from the run row. */
export interface ScorecardUsage {
	readonly costUsd: number | null;
	readonly tokensInput: number | null;
	readonly tokensOutput: number | null;
	readonly tokensCacheRead: number | null;
	readonly tokensCacheWrite: number | null;
}

export interface RunScorecard {
	readonly version: 1;
	readonly reapedAt: string;
	readonly state: RunTerminalState;
	readonly failureReason: RunFailureReason | null;
	readonly branch: ScorecardBranch;
	readonly diff: ScorecardDiff | null;
	readonly pr: ScorecardPr;
	readonly gate: ScorecardGate | null;
	/** How many gate-shaped commands appeared in the persisted sample. */
	readonly gateCommands: number;
	readonly turns: number;
	readonly toolCalls: number;
	readonly usage: ScorecardUsage;
	/** Reap step failures; 0 is a clean reap. */
	readonly reapErrors: number;
	/** The fleet box that ran it, from the `<box>/<inner>` handle. Null when local. */
	readonly box: string | null;
}

/** The structural subset of an event row the summarizer reads. */
export interface ScorecardEventInput {
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: unknown;
}

export interface StreamSummary {
	readonly turns: number;
	readonly toolCalls: number;
	readonly gateCommands: number;
	readonly gate: ScorecardGate | null;
}

/**
 * Commands a run's own quality gate takes. Deliberately narrow: a command line
 * has to name a known test or check runner to count, so an unrelated `cat
 * check.txt` cannot pose as gate evidence.
 */
const GATE_PATTERNS: readonly RegExp[] = [
	/\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?(?:check|test|lint|typecheck|biome|tsc)\b/i,
	/\b(?:biome|tsc)\b/i,
	/\bpytest\b/i,
	/\bgo\s+(?:test|vet)\b/i,
	/\bcargo\s+test\b/i,
	/\bmake\s+(?:test|check|lint)\b/i,
];

export function isGateCommand(command: string): boolean {
	return GATE_PATTERNS.some((pattern) => pattern.test(command));
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/** The command a bash-shaped tool envelope carried, or null for another tool. */
function commandOf(payload: Record<string, unknown>): string | null {
	const args = asRecord(payload.args) ?? asRecord(payload.arguments);
	if (args === null) return null;
	return asString(args.command);
}

/** An `EXIT=<n>` marker the command printed, or null. Last match wins. */
function exitMarker(text: string): number | null {
	const matches = [...text.matchAll(/EXIT=(-?\d+)/g)];
	const last = matches.at(-1);
	if (last === undefined || last[1] === undefined) return null;
	const n = Number.parseInt(last[1], 10);
	return Number.isFinite(n) ? n : null;
}

/** Every text chunk a tool-execution result carried, joined. */
function resultText(payload: Record<string, unknown>): string {
	const result = asRecord(payload.result);
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => asString(asRecord(part)?.text) ?? "")
		.filter((text) => text !== "")
		.join("\n");
}

/**
 * Turn, tool and gate facts from a run's persisted events.
 *
 * Shape-first, not kind-first: the same payload type arrives under different
 * event kinds across runtimes, and the payload is the part that carries the
 * fact. Unknown shapes are skipped, so a new runtime costs fields rather than
 * a crash.
 */
export function summarizeRunStream(events: Iterable<ScorecardEventInput>): StreamSummary {
	const acc = newStreamAccumulator();
	for (const event of events) {
		const payload = asRecord(event.payload);
		if (payload !== null) absorbEvent(acc, payload);
	}
	return {
		turns: acc.turns,
		toolCalls: acc.toolCalls,
		gateCommands: acc.gateCommands,
		gate: resolveGate(acc.lastGateStart, acc.ends),
	};
}

interface StreamAccumulator {
	turns: number;
	toolCalls: number;
	gateCommands: number;
	lastGateStart: { command: string; id: string | null } | null;
	/** toolCallId → the execution-end payload, so a start can find its result. */
	readonly ends: Map<string, Record<string, unknown>>;
}

function newStreamAccumulator(): StreamAccumulator {
	return { turns: 0, toolCalls: 0, gateCommands: 0, lastGateStart: null, ends: new Map() };
}

/** Fold one payload into the accumulator. Unknown shapes cost nothing. */
function absorbEvent(acc: StreamAccumulator, payload: Record<string, unknown>): void {
	const type = asString(payload.type);
	if (type === "turn_end") {
		acc.turns += 1;
		return;
	}
	if (type === "tool_execution_start") {
		absorbToolStart(acc, payload);
		return;
	}
	if (type === "tool_execution_end") {
		const id = asString(payload.toolCallId);
		if (id !== null) acc.ends.set(id, payload);
	}
}

function absorbToolStart(acc: StreamAccumulator, payload: Record<string, unknown>): void {
	acc.toolCalls += 1;
	const command = commandOf(payload);
	if (command === null || !isGateCommand(command)) return;
	acc.gateCommands += 1;
	acc.lastGateStart = { command, id: asString(payload.toolCallId) };
}

/**
 * Pair the LAST gate-shaped command with its result. The last one is the
 * interesting one: an agent that fixes a failing gate re-runs it, and the
 * final verdict describes the work that shipped.
 */
function resolveGate(
	start: { readonly command: string; readonly id: string | null } | null,
	ends: ReadonlyMap<string, Record<string, unknown>>,
): ScorecardGate | null {
	if (start === null) return null;
	const end = start.id === null ? undefined : ends.get(start.id);
	if (end === undefined) {
		// The command ran, and its result never reached the persisted sample.
		return { command: start.command, ok: false, exitCode: null };
	}
	return {
		command: start.command,
		ok: end.isError !== true,
		exitCode: exitMarker(resultText(end)),
	};
}

/* ----------------------------------------------------------------------- */
/* Observed facts that need a host or the network                           */
/* ----------------------------------------------------------------------- */

/** `git diff` via the runtime's exec seam, best-effort. */
export interface DiffStatInput {
	readonly exec: {
		run(
			cmd: string,
			args: readonly string[],
			opts: { cwd: string; timeoutMs?: number },
		): Promise<{ stdout: string; stderr: string }>;
	};
	readonly cwd: string;
	readonly baseRef: string;
	readonly headRef: string;
}

/**
 * Diff size of the run's work against its base, as NUMBERS (`--numstat`), since
 * `--stat` prints a sentence and the scorecard wants fields.
 *
 * Best-effort by design: the workspace may already be gone under K8s, or the
 * base ref may not resolve. Both mean `null` — not observed.
 */
export async function computeDiffStat(input: DiffStatInput): Promise<ScorecardDiff | null> {
	try {
		const out = await input.exec.run(
			"git",
			["diff", "--numstat", `${input.baseRef}..${input.headRef}`],
			{ cwd: input.cwd, timeoutMs: 10_000 },
		);
		return parseNumstat(out.stdout);
	} catch {
		return null;
	}
}

/**
 * Sum `git diff --numstat` output. Each line is
 * `<insertions>\t<deletions>\t<path>`, and a binary file prints `-` for both
 * counts — counted as a changed file with zero lines.
 */
export function parseNumstat(stdout: string): ScorecardDiff {
	let files = 0;
	let insertions = 0;
	let deletions = 0;
	for (const raw of stdout.split("\n")) {
		const line = raw.trimEnd();
		if (line === "") continue;
		const [added, removed, path] = line.split("\t");
		if (added === undefined || removed === undefined || path === undefined) continue;
		files += 1;
		insertions += Number.parseInt(added, 10) || 0;
		deletions += Number.parseInt(removed, 10) || 0;
	}
	return { files, insertions, deletions };
}

/** The two upstream reads a run with a PR can make, both best-effort. */
export interface PrUpstreamInput {
	readonly prUrl: string;
	/** The pushed branch or a commit sha the checks hang off. */
	readonly ref: string | null;
	/** A GitHub token. Empty ⇒ nothing is called and both fields stay null. */
	readonly token: string;
	readonly fetch?: typeof fetch;
}

export interface PrUpstream {
	readonly merged: ScorecardPr["merged"];
	readonly checks: ScorecardPr["checks"];
}

/**
 * Merge state and CI verdict for the run's PR, read at reap.
 *
 * Both are later facts than the run: at reap a fresh PR is usually still open
 * with checks pending. The scorecard records that honestly rather than waiting
 * for a settled answer it might never see.
 *
 * Reuses the deployed readers: `checkPullRequestMerged` (plan-run coordinator)
 * and `fetchCheckRuns` + `classifyCheckRuns` (the CI-fixer poller). Neither
 * call can fail the reap — an unreadable answer is a `null` field.
 */
export async function readPrUpstream(input: PrUpstreamInput): Promise<PrUpstream> {
	const empty: PrUpstream = { merged: null, checks: null };
	if (input.token === "") return empty;
	const parsed = parsePullRequestUrl(input.prUrl);
	if (parsed === null) return empty;
	const [merged, checks] = await Promise.all([
		readMergeState(parsed, input),
		readChecks(parsed, input),
	]);
	return { merged, checks };
}

async function readMergeState(
	parsed: { owner: string; repo: string; number: number },
	input: PrUpstreamInput,
): Promise<ScorecardPr["merged"]> {
	try {
		const result = await checkPullRequestMerged({
			owner: parsed.owner,
			repo: parsed.repo,
			number: parsed.number,
			token: input.token,
			...(input.fetch === undefined ? {} : { fetch: input.fetch }),
		});
		return result.kind === "merged" || result.kind === "open" || result.kind === "closed_unmerged"
			? result.kind
			: null;
	} catch {
		return null;
	}
}

async function readChecks(
	parsed: { owner: string; repo: string },
	input: PrUpstreamInput,
): Promise<ScorecardPr["checks"]> {
	if (input.ref === null) return null;
	try {
		const result = await fetchCheckRuns({
			owner: parsed.owner,
			repo: parsed.repo,
			ref: input.ref,
			token: input.token,
			...(input.fetch === undefined ? {} : { fetch: input.fetch }),
		});
		return result.kind === "ok" ? classifyCheckRuns(result.checkRuns).verdict : null;
	} catch {
		return null;
	}
}

/* ----------------------------------------------------------------------- */
/* The scorecard                                                            */
/* ----------------------------------------------------------------------- */

/** The pipeline facts reap already holds when it assembles a scorecard. */
export interface ScorecardReapState {
	readonly branchPushed: boolean;
	readonly commitsAhead: number | null;
	readonly droppedCommit: boolean;
	readonly noChanges: boolean;
	readonly prUrl: string | null;
	/** The branch the PR sits on, for the check-runs read. */
	readonly prBranch: string | null;
}

/** The run-row facts the scorecard copies. */
export interface ScorecardRunRow {
	readonly id: string;
	readonly burrowRunId: string | null;
	readonly costUsd: number | null;
	readonly tokensInput: number | null;
	readonly tokensOutput: number | null;
	readonly tokensCacheRead: number | null;
	readonly tokensCacheWrite: number | null;
}

export interface BuildScorecardInput {
	readonly run: ScorecardRunRow;
	readonly state: ScorecardReapState;
	readonly outcome: RunTerminalState;
	readonly failureReason: RunFailureReason | null;
	readonly errors: readonly ReapStepError[];
	readonly events: readonly ScorecardEventInput[];
	readonly diff: ScorecardDiff | null;
	readonly upstream: PrUpstream;
	readonly now: () => Date;
}

/** Assemble the scorecard. Pure: every observed fact arrives in the input. */
export function buildScorecard(input: BuildScorecardInput): RunScorecard {
	const summary = summarizeRunStream(input.events);
	return {
		version: 1,
		reapedAt: input.now().toISOString(),
		state: input.outcome,
		failureReason: input.failureReason,
		branch: {
			pushed: input.state.branchPushed,
			commitsAhead: input.state.commitsAhead,
			droppedCommit: input.state.droppedCommit,
			noChanges: input.state.noChanges,
		},
		diff: input.diff,
		pr: {
			opened: input.state.prUrl !== null,
			url: input.state.prUrl,
			merged: input.upstream.merged,
			checks: input.upstream.checks,
		},
		gate: summary.gate,
		gateCommands: summary.gateCommands,
		turns: summary.turns,
		toolCalls: summary.toolCalls,
		usage: {
			costUsd: input.run.costUsd,
			tokensInput: input.run.tokensInput,
			tokensOutput: input.run.tokensOutput,
			tokensCacheRead: input.run.tokensCacheRead,
			tokensCacheWrite: input.run.tokensCacheWrite,
		},
		reapErrors: input.errors.length,
		box: boxOf(input.run.burrowRunId),
	};
}

/**
 * The box a fleet run landed on. The fleet provider encodes the box as the
 * first half of the run handle (`<box>/<inner>`); a local run's handle has no
 * slash, so this is null off the fleet lane.
 */
export function boxOf(providerRunId: string | null): string | null {
	if (providerRunId === null) return null;
	const slash = providerRunId.indexOf("/");
	if (slash <= 0) return null;
	return providerRunId.slice(0, slash);
}

/** The event read the assembler needs. Narrow on purpose: tests stub it. */
export interface ScorecardEventSource {
	listByRun(
		runId: string,
		opts?: { limit?: number },
	): Promise<readonly { kind: string; stream: string | null; payloadJson: unknown }[]>;
}

export interface AssembleScorecardInput {
	readonly run: ScorecardRunRow;
	readonly state: ScorecardReapState;
	readonly outcome: RunTerminalState;
	readonly failureReason: RunFailureReason | null;
	readonly errors: readonly ReapStepError[];
	readonly events: ScorecardEventSource;
	/** The live workspace, for the diff read. Null under K8s or after a teardown. */
	readonly workspacePath: string | null;
	/** The base the diff counts against; null when the project was unreachable. */
	readonly baseBranch: string | null;
	readonly exec?: {
		run(
			cmd: string,
			args: readonly string[],
			opts: { cwd: string; timeoutMs?: number },
		): Promise<{ stdout: string; stderr: string }>;
	};
	/** The PR-open config; only its token is used, for the upstream reads. */
	readonly autoOpenPr?: { readonly token: string };
	readonly fetch?: typeof fetch;
	readonly now: () => Date;
}

/**
 * Assemble the scorecard at reap: read the stream, size the diff, ask GitHub
 * about the PR, then fold everything in.
 *
 * The three reads are independent and each is best-effort — a failed read
 * costs a field, never the reap.
 */
export async function assembleScorecard(input: AssembleScorecardInput): Promise<RunScorecard> {
	const [events, diff, upstream] = await Promise.all([
		readEvents(input),
		readDiff(input),
		readUpstream(input),
	]);
	return buildScorecard({
		run: input.run,
		state: input.state,
		outcome: input.outcome,
		failureReason: input.failureReason,
		errors: input.errors,
		events,
		diff,
		upstream,
		now: input.now,
	});
}

async function readEvents(input: AssembleScorecardInput): Promise<ScorecardEventInput[]> {
	try {
		const rows = await input.events.listByRun(input.run.id);
		return rows.map((row) => ({
			kind: row.kind,
			stream: row.stream,
			payload: row.payloadJson,
		}));
	} catch {
		return [];
	}
}

async function readDiff(input: AssembleScorecardInput): Promise<ScorecardDiff | null> {
	if (input.exec === undefined || input.workspacePath === null || input.baseBranch === null) {
		return null;
	}
	// The diff of the run's committed work against its base. `HEAD` is the
	// post-finalize workspace tip, so this counts what actually shipped.
	return await computeDiffStat({
		exec: input.exec,
		cwd: input.workspacePath,
		baseRef: input.baseBranch,
		headRef: "HEAD",
	});
}

async function readUpstream(input: AssembleScorecardInput): Promise<PrUpstream> {
	const prUrl = input.state.prUrl;
	const token = input.autoOpenPr?.token ?? "";
	if (prUrl === null || token === "") return { merged: null, checks: null };
	return await readPrUpstream({
		prUrl,
		ref: input.state.prBranch,
		token,
		...(input.fetch === undefined ? {} : { fetch: input.fetch }),
	});
}
