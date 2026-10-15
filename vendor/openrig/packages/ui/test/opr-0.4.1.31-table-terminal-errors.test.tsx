// OPR.0.4.1.31 part B — the table Open-in-cmux button must SURFACE a failed
// launch, not fail silently. Before the fix the button tracked only isPending,
// so a real failure (no current cmux workspace, missing terminal bearer, etc.)
// looked like "the button does nothing / never works" (the founder's daily pain).
// This asserts the real failure path renders a visible, actionable error.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const ROW = {
  rigId: "rig-1",
  rigName: "test-rig",
  logicalId: "orch.lead",
  podId: "orch",
  podNamespace: "orch",
  canonicalSessionName: "orch-lead@test-rig",
  nodeKind: "agent",
  runtime: "claude-code",
  sessionStatus: "running",
  startupStatus: "ready",
  restoreOutcome: "n-a",
  tmuxAttachCommand: null,
  resumeCommand: null,
  latestError: null,
};

function nodesResponse() {
  return new Response(JSON.stringify([ROW]));
}

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
});

afterEach(() => cleanup());

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("OPR.0.4.1.31 — table Open-in-cmux surfaces failures (no silent no-op)", () => {
  it("renders the daemon error message on the button when open-cmux fails", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([{ id: "rig-1", name: "test-rig" }]));
      if (url.includes("/open-cmux")) {
        return new Response(
          JSON.stringify({ ok: false, error: "no_current_workspace", message: "cmux has no current workspace" }),
          { status: 500 },
        );
      }
      if (url.includes("/api/rigs/rig-1/nodes")) return nodesResponse();
      return new Response("[]");
    });

    const { findByTestId, queryByTestId } = withQueryClient(<TopologyTableView />);
    const cmux = await findByTestId("topology-table-cmux-orch.lead");
    // No error before the click.
    expect(queryByTestId("topology-table-cmux-error-orch.lead")).toBeNull();

    fireEvent.click(cmux);

    const err = await findByTestId("topology-table-cmux-error-orch.lead");
    expect(err.getAttribute("role")).toBe("alert");
    expect(err.textContent).toContain("cmux has no current workspace");
    // the button also reflects the error state (title/aria carry the message + retry affordance)
    expect((cmux as HTMLButtonElement).getAttribute("title")).toContain("cmux has no current workspace");
    expect((cmux as HTMLButtonElement).getAttribute("data-error")).toBe("true");
  });

  it("does NOT render an error on a successful open-cmux", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([{ id: "rig-1", name: "test-rig" }]));
      if (url.includes("/open-cmux")) return new Response(JSON.stringify({ ok: true, action: "created_new" }));
      if (url.includes("/api/rigs/rig-1/nodes")) return nodesResponse();
      return new Response("[]");
    });

    const { findByTestId, queryByTestId } = withQueryClient(<TopologyTableView />);
    const cmux = await findByTestId("topology-table-cmux-orch.lead");
    fireEvent.click(cmux);
    await waitFor(() => {
      const call = mockFetch.mock.calls.find((c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/open-cmux"));
      expect(call).toBeDefined();
    });
    // give the mutation a tick to settle; no error element should appear
    await new Promise((r) => setTimeout(r, 20));
    expect(queryByTestId("topology-table-cmux-error-orch.lead")).toBeNull();
  });
});
