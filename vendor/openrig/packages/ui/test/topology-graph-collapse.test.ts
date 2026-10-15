// OPR.0.4.2.17 — topology graph "collapse to one coordinate" regression.
//
// Bug: on the 30s refetch the multi-rig graph collapsed every pod+agent node
// onto a single coordinate. Root: hybrid-layout.ts layoutWithDagre fell back to
// a blanket `{x:0,y:0}` for any node dagre returned missing/degenerate, so a
// degenerate refetch tick stacked everything on the origin. Fix: never collapse
// — on degenerate dagre output lay a deterministic NON-overlapping fallback so
// positions stay DISTINCT. These assert that invariant at the layout layer.

import { describe, expect, it } from "vitest";
import { __test_internals, layoutHybridRig } from "../src/lib/hybrid-layout.js";

const { resolveDagrePositions } = __test_internals;
const ITEMS = [
  { id: "a", width: 200, height: 100 },
  { id: "b", width: 200, height: 100 },
  { id: "c", width: 200, height: 100 },
];
const OPTS = { nodesep: 34, ranksep: 34 };

function distinctCount(positions: Map<string, { x: number; y: number }>): number {
  return new Set([...positions.values()].map((p) => `${p.x},${p.y}`)).size;
}

describe("OPR.0.4.2.17 resolveDagrePositions — never collapse to one coordinate", () => {
  it("MISSING dagre nodes (lookup returns undefined) -> deterministic DISTINCT fallback, not all {0,0}", () => {
    const positions = resolveDagrePositions(ITEMS, () => undefined, "LR", OPTS);
    expect(distinctCount(positions)).toBe(ITEMS.length);
  });

  it("ALL-IDENTICAL dagre coords (degenerate) -> deterministic DISTINCT fallback", () => {
    const positions = resolveDagrePositions(ITEMS, () => ({ x: 5, y: 5 }), "LR", OPTS);
    expect(distinctCount(positions)).toBe(ITEMS.length);
  });

  it("NON-FINITE coords (NaN) -> deterministic DISTINCT fallback", () => {
    const positions = resolveDagrePositions(ITEMS, () => ({ x: NaN, y: 0 }), "LR", OPTS);
    expect(distinctCount(positions)).toBe(ITEMS.length);
  });

  it("HEALTHY dagre coords pass through unchanged (no spurious fallback)", () => {
    const real: Record<string, { x: number; y: number }> = {
      a: { x: 0, y: 0 },
      b: { x: 300, y: 0 },
      c: { x: 600, y: 0 },
    };
    const positions = resolveDagrePositions(ITEMS, (id) => real[id], "LR", OPTS);
    expect(positions.get("a")).toEqual({ x: 0, y: 0 });
    expect(positions.get("b")).toEqual({ x: 300, y: 0 });
    expect(positions.get("c")).toEqual({ x: 600, y: 0 });
  });

  it("single item is never treated as degenerate (one position is fine)", () => {
    const positions = resolveDagrePositions([ITEMS[0]!], () => ({ x: 7, y: 7 }), "LR", OPTS);
    expect(positions.get("a")).toEqual({ x: 7, y: 7 });
  });
});

describe("OPR.0.4.2.17 layoutHybridRig — every pod lays at a distinct position (no collapse)", () => {
  it("a product-team-shaped multi-pod rig keeps the 3 pods at distinct coordinates", () => {
    const layout = layoutHybridRig({
      rigId: "rig-pt",
      collapsed: false,
      nodes: [
        { id: "pod-orch", type: "podGroup", position: { x: 0, y: 0 }, data: { podNamespace: "orch" } },
        { id: "orch.lead", type: "rigNode", parentId: "pod-orch", position: { x: 0, y: 0 }, data: { logicalId: "orch.lead" } },
        { id: "orch.peer", type: "rigNode", parentId: "pod-orch", position: { x: 0, y: 0 }, data: { logicalId: "orch.peer" } },
        { id: "pod-dev", type: "podGroup", position: { x: 0, y: 0 }, data: { podNamespace: "dev" } },
        { id: "dev.impl", type: "rigNode", parentId: "pod-dev", position: { x: 0, y: 0 }, data: { logicalId: "dev.impl" } },
        { id: "dev.qa", type: "rigNode", parentId: "pod-dev", position: { x: 0, y: 0 }, data: { logicalId: "dev.qa" } },
        { id: "dev.design", type: "rigNode", parentId: "pod-dev", position: { x: 0, y: 0 }, data: { logicalId: "dev.design" } },
        { id: "pod-rev", type: "podGroup", position: { x: 0, y: 0 }, data: { podNamespace: "rev" } },
        { id: "rev.r1", type: "rigNode", parentId: "pod-rev", position: { x: 0, y: 0 }, data: { logicalId: "rev.r1" } },
        { id: "rev.r2", type: "rigNode", parentId: "pod-rev", position: { x: 0, y: 0 }, data: { logicalId: "rev.r2" } },
      ],
      edges: [],
    });
    const pods = layout.nodes.filter((n) => n.type === "podGroup");
    expect(pods).toHaveLength(3);
    const podKeys = new Set(pods.map((p) => `${Math.round(p.position.x)},${Math.round(p.position.y)}`));
    expect(podKeys.size).toBe(3);
  });
});
