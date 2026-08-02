/**
 * First-class token budget accounting for bounded Warren runs.
 *
 * A budget reserves the final 10% for recovery / "beast mode" work. Normal
 * work may consume the first 90%; recovery may consume the reserve, but never
 * beyond the total ceiling. The ledger is deliberately runtime-agnostic so
 * sapling, claude-code, and future burrow runtimes can report the same shape.
 */

export const DEFAULT_REGULAR_RATIO = 0.9;
export const DEFAULT_MAX_BAD_ATTEMPTS = 3;

export interface TokenBudgetConfig {
	readonly totalTokens: number;
	readonly regularRatio?: number;
	readonly maxBadAttempts?: number;
}

export interface TokenUsage {
	readonly input: number;
	readonly output: number;
	readonly tool?: string;
	readonly successful?: boolean;
}

export interface TokenBudgetSnapshot {
	readonly totalTokens: number;
	readonly regularLimit: number;
	readonly reserveTokens: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly badAttempts: number;
	readonly byTool: Readonly<Record<string, number>>;
}

export type TokenBudgetDecision = "continue" | "reserve_required" | "exhausted" | "bad_attempt_cap";

export class TokenBudgetLedger {
	private readonly totalLimit: number;
	private readonly regularLimit: number;
	private readonly maxBadAttempts: number;
	private inputTotal = 0;
	private outputTotal = 0;
	private badAttemptTotal = 0;
	private readonly toolTotals = new Map<string, number>();

	constructor(config: TokenBudgetConfig) {
		if (!Number.isSafeInteger(config.totalTokens) || config.totalTokens <= 0) {
			throw new Error("token budget totalTokens must be a positive safe integer");
		}
		const ratio = config.regularRatio ?? DEFAULT_REGULAR_RATIO;
		if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
			throw new Error("token budget regularRatio must be between 0 and 1");
		}
		this.totalLimit = config.totalTokens;
		this.regularLimit = Math.floor(config.totalTokens * ratio);
		this.maxBadAttempts = config.maxBadAttempts ?? DEFAULT_MAX_BAD_ATTEMPTS;
		if (!Number.isSafeInteger(this.maxBadAttempts) || this.maxBadAttempts < 0) {
			throw new Error("token budget maxBadAttempts must be a non-negative safe integer");
		}
	}

	record(usage: TokenUsage): TokenBudgetDecision {
		const input = nonNegativeInteger(usage.input, "input");
		const output = nonNegativeInteger(usage.output, "output");
		this.inputTotal += input;
		this.outputTotal += output;
		if (usage.tool !== undefined) {
			this.toolTotals.set(usage.tool, (this.toolTotals.get(usage.tool) ?? 0) + input + output);
		}
		if (usage.successful === false) this.badAttemptTotal += 1;
		return this.decision();
	}

	/** Whether a confident completion can stop before spending the reserve. */
	shouldEarlyExit(confident: boolean): boolean {
		return confident && this.totalUsed < this.regularLimit;
	}

	snapshot(): TokenBudgetSnapshot {
		return {
			totalTokens: this.totalUsed,
			regularLimit: this.regularLimit,
			reserveTokens: this.totalLimit - this.regularLimit,
			inputTokens: this.inputTotal,
			outputTokens: this.outputTotal,
			badAttempts: this.badAttemptTotal,
			byTool: Object.fromEntries(this.toolTotals),
		};
	}

	private get totalUsed(): number {
		return this.inputTotal + this.outputTotal;
	}

	private decision(): TokenBudgetDecision {
		if (this.totalUsed >= this.totalLimit) return "exhausted";
		if (this.badAttemptTotal >= this.maxBadAttempts) return "bad_attempt_cap";
		if (this.totalUsed >= this.regularLimit) return "reserve_required";
		return "continue";
	}
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`token budget ${name} must be a non-negative safe integer`);
	}
	return value;
}

export function resolveTokenBudget(renderedAgentJson: unknown): TokenBudgetConfig | null {
	if (renderedAgentJson === null || typeof renderedAgentJson !== "object") return null;
	const frontmatter = (renderedAgentJson as Record<string, unknown>).frontmatter;
	if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
		return null;
	}
	const raw = (frontmatter as Record<string, unknown>).tokenBudget;
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const record = raw as Record<string, unknown>;
	const totalTokens =
		typeof record.totalTokens === "number" ? record.totalTokens : Number(record.totalTokens);
	if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) return null;
	const regularRatio = record.regularRatio === undefined ? undefined : Number(record.regularRatio);
	const maxBadAttempts =
		record.maxBadAttempts === undefined ? undefined : Number(record.maxBadAttempts);
	return {
		totalTokens,
		...(regularRatio !== undefined ? { regularRatio } : {}),
		...(maxBadAttempts !== undefined ? { maxBadAttempts } : {}),
	};
}
