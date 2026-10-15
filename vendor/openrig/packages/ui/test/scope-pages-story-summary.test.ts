import { describe, expect, it } from "vitest";
import { toStoryInput } from "../src/components/project/ScopePages.js";
import type { QueueItemDetail } from "../src/hooks/useSlices.js";

// OPR.0.4.1.18 QA-blocking regression: toStoryInput previously hardcoded
// summary: null, so the Story row rendered the body fallback even though the
// API payload carried the authored summary. This guards the wiring directly
// (the bug site), complementing the model-level deriveSummary tests in
// story-graph-model.test.ts.

function detail(partial: Partial<QueueItemDetail> & { qitemId: string }): QueueItemDetail {
  return {
    tsCreated: "2026-06-23T02:00:00.000Z",
    tsUpdated: "2026-06-23T02:00:00.000Z",
    sourceSession: "a@rig",
    destinationSession: "b@rig",
    state: "done",
    priority: "routine",
    tier: null,
    tags: null,
    body: "agent-speak body",
    summary: null,
    ...partial,
  } as QueueItemDetail;
}

describe("OPR.0.4.1.18 — ScopePages.toStoryInput wires summary through (regression)", () => {
  it("passes the authored summary through, NOT a hardcoded null", () => {
    const input = toStoryInput(detail({ qitemId: "A", summary: "Human-readable summary." }));
    expect(input.summary).toBe("Human-readable summary.");
  });

  it("passes null through when the qitem has no summary (degrade path stays intact)", () => {
    const input = toStoryInput(detail({ qitemId: "B", summary: null }));
    expect(input.summary).toBeNull();
  });

  it("keeps the full agent-speak body as the source of truth", () => {
    const input = toStoryInput(detail({ qitemId: "C", body: "full agent body\nline two", summary: "S" }));
    expect(input.body).toBe("full agent body\nline two");
  });
});
