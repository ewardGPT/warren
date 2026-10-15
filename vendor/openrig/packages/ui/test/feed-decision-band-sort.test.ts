// OPR.0.3.3.20 — manage-by-exception ordering (AC-1).
//
// sortFeedByDecisionBand lifts ALL action-required/approval cards above
// progress/observation/shipped on the classified/merged output, preserving
// newest-first WITHIN each band. A two-band stable partition — NOT a
// priority-ranking engine (no score fields, no card mutation).

import { describe, it, expect } from "vitest";
import { sortFeedByDecisionBand, type FeedCard, type FeedCardKind } from "../src/lib/feed-classifier.js";
import type { ActivityEvent } from "../src/hooks/useActivityFeed.js";

function card(id: string, kind: FeedCardKind, receivedAt: number): FeedCard {
  return {
    id,
    kind,
    title: id,
    receivedAt,
    createdAt: new Date(receivedAt).toISOString(),
    source: { seq: receivedAt, type: "test", payload: {}, createdAt: new Date(receivedAt).toISOString(), receivedAt } as ActivityEvent,
  };
}

describe("sortFeedByDecisionBand (AC-1)", () => {
  it("DISCRIMINATOR: an event-only action-required card OLDER than a progress card still sorts above it", () => {
    const oldDecision = card("old-decision", "action-required", 1000);
    const newProgress = card("new-progress", "progress", 9000);

    const sorted = sortFeedByDecisionBand([newProgress, oldDecision]);

    expect(sorted.map((c) => c.id)).toEqual(["old-decision", "new-progress"]);
  });

  it("lifts both action-required AND approval above progress/observation/shipped", () => {
    const cards = [
      card("obs", "observation", 8000),
      card("appr", "approval", 2000),
      card("ship", "shipped", 7000),
      card("act", "action-required", 1000),
      card("prog", "progress", 9000),
    ];

    const sorted = sortFeedByDecisionBand(cards);
    const kinds = sorted.map((c) => c.kind);

    // The decision band is entirely before the first non-decision card.
    const firstNonDecision = kinds.findIndex((k) => k !== "action-required" && k !== "approval");
    expect(kinds.slice(0, firstNonDecision)).toEqual(expect.arrayContaining(["approval", "action-required"]));
    expect(kinds.slice(firstNonDecision)).not.toContain("action-required");
    expect(kinds.slice(firstNonDecision)).not.toContain("approval");
  });

  it("preserves newest-first WITHIN each band", () => {
    const cards = [
      card("act-old", "action-required", 1000),
      card("act-new", "action-required", 5000),
      card("prog-old", "progress", 2000),
      card("prog-new", "progress", 9000),
    ];

    const sorted = sortFeedByDecisionBand(cards);

    expect(sorted.map((c) => c.id)).toEqual(["act-new", "act-old", "prog-new", "prog-old"]);
  });

  it("stays a sort: returns the SAME card objects with no added fields (no ranking score)", () => {
    const input = [card("a", "action-required", 1000), card("p", "progress", 2000)];
    const inputKeys = input.map((c) => Object.keys(c).sort().join(","));

    const sorted = sortFeedByDecisionBand(input);

    for (const c of sorted) {
      expect(input).toContain(c); // same object references — no copies, no decoration
    }
    expect(sorted.map((c) => Object.keys(c).sort().join(","))).toEqual(
      expect.arrayContaining(inputKeys),
    );
  });

  it("is a no-op ordering change when there are no decision cards", () => {
    const cards = [card("p1", "progress", 9000), card("o1", "observation", 5000), card("s1", "shipped", 1000)];
    const sorted = sortFeedByDecisionBand(cards);
    expect(sorted.map((c) => c.id)).toEqual(["p1", "o1", "s1"]);
  });
});
