// OPR.0.4.4.20 FR-8 — MISSION_BRIEF spine generation ACs.
// (Authored by the driver; executed by QA's gate run per the dev44 VM posture.)

import { describe, it, expect } from "vitest";
import { applyBriefSpine, renderBriefSpine } from "../src/domain/review/brief-spine.js";
import { MISSION_BRIEF_HEADERS } from "../src/domain/scope/scope-audit.js";
import { composeMissionReview, composeSliceReview } from "../src/domain/review/compose.js";
import type { SliceComposeInputs } from "../src/domain/review/compose.js";

const NOW = "2026-07-04T12:00:00.000Z";

function sliceInputs(name: string): SliceComposeInputs {
  return {
    slice: { name, id: null, title: name, missionId: "m" },
    readme: "## Intent\n\ni\n",
    prd: "## Mini-requirements\n\n1. m\n",
    proofMd: null,
    artifacts: [],
    lockedArtifacts: [],
    mediaRefs: [],
    proofDirExists: false,
    attention: [],
    agents: [],
    activeQitemPresent: false,
    git: { mainTip: "tip", mergeSha: null, mergeIsAncestorOfTip: null, candidateBehindTip: 0 },
    approval: { spec: null, delivery: null },
    nowIso: NOW,
  };
}

function mission() {
  return composeMissionReview({
    mission: { name: "m", id: null, title: "m", intent: "The founder's why." },
    slices: [{ review: composeSliceReview(sliceInputs("s1")), green: false }],
    missionAttention: [],
    agents: [],
    nowIso: NOW,
  });
}

const BRIEF = `---
id: X
---
# m — Brief

## What & why

Hand-authored prose the generator must never touch.

## Building

- stale hand line

## Progress

- stale hand line

## Proven

- stale hand line

## Needs you

- stale hand line

## Pointers

- hand-authored pointer, untouched
`;

describe("FR-8 brief spine", () => {
  it("derives the spine from the same composer queries (no second computation path) and carries intent verbatim", () => {
    const m = mission();
    expect(m.intent).toBe("The founder's why.");
    expect(m.briefSpine.progress).toContain("PLAN: 1");
    expect(m.briefSpine.needsYou).toContain("0 attention items");
    expect(renderBriefSpine(m)).toEqual(m.briefSpine); // same function, same strings
  });

  it("applies section-scoped: spine sections replaced, hand-authored sections byte-untouched, schema order preserved", () => {
    const m = mission();
    const applied = applyBriefSpine(BRIEF, m.briefSpine);
    expect(applied).not.toBeNull();
    expect(applied!).toContain("Hand-authored prose the generator must never touch.");
    expect(applied!).toContain("hand-authored pointer, untouched");
    expect(applied!).not.toContain("stale hand line");
    // The pinned exact-order H2 schema survives (the scope-audit contract).
    const headers = [...applied!.matchAll(/^##\s+(.+?)\s*$/gm)].map((x) => x[1]);
    expect(headers).toEqual(MISSION_BRIEF_HEADERS);
  });

  it("refuses to guess-rewrite a brief that does not carry the pinned schema", () => {
    const m = mission();
    expect(applyBriefSpine("# not a brief\n\n## Random\n\nx\n", m.briefSpine)).toBeNull();
    // Wrong order is also refused — order is part of the schema.
    const wrongOrder = BRIEF.replace("## Building", "## TEMP").replace("## Progress", "## Building").replace("## TEMP", "## Progress");
    expect(applyBriefSpine(wrongOrder, m.briefSpine)).toBeNull();
  });

  it("is idempotent: applying the same spine twice yields identical bytes", () => {
    const m = mission();
    const once = applyBriefSpine(BRIEF, m.briefSpine)!;
    const twice = applyBriefSpine(once, m.briefSpine)!;
    expect(twice).toBe(once);
  });
});
