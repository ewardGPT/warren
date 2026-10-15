// @vitest-environment jsdom

// OPR.0.4.4.15 — guard G15-CF6-1 regression: acting on a REMOTE card must
// carry the item's origin hostId into POST /api/mission-control/action so
// the daemon forwards the verb to where the qitem lives (FR-4). Local /
// absent hostId adds NOTHING to the mutation body (byte-parity with
// today's local path — the zero-config negative at the verb layer).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VerbActions } from "../src/components/mission-control/components/VerbActions.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderVerbActions(props: Parameters<typeof VerbActions>[0]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VerbActions {...props} />
    </QueryClientProvider>,
  );
}

function stubActionFetch() {
  const actionCalls: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/mission-control/destinations")) {
        return new Response(JSON.stringify({ destinations: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/mission-control/action")) {
        actionCalls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ actionId: "a-1", verb: "approve", qitemId: "q-1", closedQitem: null, createdQitemId: null, notifyAttempted: false, notifyResult: null, auditedAt: "t" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return actionCalls;
}

async function oneClickApprove(hostId?: string) {
  const actionCalls = stubActionFetch();
  const { getByTestId } = renderVerbActions({
    qitemId: "q-1",
    actorSession: "human@host",
    enabledVerbs: ["approve"],
    oneClickVerbs: ["approve"],
    ...(hostId !== undefined ? { hostId } : {}),
  });
  fireEvent.click(getByTestId("mc-verb-approve"));
  await waitFor(() => expect(actionCalls.length).toBe(1));
  return actionCalls[0]!;
}

describe("VerbActions — G15-CF6-1 hostId propagation (FR-4 UI leg)", () => {
  it("remote card: the mutation body carries the origin hostId", async () => {
    const body = await oneClickApprove("vps-b");
    expect(body["hostId"]).toBe("vps-b");
    expect(body["verb"]).toBe("approve");
    expect(body["qitemId"]).toBe("q-1");
  });

  it("local card ('local'): NO hostId key in the body — today's local path byte-for-byte", async () => {
    const body = await oneClickApprove("local");
    expect("hostId" in body).toBe(false);
  });

  it("absent hostId (zero-config / legacy cards): NO hostId key in the body", async () => {
    const body = await oneClickApprove(undefined);
    expect("hostId" in body).toBe(false);
  });
});
