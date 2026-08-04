import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { planRunsApi, projectsApi } from "@/api/client.ts";
import type { CapabilityName, PlanRunListItem, PlanRunRow, PlanRunState } from "@/api/types.ts";
import { OperatorOnly, useOperatorHint } from "@/components/OperatorOnly.tsx";
import { PlanRunStateBadge } from "@/components/PlanRunStateBadge.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { responsiveTrailingControl } from "@/components/ui/responsive.ts";
import { SortableTableHead } from "@/components/ui/sortable-table-head.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { type Comparator, compareStrings, useClientSort } from "@/hooks/use-client-sort.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatChildStateCountsFromCounts } from "@/lib/labels.ts";
import { relativeTime } from "@/lib/utils.ts";
import { formatCostUsd } from "./RunDetail.tsx";
import { ReadyPlansView } from "./ready-plans.tsx";

type PlanRunsTab = "plan-runs" | "ready";

/**
 * `GET /projects/:id/ready-plans` is readOperator — it surfaces project
 * internals — so the tab that renders it is dropped for a spectator rather
 * than left to 403 (warren-f53e / pl-b82d step 19).
 */
const READY_TAB_CAPABILITY: CapabilityName = "readOperator";

type PlanRunSortKey = "state" | "id" | "planId" | "project" | "agentName" | "startedAt";

const TABS: { label: string; value: PlanRunsTab }[] = [
	{ label: "Plan runs", value: "plan-runs" },
	{ label: "Ready to dispatch", value: "ready" },
];

const STATE_FILTERS: { label: string; value: "all" | PlanRunState }[] = [
	{ label: "All", value: "all" },
	{ label: "Queued", value: "queued" },
	{ label: "Running", value: "running" },
	{ label: "Succeeded", value: "succeeded" },
	{ label: "Failed", value: "failed" },
	{ label: "Cancelled", value: "cancelled" },
];

export function PlanRunsPage() {
	const caps = useCapabilities();
	const [tab, setTab] = useState<PlanRunsTab>("plan-runs");
	const [stateFilter, setStateFilter] = useState<"all" | PlanRunState>("all");
	const [projectFilter, setProjectFilter] = useState<string>("");

	const planRuns = useQuery({
		queryKey: ["plan-runs", projectFilter, stateFilter],
		queryFn: ({ signal }) =>
			planRunsApi.list(
				{
					...(projectFilter.length > 0 ? { project: projectFilter } : {}),
					...(stateFilter !== "all" ? { state: stateFilter } : {}),
				},
				signal,
			),
		refetchInterval: 5000,
	});

	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});

	const projectIndex = useMemo(() => {
		const m = new Map<string, string>();
		for (const p of projects.data?.projects ?? []) m.set(p.id, p.gitUrl);
		return m;
	}, [projects.data]);

	const comparators = useMemo<Record<PlanRunSortKey, Comparator<PlanRunRow>>>(
		() => ({
			state: (a, b) => compareStrings(a.state, b.state),
			id: (a, b) => compareStrings(a.id, b.id),
			planId: (a, b) => compareStrings(a.planId, b.planId),
			project: (a, b) =>
				compareStrings(
					projectIndex.get(a.projectId) ?? a.projectId,
					projectIndex.get(b.projectId) ?? b.projectId,
				),
			agentName: (a, b) => compareStrings(a.agentName, b.agentName),
			startedAt: (a, b) => compareStrings(a.startedAt, b.startedAt),
		}),
		[projectIndex],
	);
	const { sorted, sort, onSort } = useClientSort(planRuns.data?.planRuns ?? [], comparators, {
		initialKey: "startedAt",
		initialDirection: "desc",
		defaultDirections: { startedAt: "desc" },
	});

	const emptyHint = useOperatorHint("Dispatch one above.");
	const canReadReady = caps.can(READY_TAB_CAPABILITY);
	const visibleTabs = canReadReady ? TABS : TABS.filter((t) => t.value !== "ready");
	const activeTab = tab === "ready" && !canReadReady ? "plan-runs" : tab;

	return (
		<div className="space-y-6">
			<PageHeader
				title="Plan runs"
				description="Serial execution of a seeds plan — one warren run per open child, in order."
				actions={
					<OperatorOnly>
						<Link to="/plan-runs/new">
							<Button>Dispatch a plan run</Button>
						</Link>
					</OperatorOnly>
				}
			/>

			<div className="flex flex-wrap items-center gap-2">
				{visibleTabs.map((t) => (
					<button
						key={t.value}
						type="button"
						onClick={() => setTab(t.value)}
						className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
							activeTab === t.value
								? "bg-(--color-primary) text-(--color-primary-foreground)"
								: "bg-(--color-card) hover:bg-(--color-accent)"
						}`}
					>
						{t.label}
					</button>
				))}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				{activeTab === "plan-runs"
					? STATE_FILTERS.map((f) => (
							<button
								key={f.value}
								type="button"
								onClick={() => setStateFilter(f.value)}
								className={`rounded-full border px-3 py-1 text-xs transition-colors ${
									stateFilter === f.value
										? "bg-(--color-primary) text-(--color-primary-foreground)"
										: "bg-(--color-card) hover:bg-(--color-accent)"
								}`}
							>
								{f.label}
							</button>
						))
					: null}
				<select
					value={projectFilter}
					onChange={(e) => setProjectFilter(e.target.value)}
					className={`h-8 rounded-md border bg-(--color-card) px-2 text-xs ${responsiveTrailingControl}`}
				>
					<option value="">All projects</option>
					{projects.data?.projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.gitUrl}
						</option>
					))}
				</select>
			</div>

			{activeTab === "ready" ? (
				<ReadyPlansView projectId={projectFilter} />
			) : (
				<Card>
					<CardHeader>
						<CardTitle>{planRuns.data?.planRuns.length ?? 0} plan runs</CardTitle>
					</CardHeader>
					<CardContent className="p-0">
						{planRuns.isLoading ? (
							<div className="p-6">
								<Spinner label="Loading plan runs" />
							</div>
						) : planRuns.isError ? (
							<div className="p-6">
								<Alert variant="danger" title="Failed to load plan runs">
									{formatError(planRuns.error)}
								</Alert>
							</div>
						) : planRuns.data?.planRuns.length === 0 ? (
							<EmptyState title="No plan runs match this filter" description={emptyHint} />
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<SortableTableHead columnKey="state" sort={sort} onSort={onSort}>
											State
										</SortableTableHead>
										<SortableTableHead columnKey="id" sort={sort} onSort={onSort}>
											ID
										</SortableTableHead>
										<SortableTableHead columnKey="planId" sort={sort} onSort={onSort}>
											Plan
										</SortableTableHead>
										<SortableTableHead columnKey="project" sort={sort} onSort={onSort}>
											Project
										</SortableTableHead>
										<SortableTableHead columnKey="agentName" sort={sort} onSort={onSort}>
											Agent
										</SortableTableHead>
										<TableHead className="whitespace-nowrap">Children</TableHead>
										<TableHead className="whitespace-nowrap">Cost</TableHead>
										<SortableTableHead columnKey="startedAt" sort={sort} onSort={onSort}>
											Started
										</SortableTableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{sorted.map((pr) => (
										<PlanRunListRow
											key={pr.id}
											planRun={pr}
											projectLabel={projectIndex.get(pr.projectId) ?? pr.projectId}
										/>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			)}
		</div>
	);
}

function PlanRunListRow({
	planRun,
	projectLabel,
}: {
	planRun: PlanRunListItem;
	projectLabel: string;
}) {
	const counts = formatChildStateCountsFromCounts(
		planRun.summary.childCounts,
		planRun.summary.childTotal,
	);
	return (
		<TableRow>
			<TableCell>
				<PlanRunStateBadge state={planRun.state} />
			</TableCell>
			<TableCell>
				<Link
					to={`/plan-runs/${encodeURIComponent(planRun.id)}`}
					className="font-mono text-xs underline-offset-2 hover:underline"
				>
					{planRun.id}
				</Link>
			</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs">{planRun.planId}</TableCell>
			<TableCell className="whitespace-nowrap font-mono text-xs">{projectLabel}</TableCell>
			<TableCell className="whitespace-nowrap">{planRun.agentName}</TableCell>
			<TableCell className="text-xs text-(--color-muted-foreground)" title={counts.title}>
				{counts.text}
			</TableCell>
			<TableCell
				className="whitespace-nowrap font-mono text-xs text-(--color-muted-foreground)"
				title={
					planRun.summary.costPricedCount === 0
						? "No child runs have a recorded cost yet"
						: `${planRun.summary.costPricedCount} of ${planRun.summary.childTotal} child runs have a recorded cost`
				}
			>
				{planRun.summary.costPricedCount === 0 ? "—" : formatCostUsd(planRun.summary.costTotalUsd)}
			</TableCell>
			<TableCell className="whitespace-nowrap text-(--color-muted-foreground)">
				{relativeTime(planRun.startedAt)}
			</TableCell>
		</TableRow>
	);
}
