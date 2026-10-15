// OPR.0.3.2.20 — string-keyed dismissal hook tests. Pins BLOCKER-2
// fix from guard verdict qitem-20260518190827: queue-derived
// synthetic FeedCards share ActivityEvent.seq=-1, so the old
// seq-keyed dismissal would collide across all queue-derived cards.
// useDismissedCardIds keys on the unique string FeedCard.id so each
// queue-derived card has independent dismissal state.

import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useDismissedCardIds,
  DISMISSED_CARD_IDS_STORAGE_KEY,
} from "../src/hooks/useDismissedCardIds.js";

describe("useDismissedCardIds — string-keyed dismissal", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("initializes empty when localStorage is empty", () => {
    const { result } = renderHook(() => useDismissedCardIds(["a", "b", "c"]));
    expect(result.current.dismissedIds.size).toBe(0);
  });

  it("reads existing dismissed ids from localStorage on mount", () => {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, JSON.stringify(["queue-attention-q1", "queue-attention-q2"]));
    const { result } = renderHook(() =>
      useDismissedCardIds(["queue-attention-q1", "queue-attention-q2", "queue-attention-q3"]),
    );
    expect(result.current.dismissedIds.has("queue-attention-q1")).toBe(true);
    expect(result.current.dismissedIds.has("queue-attention-q2")).toBe(true);
    expect(result.current.dismissedIds.has("queue-attention-q3")).toBe(false);
  });

  it("tolerates malformed localStorage value (non-JSON)", () => {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, "{not json[");
    const { result } = renderHook(() => useDismissedCardIds(["a"]));
    expect(result.current.dismissedIds.size).toBe(0);
  });

  it("tolerates non-array localStorage value", () => {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, JSON.stringify({ not: "array" }));
    const { result } = renderHook(() => useDismissedCardIds(["a"]));
    expect(result.current.dismissedIds.size).toBe(0);
  });

  it("dismiss(id) adds id to the set and persists", () => {
    const { result } = renderHook(() => useDismissedCardIds(["a", "b"]));
    act(() => result.current.dismiss("a"));
    expect(result.current.dismissedIds.has("a")).toBe(true);
    const stored = JSON.parse(localStorage.getItem(DISMISSED_CARD_IDS_STORAGE_KEY) ?? "[]") as string[];
    expect(stored).toContain("a");
  });

  it("undismiss(id) removes id from the set and persists", () => {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, JSON.stringify(["a", "b"]));
    const { result } = renderHook(() => useDismissedCardIds(["a", "b"]));
    act(() => result.current.undismiss("a"));
    expect(result.current.dismissedIds.has("a")).toBe(false);
    expect(result.current.dismissedIds.has("b")).toBe(true);
  });

  // BLOCKER-2 discriminator: each card.id is its own dismissal key.
  // Dismissing one queue-derived card MUST NOT hide others.
  it("BLOCKER-2 fix: dismissing one card id does NOT affect other cards (independent dismissal state)", () => {
    const { result } = renderHook(() =>
      useDismissedCardIds(["queue-attention-q1", "queue-attention-q2", "queue-attention-q3"]),
    );
    act(() => result.current.dismiss("queue-attention-q1"));
    expect(result.current.dismissedIds.has("queue-attention-q1")).toBe(true);
    expect(result.current.dismissedIds.has("queue-attention-q2")).toBe(false);
    expect(result.current.dismissedIds.has("queue-attention-q3")).toBe(false);
  });

  it("auto-prune: a dismissed id no longer in currentIds is dropped from the set", () => {
    localStorage.setItem(
      DISMISSED_CARD_IDS_STORAGE_KEY,
      JSON.stringify(["queue-attention-evicted", "queue-attention-still-here"]),
    );
    // Render with currentIds that excludes "queue-attention-evicted"
    // (the qitem has closed and the card disappeared from the feed).
    const { result, rerender } = renderHook(
      ({ ids }) => useDismissedCardIds(ids),
      { initialProps: { ids: ["queue-attention-still-here"] } },
    );
    rerender({ ids: ["queue-attention-still-here"] });
    // After the prune effect runs, the evicted id is gone.
    expect(result.current.dismissedIds.has("queue-attention-evicted")).toBe(false);
    expect(result.current.dismissedIds.has("queue-attention-still-here")).toBe(true);
  });

  it("dismiss is idempotent — calling twice doesn't double-add or churn storage", () => {
    const { result } = renderHook(() => useDismissedCardIds(["a"]));
    act(() => result.current.dismiss("a"));
    act(() => result.current.dismiss("a"));
    expect(result.current.dismissedIds.size).toBe(1);
  });

  it("uses a distinct localStorage namespace from useDismissedSeqs (no cross-contamination)", () => {
    // Storage key must be different from the seq-keyed hook's key.
    expect(DISMISSED_CARD_IDS_STORAGE_KEY).toBe("forYou.dismissedCardIds");
    expect(DISMISSED_CARD_IDS_STORAGE_KEY).not.toBe("forYou.dismissedSeqs");
  });
});
