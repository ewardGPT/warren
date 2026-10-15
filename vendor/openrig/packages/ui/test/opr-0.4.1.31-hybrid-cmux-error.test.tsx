// OPR.0.4.1.31 B2 (dev1-guard) — the hybrid topology cmux button must surface a
// VISIBLE error message on a failed open-cmux, not just color the icon / set a
// hover title. Asserts a persistent role=alert chip with the daemon message +
// that a retry resets and clears it on success.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactFlowProvider } from "@xyflow/react";
import type React from "react";
import { HybridAgentNode } from "../src/components/topology/HybridTopologyNodes.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

afterEach(() => {
  cleanup();
  mockFetch.mockReset();
});

function renderNode(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReactFlowProvider>{ui}</ReactFlowProvider>
    </QueryClientProvider>,
  );
}

const DATA = {
  logicalId: "dev.impl",
  role: "driver",
  runtime: "claude-code",
  model: null,
  status: "running",
  rigId: "rig-1",
  canonicalSessionName: "dev-impl@rig",
};

describe("OPR.0.4.1.31 B2 — hybrid cmux button surfaces a VISIBLE error", () => {
  it("renders a visible role=alert error chip with the daemon message when open-cmux fails", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/open-cmux")) {
        return new Response(
          JSON.stringify({ ok: false, error: "no_current_workspace", message: "cmux has no current workspace" }),
          { status: 500 },
        );
      }
      return new Response("{}");
    });

    const { findByTestId, queryByTestId } = renderNode(<HybridAgentNode data={DATA} />);
    expect(queryByTestId("hybrid-cmux-error-dev.impl")).toBeNull();

    fireEvent.click(await findByTestId("hybrid-cmux-open-dev.impl"));

    const chip = await findByTestId("hybrid-cmux-error-dev.impl");
    expect(chip.getAttribute("role")).toBe("alert");
    expect(chip.textContent).toContain("cmux has no current workspace");
  });

  it("retry after a failure resets + re-POSTs and clears the error on success", async () => {
    let call = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/open-cmux")) {
        call += 1;
        if (call === 1) return new Response(JSON.stringify({ ok: false, message: "transient" }), { status: 500 });
        return new Response(JSON.stringify({ ok: true, action: "created_new" }));
      }
      return new Response("{}");
    });

    const { findByTestId, queryByTestId } = renderNode(<HybridAgentNode data={DATA} />);
    const btn = await findByTestId("hybrid-cmux-open-dev.impl");
    fireEvent.click(btn);
    await findByTestId("hybrid-cmux-error-dev.impl");

    fireEvent.click(btn); // retry → reset() + re-POST → success → chip clears
    await waitFor(() => expect(queryByTestId("hybrid-cmux-error-dev.impl")).toBeNull());
    expect(call).toBe(2);
  });

  it("does NOT post open-cmux for a malformed node with null logicalId (part D, symmetric to table)", async () => {
    mockFetch.mockImplementation(async () => new Response("{}"));
    const { getByTestId } = renderNode(
      <HybridAgentNode data={{ ...DATA, logicalId: null as unknown as string }} />,
    );
    const btn = getByTestId("hybrid-cmux-open-null") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 20));
    const openCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/open-cmux"),
    );
    expect(openCalls.length).toBe(0);
  });
});
