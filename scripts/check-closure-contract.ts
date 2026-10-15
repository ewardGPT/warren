#!/usr/bin/env bun
/**
 * Closure-contract guard (ubuntu-cf02).
 *
 * `sd close <id>` writes `closeReason` as prose or omits it. A baton dropped
 * mid-handoff then looks exactly like a completed task, which is the failure
 * the closure vocabulary exists to expose (see src/seeds-cli/closure.ts for the
 * rule set and the free-text shapes it reads back).
 *
 * This guard is a ratchet, not a wall:
 *
 *   - Rows closed BEFORE `baselineAt` are history. Their debt is counted and
 *     reported, and it may not grow.
 *   - Rows closed AFTER `baselineAt` must carry a reason that parses into the
 *     vocabulary. Anything else fails this gate with a `file:line`.
 *   - Any closure that contradicts the contract (a required target or successor
 *     that is absent, a field that is not admitted, an unknown reason) fails
 *     regardless of date.
 *
 * Chained into `bun run lint` beside check-seeds-integrity.ts. Also runnable
 * directly: `bun run scripts/check-closure-contract.ts`.
 *
 * A repo without `.seeds/issues.jsonl` is not a failure: the gate reports that
 * it had nothing to check and exits 0.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isClosureReason, parseClosure, validateClosure } from "../src/seeds-cli/closure.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ISSUES_FILE = ".seeds/issues.jsonl";
const BASELINE_FILE = "scripts/closure-baseline.json";

export type IssueRow = {
	id?: unknown;
	status?: unknown;
	closeReason?: unknown;
	closedAt?: unknown;
};

export type ClosureViolation = {
	/** 1-based line in .seeds/issues.jsonl. */
	line: number;
	id: string;
	code: string;
	message: string;
};

export type ClosureAudit = {
	closed: number;
	/** Closed at or before the baseline: history, counted as debt. */
	legacy: number;
	/** Closed after the baseline with no reason that parses. */
	missingReason: ClosureViolation[];
	/** Any date: a closure that contradicts the contract. */
	violations: ClosureViolation[];
	/** History that carries no reason at all. */
	legacyWithoutReason: number;
	/** History whose reason does not parse into the vocabulary. */
	legacyUnparsed: number;
};

function textOf(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function isClosed(row: IssueRow): boolean {
	return textOf(row.status) === "closed";
}

/**
 * Classify every closed row. Pure: the caller supplies the parsed rows, the
 * baseline date, and the line each row came from.
 */
export function auditClosures(
	rows: readonly { row: IssueRow; line: number }[],
	baselineAt: string,
): ClosureAudit {
	const baselineMs = Date.parse(baselineAt);
	const audit: ClosureAudit = {
		closed: 0,
		legacy: 0,
		missingReason: [],
		violations: [],
		legacyWithoutReason: 0,
		legacyUnparsed: 0,
	};

	for (const { row, line } of rows) {
		if (!isClosed(row)) continue;
		const id = textOf(row.id) || "(no id)";
		const isLegacy = isHistory(row, baselineMs);
		audit.closed += 1;
		if (isLegacy) audit.legacy += 1;
		applyVerdict(audit, { line, id }, isLegacy, classifyClosure(textOf(row.closeReason)));
	}

	return audit;
}

/**
 * A row with no usable `closedAt` cannot be proven to be new, so it counts as
 * history. Failing lint over an unreadable timestamp would punish the wrong side
 * of the ratchet.
 */
function isHistory(row: IssueRow, baselineMs: number): boolean {
	const closedMs = Date.parse(textOf(row.closedAt));
	return !Number.isFinite(closedMs) || !Number.isFinite(baselineMs) || closedMs <= baselineMs;
}

type Verdict =
	| { kind: "structured" }
	| { kind: "no-reason" }
	| { kind: "unparsed"; reason: string }
	| { kind: "violation"; code: string; message: string };

/** What one `closeReason` says about the closure contract. */
function classifyClosure(reason: string): Verdict {
	if (reason === "") return { kind: "no-reason" };
	if (isClosureReason(reason)) {
		const error = validateClosure({ reason }).findings.find(
			(finding) => finding.severity === "error",
		);
		return error === undefined
			? { kind: "structured" }
			: { kind: "violation", code: error.code, message: error.message };
	}
	const parsed = parseClosure(reason);
	if (parsed.closure !== undefined) return { kind: "structured" };
	const error = parsed.findings.find((finding) => finding.severity === "error");
	return error === undefined
		? { kind: "unparsed", reason }
		: { kind: "violation", code: error.code, message: error.message };
}

function applyVerdict(
	audit: ClosureAudit,
	where: { line: number; id: string },
	isLegacy: boolean,
	verdict: Verdict,
): void {
	switch (verdict.kind) {
		case "structured":
			return;
		case "no-reason":
			if (isLegacy) audit.legacyWithoutReason += 1;
			else
				audit.missingReason.push({
					...where,
					code: "closure_reason_required",
					message: "closed after the baseline with no closeReason",
				});
			return;
		case "unparsed":
			if (isLegacy) audit.legacyUnparsed += 1;
			else
				audit.missingReason.push({
					...where,
					code: "closure_reason_unparsed",
					message: `closed after the baseline with a reason outside the vocabulary: ${verdict.reason.slice(0, 80)}`,
				});
			return;
		case "violation":
			if (isLegacy) audit.legacyUnparsed += 1;
			else audit.violations.push({ ...where, code: verdict.code, message: verdict.message });
	}
}

export function parseIssues(text: string): { row: IssueRow; line: number }[] {
	const rows: { row: IssueRow; line: number }[] = [];
	text.split("\n").forEach((raw, index) => {
		if (raw.trim() === "") return;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null) {
				rows.push({ row: parsed as IssueRow, line: index + 1 });
			}
		} catch {
			// check-seeds-integrity owns malformed rows; this gate stays quiet.
		}
	});
	return rows;
}

type Baseline = { baselineAt: string; legacyWithoutReason: number; legacyUnparsed: number };

function readBaseline(): Baseline | undefined {
	if (!existsSync(resolve(REPO_ROOT, BASELINE_FILE))) return undefined;
	const parsed: unknown = JSON.parse(readFileSync(resolve(REPO_ROOT, BASELINE_FILE), "utf8"));
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const record = parsed as Record<string, unknown>;
	return {
		baselineAt: typeof record.baselineAt === "string" ? record.baselineAt : "",
		legacyWithoutReason: Number(record.legacyWithoutReason ?? Number.NaN),
		legacyUnparsed: Number(record.legacyUnparsed ?? Number.NaN),
	};
}

function main(): void {
	const issuesPath = resolve(REPO_ROOT, ISSUES_FILE);
	if (!existsSync(issuesPath)) {
		console.log(`check:closure-contract — skipped (no ${ISSUES_FILE})`);
		return;
	}
	const baseline = readBaseline();
	if (baseline === undefined || baseline.baselineAt === "") {
		console.error(
			`check:closure-contract — ${BASELINE_FILE} is missing or has no baselineAt.\n` +
				`Create it with the current history:\n` +
				`  bun run scripts/check-closure-contract.ts --write-baseline`,
		);
		process.exit(1);
	}

	const audit = auditClosures(parseIssues(readFileSync(issuesPath, "utf8")), baseline.baselineAt);
	const problems = [...audit.violations, ...audit.missingReason];
	const debtGrew =
		audit.legacyWithoutReason > baseline.legacyWithoutReason ||
		audit.legacyUnparsed > baseline.legacyUnparsed;

	console.log(
		`check:closure-contract — ${audit.closed} closed, ${audit.legacy} before ${baseline.baselineAt}, ` +
			`history debt ${audit.legacyWithoutReason} without a reason + ${audit.legacyUnparsed} unstructured ` +
			`(baseline ${baseline.legacyWithoutReason} + ${baseline.legacyUnparsed}), ` +
			`${audit.violations.length} contract violation(s), ${audit.missingReason.length} closure(s) after the baseline without a vocabulary reason`,
	);

	if (problems.length === 0 && !debtGrew) return;

	console.error("");
	for (const problem of problems) {
		console.error(
			`  ${ISSUES_FILE}:${problem.line} — ${problem.id}: ${problem.code} — ${problem.message}`,
		);
	}
	if (debtGrew) {
		console.error(
			`\n  history debt grew: ${audit.legacyWithoutReason} + ${audit.legacyUnparsed} now, ` +
				`${baseline.legacyWithoutReason} + ${baseline.legacyUnparsed} recorded at ${baseline.baselineAt}.\n` +
				`  The ratchet only goes down. Lower the numbers in ${BASELINE_FILE} when the debt shrinks.`,
		);
	}
	if (problems.length > 0) {
		console.error(
			"\nClose work with a vocabulary reason so the next reader can tell a finished task\n" +
				"from a dropped baton. The canonical string is printed by:\n" +
				"  warren seeds closure <reason> [--target <id>] [--successor <id>] --note '<what happened>'",
		);
	}
	process.exit(1);
}

if (import.meta.main) {
	if (process.argv.includes("--write-baseline")) {
		const text = readFileSync(resolve(REPO_ROOT, ISSUES_FILE), "utf8");
		const rows = parseIssues(text);
		const audit = auditClosures(rows, new Date(Date.now() + 1).toISOString());
		const baseline: Baseline & { note: string } = {
			note: "History at first adoption of the closure contract. The ratchet only goes down.",
			baselineAt: new Date().toISOString(),
			legacyWithoutReason: audit.legacyWithoutReason,
			legacyUnparsed: audit.legacyUnparsed,
		};
		writeFileSync(resolve(REPO_ROOT, BASELINE_FILE), `${JSON.stringify(baseline, null, "\t")}\n`);
		console.log(`wrote ${BASELINE_FILE}: ${JSON.stringify(baseline)}`);
	} else {
		main();
	}
}
