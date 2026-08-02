import { describe, expect, test } from "bun:test";
import type { PlanRunChildRow, PlanRunRow } from "../db/schema.ts";
import { buildPlanRunGraph } from "./graph.ts";

const planRun = (parentRunId: string | null = null) =>
	({
		id: "planRun_1",
		planId: "pl_1",
		projectId: "p_1",
		agentName: "sapling",
		promptTemplate: "work",
		ref: null,
		providerOverride: null,
		modelOverride: null,
		dispatcherHandle: "operator",
		trigger: "manual",
		plotId: null,
		parentRunId,
		state: "running",
		failureReason: null,
		createdAt: "2026-08-02T00:00:00Z",
		startedAt: null,
		endedAt: null,
	}) as PlanRunRow;

const child = (seq: number, state: PlanRunChildRow["state"] = "pending") =>
	({
		planRunId: "planRun_1",
		seq,
		seedId: `seed-${seq}`,
		runId: null,
		executionProjectId: null,
		state,
		createdAt: "2026-08-02T00:00:00Z",
		updatedAt: "2026-08-02T00:00:00Z",
		startedAt: null,
		endedAt: null,
		prMergedAt: null,
		failureReason: null,
	}) as PlanRunChildRow;

describe("buildPlanRunGraph", () => {
	test("emits truthful dispatch and sequential dependency edges", () => {
		const graph = buildPlanRunGraph(planRun(), [child(2), child(1, "merged")]);
		expect(graph.edges).toEqual([
			{ from: "plan:planRun_1", to: "child:planRun_1:1", kind: "dispatch" },
			{ from: "child:planRun_1:1", to: "child:planRun_1:2", kind: "sequential-dependency" },
		]);
	});

	test("represents a parent merge gate without inventing unrelated edges", () => {
		const graph = buildPlanRunGraph(planRun("run_parent"), [child(1)]);
		expect(graph.nodes.some((node) => node.id === "run:run_parent")).toBe(true);
		expect(graph.edges[0]).toEqual({
			from: "run:run_parent",
			to: "plan:planRun_1",
			kind: "parent-gate",
		});
		expect(graph.edges).toHaveLength(2);
	});
});
