// OPR.0.3.2.20 — QA BLOCKING-A (qitem-20260518195533) regression
// test. The For You attention surface MUST refetch when queue
// events arrive over SSE; without invalidation, useAttentionItems
// keeps its react-query cache and the open lens shows stale data
// until hard reload or window-focus refetch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useActivityFeed } from "../src/hooks/useActivityFeed.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";

let OriginalEventSource: typeof EventSource | undefined;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

beforeEach(() => {
  OriginalEventSource = globalThis.EventSource;
  // @ts-expect-error — replacing the global for the test
  globalThis.EventSource = createMockEventSourceClass();
});

afterEach(() => {
  cleanup();
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
});

function wrapper(client: QueryClient) {
  // eslint-disable-next-line react/display-name
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe("useActivityFeed — attention-items invalidation on queue events (QA BLOCKING-A fix)", () => {
  it("invalidates ['attention-items'] on queue.created SSE event", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    // Wait for the EventSource subscription to be created.
    await act(() => Promise.resolve());
    const source = instances[0];
    expect(source).toBeDefined();

    // Simulate the daemon emitting a queue.created event.
    act(() => {
      source!.simulateMessage(JSON.stringify({
        seq: 1,
        type: "queue.created",
        qitemId: "qitem-test-live-1",
        destinationSession: "human-bob@kernel",
        createdAt: new Date().toISOString(),
      }));
    });

    // The cache key for useAttentionItems is ["attention-items", <limit>].
    // invalidateQueries with key ["attention-items"] is a prefix match in
    // react-query — verify we called it with that exact prefix.
    expect(spy).toHaveBeenCalledWith({ queryKey: ["attention-items"] });
  });

  it("invalidates ['attention-items'] on queue.handed_off, queue.updated, queue.claimed, queue.unclaimed", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    for (const type of ["queue.handed_off", "queue.updated", "queue.claimed", "queue.unclaimed"]) {
      act(() => {
        source.simulateMessage(JSON.stringify({
          seq: 100,
          type,
          qitemId: "qitem-test-X",
          createdAt: new Date().toISOString(),
        }));
      });
    }

    // attention-items invalidated for each of the 4 event types.
    const attentionCalls = spy.mock.calls.filter(
      ([arg]) => arg && (arg as { queryKey?: unknown[] }).queryKey?.[0] === "attention-items",
    );
    expect(attentionCalls.length).toBeGreaterThanOrEqual(4);
  });

  it("invalidates ['attention-items'] on qitem.* events (fallback_routed, closure_overdue)", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    for (const type of ["qitem.fallback_routed", "qitem.closure_overdue"]) {
      act(() => {
        source.simulateMessage(JSON.stringify({
          seq: 200,
          type,
          qitemId: "qitem-test-Y",
          createdAt: new Date().toISOString(),
        }));
      });
    }

    const attentionCalls = spy.mock.calls.filter(
      ([arg]) => arg && (arg as { queryKey?: unknown[] }).queryKey?.[0] === "attention-items",
    );
    expect(attentionCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidates ['attention-items'] on inbox.absorbed / inbox.denied", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    for (const type of ["inbox.absorbed", "inbox.denied"]) {
      act(() => {
        source.simulateMessage(JSON.stringify({
          seq: 300,
          type,
          createdAt: new Date().toISOString(),
        }));
      });
    }

    const attentionCalls = spy.mock.calls.filter(
      ([arg]) => arg && (arg as { queryKey?: unknown[] }).queryKey?.[0] === "attention-items",
    );
    expect(attentionCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("invalidates ['queue','item',qitemId] when payload includes qitemId so already-fetched detail refreshes", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    act(() => {
      source.simulateMessage(JSON.stringify({
        seq: 400,
        type: "queue.updated",
        qitemId: "qitem-abc-123",
        createdAt: new Date().toISOString(),
      }));
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["queue", "item", "qitem-abc-123"] });
  });

  it("accepts qitem_id snake-case payload key for queue detail invalidation", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    act(() => {
      source.simulateMessage(JSON.stringify({
        seq: 401,
        type: "queue.created",
        qitem_id: "qitem-snake-1",
        createdAt: new Date().toISOString(),
      }));
    });

    expect(spy).toHaveBeenCalledWith({ queryKey: ["queue", "item", "qitem-snake-1"] });
  });

  it("does NOT invalidate ['attention-items'] for non-queue events (no over-invalidation)", async () => {
    const client = createTestQueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useActivityFeed(), { wrapper: wrapper(client) });

    await act(() => Promise.resolve());
    const source = instances[0]!;

    for (const type of ["rig.imported", "snapshot.created", "session.discovered", "chat.message"]) {
      act(() => {
        source.simulateMessage(JSON.stringify({
          seq: 500,
          type,
          createdAt: new Date().toISOString(),
        }));
      });
    }

    const attentionCalls = spy.mock.calls.filter(
      ([arg]) => arg && (arg as { queryKey?: unknown[] }).queryKey?.[0] === "attention-items",
    );
    expect(attentionCalls.length).toBe(0);
  });
});
