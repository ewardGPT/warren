// V1 attempt-3 Phase 3 — feed-classifier tests (SC-15 + SC-17).
//
// SC-17 LOAD-BEARING: SHIPPED cards are synthesized client-side from
// existing daemon events (queue close + git events). NO new daemon
// event types (SC-29).

import { describe, it, expect } from "vitest";
import { classifyFeed } from "../src/lib/feed-classifier.js";
import type { ActivityEvent } from "../src/hooks/useActivityFeed.js";

function evt(type: string, payload: Record<string, unknown> = {}, seq = 1): ActivityEvent {
  return {
    seq,
    type,
    payload,
    createdAt: new Date(seq * 1000).toISOString(),
    receivedAt: seq * 1000,
  };
}

describe("classifyFeed — SC-15 5 card types", () => {
  // OPR.0.4.4.19 FR-3: human-gate is a TIER, never a state. The prior test
  // pinned the dead `state === "human-gate"` branch (the daemon state enum
  // never contains it); the fixed branch fires on tier and classifies as
  // an approval card.
  it("queue.item.created with tier=human-gate → approval (FR-3 fixed branch)", () => {
    const cards = classifyFeed([evt("queue.item.created", { tier: "human-gate" })]);
    expect(cards[0]?.kind).toBe("approval");
  });

  it("state=human-gate alone (a tier value smuggled as state) no longer classifies — falls to progress", () => {
    const cards = classifyFeed([evt("queue.item.created", { state: "human-gate" })]);
    expect(cards[0]?.kind).toBe("progress");
  });

  it("queue.item.created with state=closeout-pending-ratify → approval", () => {
    const cards = classifyFeed([
      evt("queue.item.created", { state: "closeout-pending-ratify" }),
    ]);
    expect(cards[0]?.kind).toBe("approval");
  });

  it("queue.created daemon event → visible progress card", () => {
    const cards = classifyFeed([
      evt("queue.created", {
        qitemId: "qitem-20260507-abcdef12",
        sourceSession: "orch-lead@openrig-velocity",
        destinationSession: "driver@openrig-velocity",
        priority: "routine",
        tier: "mode2",
      }),
    ]);
    expect(cards[0]?.kind).toBe("progress");
    expect(cards[0]?.title).toBe("Queue item created: qitem-20260507-abcdef12");
    expect(cards[0]?.body).toContain(
      "orch-lead@openrig-velocity -> driver@openrig-velocity",
    );
    expect(cards[0]?.body).toContain("priority=routine / tier=mode2");
    expect(cards[0]?.authorSession).toBe("orch-lead@openrig-velocity");
  });

  it("queue.created for a human seat → action-required card", () => {
    const cards = classifyFeed([
      evt("queue.created", {
        qitemId: "qitem-human-review",
        sourceSession: "qa@openrig-dogfood",
        destinationSession: "human@host",
        priority: "urgent",
      }),
    ]);
    expect(cards[0]?.kind).toBe("action-required");
    expect(cards[0]?.body).toContain("qa@openrig-dogfood -> human@host");
  });

  it("queue.created closeout-pending-ratify for a human seat → approval card", () => {
    const cards = classifyFeed([
      evt("queue.created", {
        qitemId: "qitem-approval",
        sourceSession: "qa@openrig-dogfood",
        destinationSession: "human@host",
        state: "closeout-pending-ratify",
        priority: "urgent",
      }),
    ]);
    expect(cards[0]?.kind).toBe("approval");
  });

  it("queue.updated state=done → shipped card", () => {
    const cards = classifyFeed([
      evt("queue.updated", {
        qitemId: "qitem-shipped",
        actorSession: "driver@openrig-velocity",
        toState: "done",
      }),
    ]);
    expect(cards[0]?.kind).toBe("shipped");
    expect(cards[0]?.title).toBe("Queue item shipped: qitem-shipped");
    expect(cards[0]?.body).toContain("state=done");
  });

  it("queue.handed_off daemon event → visible progress card", () => {
    const cards = classifyFeed([
      evt("queue.handed_off", {
        qitemId: "qitem-20260507-handoff",
        fromSession: "driver@openrig-velocity",
        toSession: "guard@openrig-velocity",
      }),
    ]);
    expect(cards[0]?.kind).toBe("progress");
    expect(cards[0]?.title).toBe("Queue item handed off: qitem-20260507-handoff");
    expect(cards[0]?.body).toContain(
      "driver@openrig-velocity -> guard@openrig-velocity",
    );
    expect(cards[0]?.authorSession).toBe("driver@openrig-velocity");
  });

  it("qitem.closure_overdue daemon event → action-required", () => {
    const cards = classifyFeed([
      evt("qitem.closure_overdue", {
        qitemId: "qitem-20260507-overdue",
        destinationSession: "driver@openrig-velocity",
      }),
    ]);
    expect(cards[0]?.kind).toBe("action-required");
  });

  it("queue.item.shipped.closed → SHIPPED (client-synthesize per SC-17)", () => {
    const cards = classifyFeed([evt("queue.item.shipped.closed", {})]);
    expect(cards[0]?.kind).toBe("shipped");
  });

  it("workflow.* event → progress", () => {
    const cards = classifyFeed([evt("workflow.step.completed", {})]);
    expect(cards[0]?.kind).toBe("progress");
  });

  it("stream.* event → observation", () => {
    const cards = classifyFeed([evt("stream.item.emitted", {})]);
    expect(cards[0]?.kind).toBe("observation");
  });

  it("watchdog.* event → observation", () => {
    const cards = classifyFeed([evt("watchdog.alert", {})]);
    expect(cards[0]?.kind).toBe("observation");
  });

  it("git.* event → SHIPPED (client-synthesize per SC-17)", () => {
    const cards = classifyFeed([evt("git.tag.created", {})]);
    expect(cards[0]?.kind).toBe("shipped");
  });

  it("default unknown event → observation (nothing silently dropped)", () => {
    const cards = classifyFeed([evt("totally.unknown.event", {})]);
    expect(cards[0]?.kind).toBe("observation");
  });

  it("sorts cards newest-first by receivedAt", () => {
    const cards = classifyFeed([
      evt("workflow.step.a", {}, 1),
      evt("workflow.step.b", {}, 5),
      evt("workflow.step.c", {}, 3),
    ]);
    expect(cards.map((c) => c.source.seq)).toEqual([5, 3, 1]);
  });

  it("extracts authorSession from actor_session payload", () => {
    const cards = classifyFeed([
      evt("queue.item.updated", { actor_session: "driver@vel" }),
    ]);
    expect(cards[0]?.authorSession).toBe("driver@vel");
  });

  it("extracts authorSession from camelCase actor payload", () => {
    const cards = classifyFeed([
      evt("queue.updated", { actorSession: "driver@vel" }),
    ]);
    expect(cards[0]?.authorSession).toBe("driver@vel");
  });
});

// OPR.0.4.4.19 FR-1 (AC 3): feed-card titles read the event's summary.
describe("classifyFeed — FR-1 summary titles", () => {
  it("queue.created event with summary → card title is the summary, not a generic label", () => {
    const cards = classifyFeed([
      evt("queue.created", {
        qitemId: "qitem-20260704-cut",
        sourceSession: "pm@rig",
        destinationSession: "human-review@kernel",
        summary: "Approve the 0.4.4 cut",
      }),
    ]);
    expect(cards[0]?.title).toBe("Approve the 0.4.4 cut");
  });

  it("queue.created event with summary:null → generic label fallback preserved", () => {
    const cards = classifyFeed([
      evt("queue.created", {
        qitemId: "qitem-20260704-nosum",
        sourceSession: "a@rig",
        destinationSession: "b@rig",
        summary: null,
      }),
    ]);
    expect(cards[0]?.title).toBe("Queue item created: qitem-20260704-nosum");
  });
});
