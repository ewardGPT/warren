import type { PlanRunChildRow, PlanRunRow } from "../db/schema.ts";

export type PlanRunGraphNodeKind = "plan" | "parent-run" | "child";
export type PlanRunGraphEdgeKind = "parent-gate" | "dispatch" | "sequential-dependency";

export interface PlanRunGraphNode {
	readonly id: string;
	readonly kind: PlanRunGraphNodeKind;
	readonly label: string;
	readonly state: string;
	readonly seq?: number;
}

export interface PlanRunGraphEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: PlanRunGraphEdgeKind;
}

export interface PlanRunGraph {
	readonly nodes: readonly PlanRunGraphNode[];
	readonly edges: readonly PlanRunGraphEdge[];
}

/** Build only edges that correspond to coordinator control flow. */
export function buildPlanRunGraph(
	planRun: PlanRunRow,
	children: readonly PlanRunChildRow[],
): PlanRunGraph {
	const planNodeId = `plan:${planRun.id}`;
	const nodes: PlanRunGraphNode[] = [
		{ id: planNodeId, kind: "plan", label: planRun.planId, state: planRun.state },
	];
	const edges: PlanRunGraphEdge[] = [];

	if (planRun.parentRunId !== null) {
		const parentNodeId = `run:${planRun.parentRunId}`;
		nodes.push({
			id: parentNodeId,
			kind: "parent-run",
			label: planRun.parentRunId,
			state: "merge-gate",
		});
		edges.push({ from: parentNodeId, to: planNodeId, kind: "parent-gate" });
	}

	const ordered = [...children].sort((a, b) => a.seq - b.seq);
	for (const [index, child] of ordered.entries()) {
		const childNodeId = `child:${planRun.id}:${child.seq}`;
		nodes.push({
			id: childNodeId,
			kind: "child",
			label: child.seedId,
			state: child.state,
			seq: child.seq,
		});
		edges.push({
			from: index === 0 ? planNodeId : `child:${planRun.id}:${ordered[index - 1]?.seq}`,
			to: childNodeId,
			kind: index === 0 ? "dispatch" : "sequential-dependency",
		});
	}

	return { nodes, edges };
}
