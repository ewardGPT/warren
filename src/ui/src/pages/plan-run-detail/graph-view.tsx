import type { PlanRunGraph } from "@/api/types.ts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";

export function PlanRunGraphView({ graph }: { graph: PlanRunGraph }) {
	const nodes = graph.nodes.filter((node) => node.kind !== "parent-run");
	const parent = graph.nodes.find((node) => node.kind === "parent-run");
	return (
		<Card>
			<CardHeader>
				<CardTitle>Execution graph</CardTitle>
			</CardHeader>
			<CardContent>
				{parent ? <GraphNode node={parent} /> : null}
				{nodes.map((node, index) => (
					<div key={node.id}>
						{index > 0 || parent ? <GraphConnector /> : null}
						<GraphNode node={node} />
					</div>
				))}
			</CardContent>
		</Card>
	);
}

function GraphConnector() {
	return <div className="py-1 text-center text-(--color-muted-foreground)" aria-hidden="true">↓</div>;
}

function GraphNode({ node }: { node: PlanRunGraph["nodes"][number] }) {
	return <div className="rounded-md border border-(--color-border) bg-(--color-muted) p-3"><div className="flex items-center justify-between gap-2"><span className="font-mono text-xs">{node.label}</span><span className="text-xs text-(--color-muted-foreground)">{node.state}</span></div></div>;
}
