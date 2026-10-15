// OPR.0.4.1.11.2 (FR-5) — deterministic artifact naming + placement for twin captures.
// The capture wrapper (twin:capture) must place per-slice artifacts under a stable,
// collision-safe, DETERMINISTIC layout so an artifact attaches to an IMPL-PRD and the
// same input always yields the same paths (feeds FR-2's "deterministic naming" + D-1).
// Convention grounded in the existing digital-twin/ practice (<surface>.intent.png /
// .intent.html, per-slice folder); the exact root path + normalize-existing decision are
// escalated (Open-Q3) — this resolver takes outRoot as a parameter so the policy is external.
import { describe, it, expect } from "vitest";
import { resolveArtifactPaths } from "../twin/capture/artifact-paths.js";

describe("resolveArtifactPaths (OPR.0.4.1.11.2 FR-5: deterministic artifact naming + placement)", () => {
  const outRoot = "/work/digital-twin";

  it("places a surface's artifacts under outRoot/<slice>/ as .intent.html / .intent.png / .change.diff", () => {
    const p = resolveArtifactPaths({ slice: "demo-slice", surface: "Topology Graph", outRoot });
    expect(p.dir).toBe("/work/digital-twin/demo-slice");
    expect(p.intentHtml).toBe("/work/digital-twin/demo-slice/topology-graph.intent.html");
    expect(p.intentPng).toBe("/work/digital-twin/demo-slice/topology-graph.intent.png");
    expect(p.changeDiff).toBe("/work/digital-twin/demo-slice/topology-graph.change.diff");
    // FR-6: the proof-side (real shipped UI) artifact pairs with intent by the SAME base — directly
    // comparable side by side, identical format, only .intent vs .proof differ.
    expect(p.proofPng).toBe("/work/digital-twin/demo-slice/topology-graph.proof.png");
  });

  it("slugifies a route-shaped surface name into a filesystem-safe base (slashes/underscores/case)", () => {
    const p = resolveArtifactPaths({ slice: "demo-slice", surface: "/topology/rig/rig_delivery", outRoot });
    expect(p.intentPng).toBe("/work/digital-twin/demo-slice/topology-rig-rig-delivery.intent.png");
  });

  it("is deterministic — identical inputs yield identical paths", () => {
    const a = resolveArtifactPaths({ slice: "demo-slice", surface: "Dash Board", outRoot });
    const b = resolveArtifactPaths({ slice: "demo-slice", surface: "Dash Board", outRoot });
    expect(a).toEqual(b);
  });

  // pm + brief1-curator RATIFIED the path as digital-twin/<slice-id>/ where slice-id is the
  // dotted OPR id (e.g. opr-0.4.1.11.2). The slice folder must PRESERVE dots (filesystem-safe);
  // only the surface base is fully slugified. (Surface tests above already lock the surface rule.)
  it("preserves the dotted slice-id as the per-slice folder (ratified: digital-twin/<slice-id>/)", () => {
    const p = resolveArtifactPaths({ slice: "opr-0.4.1.11.2", surface: "Topology Graph", outRoot });
    expect(p.dir).toBe("/work/digital-twin/opr-0.4.1.11.2");
    expect(p.intentPng).toBe("/work/digital-twin/opr-0.4.1.11.2/topology-graph.intent.png");
  });

  it("lowercases + sanitizes the slice-id while preserving its dots", () => {
    const p = resolveArtifactPaths({ slice: "OPR-0.4.1.11.2", surface: "x", outRoot });
    expect(p.dir).toBe("/work/digital-twin/opr-0.4.1.11.2");
  });
});
