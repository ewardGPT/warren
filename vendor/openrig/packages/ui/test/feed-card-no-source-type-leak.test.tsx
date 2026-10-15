// OPR.0.4.1.27 real-data fidelity — FeedCard must NEVER render the internal
// card.source.type string user-visible. The attention/needs-input projections
// wrap real data in synthetic ActivityEvents whose `type` is an internal
// wrapper code (queue.attention.synthetic / activity.needs_input.synthetic).
// Two old leak sites: FeedCard.tsx :554 rendered the raw source.type as the
// author fallback (needs-input has no authorSession), and :460 fed source.type
// to eventToken whose unknown-kind fallback humanized the code into a visible
// "...Synthetic" mark. This pins the invariant: no "synthetic" / no raw type
// in the rendered DOM, while the human title still renders.

import type { ReactNode } from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeedCard } from "../src/components/for-you/FeedCard.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";

function withQueryClient(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function makeCard(overrides: Partial<FeedCardModel> = {}): FeedCardModel {
  return {
    id: "queue.enqueued-1",
    kind: "progress",
    title: "Sample card",
    body: "Sample body",
    receivedAt: 1234567890,
    createdAt: new Date(1234567890 * 1000).toISOString(),
    source: { seq: 1, type: "queue.enqueued", payload: {} } as unknown as FeedCardModel["source"],
    ...overrides,
  };
}

describe("FeedCard — no internal source.type leak (OPR.0.4.1.27 real-data fidelity)", () => {
  afterEach(() => cleanup());

  it("needs-input synthetic card (no authorSession) does NOT render the raw source.type or 'synthetic'", () => {
    const { container } = withQueryClient(
      <FeedCard
        card={makeCard({
          id: "activity-needs-input-rig_delivery-orch.lead",
          kind: "action-required",
          title: "orch.lead needs input",
          source: { seq: -1, type: "activity.needs_input.synthetic", payload: {} } as unknown as FeedCardModel["source"],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/synthetic/i);
    expect(text).not.toContain("activity.needs_input.synthetic");
    // human title still renders
    expect(text).toContain("orch.lead needs input");
  });

  it("queue-attention synthetic card does NOT render 'synthetic' (eventToken token scrubbed)", () => {
    const { container } = withQueryClient(
      <FeedCard
        card={makeCard({
          id: "queue-attention-qitem-abc",
          kind: "approval",
          title: "Founder sign-off needed: 0.4.1 release brief",
          source: { seq: -1, type: "queue.attention.synthetic", payload: {} } as unknown as FeedCardModel["source"],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/synthetic/i);
    expect(text).not.toContain("queue.attention.synthetic");
    expect(text).toContain("Founder sign-off needed");
  });

  it("a real event-derived card still renders its meaningful event token (no over-scrub)", () => {
    const { container } = withQueryClient(
      <FeedCard card={makeCard({ kind: "shipped", title: "Slice merged", source: { seq: 7, type: "queue.transition.done", payload: {} } as unknown as FeedCardModel["source"] })} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/synthetic/i);
    // the real event token still surfaces (eventToken maps transition.done -> "Marked done")
    expect(text).toContain("Marked done");
  });
});
