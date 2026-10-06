/**
 * Budget-class triage at spawn (ubuntu-d8c3 / TTC phase 1).
 *
 * Static budgets treat a typo fix and a refactor epic the same. This module
 * classifies the seed's work into three deterministic tiers and yields a USD
 * ceiling per tier. The class applies ONLY when the run otherwise has no
 * ceiling (no operator override, no per-trigger cap, no agent frontmatter
 * cap), so an explicit budget always wins — the triage never raises a cap a
 * human set.
 *
 * The classifier is deliberately model-free and keyword-light: text length,
 * distinct path tokens ("src/runs/reap" counts as one), and complexity
 * keywords. Proxies, not judgment — the ceilings are generous so a
 * misclassified run costs a few dollars, never a cancelled marathon.
 */

export type BudgetLevel = "trivial" | "standard" | "complex";

export interface BudgetClass {
	readonly level: BudgetLevel;
	/** USD ceiling. The class always yields one so the triage is total. */
	readonly maxCostUsd: number;
}

export interface BudgetTriageInput {
	/** Resolved seed text (title/body/labels) or the operator prompt fallback. */
	readonly seedText: string;
	readonly prompt: string;
}

export const TRIVIAL_CAP_USD = 1;
export const STANDARD_CAP_USD = 3;
export const COMPLEX_CAP_USD = 10;

const COMPLEXITY_KEYWORDS =
	/\b(migrat|refactor|rewrite|legacy|security|concurren|deadlock|thread|ffi|bindings?)\w*/i;

/** Count distinct path-like tokens ("src/runs/reap", "deploy/k8s/base"). */
function countPathTokens(text: string): number {
	const seen = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9/._-]+/)) {
		if (raw.includes("/") && raw.length >= 5) seen.add(raw);
	}
	return seen.size;
}

/**
 * Accumulate complexity signals, two saturating thresholds each: length
 * (>600, >1500 chars), path volume (>=3, >=6), keyword hits (>=2, >=5).
 * Score runs 0..6; tiers: 0 trivial, 1-2 standard, >=3 complex.
 */
function triageScore(seedText: string, prompt: string): number {
	const text = `${seedText}\n${prompt}`;
	let score = 0;
	if (text.length > 600) score += 1;
	if (text.length > 1500) score += 1;
	const paths = countPathTokens(text);
	if (paths >= 3) score += 1;
	if (paths >= 6) score += 1;
	const keywordHits = (text.match(COMPLEXITY_KEYWORDS) ?? []).length;
	if (keywordHits >= 2) score += 1;
	if (keywordHits >= 5) score += 1;
	return score;
}

/** Map one spawn's inputs to its budget class. Deterministic, never throws. */
export function classifyBudgetClass(input: BudgetTriageInput): BudgetClass {
	const score = triageScore(input.seedText, input.prompt);
	if (score >= 3) return { level: "complex", maxCostUsd: COMPLEX_CAP_USD };
	if (score <= 0) return { level: "trivial", maxCostUsd: TRIVIAL_CAP_USD };
	return { level: "standard", maxCostUsd: STANDARD_CAP_USD };
}
