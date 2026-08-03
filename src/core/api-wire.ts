/** Shared response and analytics wire shapes used by SDK, server, and UI. */
import type { CloneKind, PreviewState, RunFailureReason, RunMode, RunState } from "./wire.ts";

export interface RunRow {
	id: string;
	agentName: string;
	projectId: string | null;
	burrowId?: string | null;
	burrowRunId?: string | null;
	seedId: string | null;
	parentRunId: string | null;
	cloneKind: CloneKind | null;
	mode: RunMode;
	renderedAgentJson: unknown;
	state: RunState;
	failureReason: RunFailureReason | null;
	startedAt: string | null;
	endedAt: string | null;
	prompt: string;
	trigger: string;
	prUrl: string | null;
	targetBranch: string | null;
	salvageRef: string | null;
	salvagePath: string | null;
	costUsd: number | null;
	tokensInput: number | null;
	tokensOutput: number | null;
	tokensCacheRead: number | null;
	tokensCacheWrite: number | null;
	previewState: PreviewState | null;
	previewPort: number | null;
	previewStartedAt: string | null;
	previewLastHitAt: string | null;
	previewFailureMessage?: string | null;
}

export interface TokenBreakdown {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
}

export interface TokenDayBucket extends TokenBreakdown {
	readonly date: string;
}

export interface DimensionTokenSeries {
	readonly key: string;
	readonly series: readonly TokenDayBucket[];
}

export interface RunAnalyticsTokensSection {
	readonly totals: TokenBreakdown;
	readonly byModel: readonly { readonly key: string; readonly tokens: TokenBreakdown }[];
	readonly byProvider: readonly { readonly key: string; readonly tokens: TokenBreakdown }[];
	readonly timeSeries: readonly TokenDayBucket[];
	readonly byModelTimeSeries: readonly DimensionTokenSeries[];
	readonly byProviderTimeSeries: readonly DimensionTokenSeries[];
}
