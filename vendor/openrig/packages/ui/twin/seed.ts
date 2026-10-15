// OPR.0.4.1.11.1 (FR-2) — cache-seed seam. Seed the react-query cache under the EXACT
// queryKeys the real hooks use (grounded from packages/ui/src/hooks), so the real App
// renders fully from dummy data with NO daemon and NO fetch. Mutations are inert.
//
// Gate-0 scope: the Dashboard surface (rigs/summary + ps + spec-library). Per-rig node
// inventory is also seeded so a topology surface works without new wiring. The FULL build
// (post Gate-0) extends this to the complete queryKey enumeration (D-4).

import type { QueryClient } from "@tanstack/react-query";
import {
  rigSummary,
  psEntries,
  specLibrary,
  nodeInventoryByRig,
  rigGraphByRig,
  nodeDetailByKey,
  sessionPreviewByName,
} from "./fixtures.js";

// Line counts the preview surfaces poll with (node-details=100, others 50/80). Seed all so
// first paint is instant regardless of surface; the fetch stub then serves any other N.
const PREVIEW_LINE_COUNTS = [50, 80, 100, 200];

export function seedTwinCache(qc: QueryClient): void {
  // Dashboard + AppShell core surface.
  qc.setQueryData(["rigs", "summary"], rigSummary);
  qc.setQueryData(["ps"], psEntries);
  qc.setQueryData(["spec-library", "all"], specLibrary);
  // Spec Library filtered views (Library surface + node-details "agent" lens).
  qc.setQueryData(["spec-library", "agent"], specLibrary.filter((s) => s.kind === "agent"));

  // Per-rig topology surfaces, keyed by rig id.
  for (const rig of rigSummary) {
    qc.setQueryData(["rig", rig.id, "nodes"], nodeInventoryByRig[rig.id] ?? []);
    // Hard surface 1 — topology GRAPH (xyflow nodes/edges).
    qc.setQueryData(["rig", rig.id, "graph"], rigGraphByRig[rig.id] ?? { nodes: [], edges: [] });
  }

  // Hard surface 2 — LIVE NODE DETAILS, keyed ["rig", rigId, "nodes", logicalId].
  for (const detail of Object.values(nodeDetailByKey)) {
    qc.setQueryData(["rig", detail.rigId, "nodes", detail.logicalId], detail);
  }

  // Embedded live-terminal preview (session-keyed), seeded across the polled line counts.
  for (const preview of Object.values(sessionPreviewByName)) {
    for (const n of PREVIEW_LINE_COUNTS) {
      qc.setQueryData(["session-preview", preview.sessionName, n], { ...preview, lines: n });
    }
  }
}
