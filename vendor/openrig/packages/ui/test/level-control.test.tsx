// OPR.0.4.1.27 Unit 3 — LevelControl (Option-B named-level segmented control).
// Presentation over the existing 5 toggles: derives the current level via
// deriveLevel(state) and calls setLevel(level) on pick. action_required floored.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LevelControl } from "../src/components/for-you/LevelControl.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

function settingsResponse(values: Partial<Record<string, string | boolean>>) {
  return {
    settings: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, { value: v, source: "default", defaultValue: v }]),
    ),
  };
}

function withQC(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// Highlights state (default): approvals/shipped/progress ON, audit OFF, action_required ON.
function mockHighlights(posted: Record<string, string>) {
  mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    if (typeof url !== "string") return new Response("{}", { status: 200 });
    const postMatch = url.match(/\/api\/config\/(.+)/);
    if (postMatch && init?.method === "POST") {
      posted[decodeURIComponent(postMatch[1]!)] = (init?.body as string) ?? "";
      return new Response(JSON.stringify({ ok: true, resolved: { value: true, source: "file", defaultValue: false } }));
    }
    if (url.endsWith("/api/config")) {
      return new Response(
        JSON.stringify(
          settingsResponse({
            "feed.subscriptions.action_required": true,
            "feed.subscriptions.approvals": true,
            "feed.subscriptions.shipped": true,
            "feed.subscriptions.progress": true,
            "feed.subscriptions.audit_log": false,
          }),
        ),
      );
    }
    return new Response("[]");
  });
}

describe("LevelControl (OPR.0.4.1.27 Unit 3)", () => {
  it("renders the 3 named levels + the action-items-always-on label", async () => {
    mockHighlights({});
    const { findByTestId, getByText } = withQC(<LevelControl />);
    expect(await findByTestId("level-control")).toBeTruthy();
    expect(await findByTestId("level-control-option-all-activity")).toBeTruthy();
    expect(await findByTestId("level-control-option-highlights")).toBeTruthy();
    expect(await findByTestId("level-control-option-needs-you")).toBeTruthy();
    expect(getByText(/action items always on/i)).toBeTruthy();
  });

  it("marks the derived current level active (highlights default)", async () => {
    mockHighlights({});
    const { findByTestId } = withQC(<LevelControl />);
    await waitFor(async () => {
      expect((await findByTestId("level-control-option-highlights")).getAttribute("data-active")).toBe("true");
    });
    expect((await findByTestId("level-control-option-needs-you")).getAttribute("data-active")).toBe("false");
    expect((await findByTestId("level-control-option-all-activity")).getAttribute("data-active")).toBe("false");
  });

  it("shows a plain-language readout for the current level", async () => {
    mockHighlights({});
    const { findByTestId } = withQC(<LevelControl />);
    const readout = await findByTestId("level-control-readout");
    await waitFor(() => expect(readout.textContent ?? "").toMatch(/highlights/i));
  });

  it("clicking a level calls setLevel → POSTs the changed keys (needs-you turns 3 off)", async () => {
    const posted: Record<string, string> = {};
    mockHighlights(posted);
    const { findByTestId } = withQC(<LevelControl />);
    const needsYou = await findByTestId("level-control-option-needs-you");
    await waitFor(() => expect((needsYou as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(needsYou);
    await waitFor(() => {
      expect(posted["feed.subscriptions.approvals"]).toContain("false");
      expect(posted["feed.subscriptions.shipped"]).toContain("false");
      expect(posted["feed.subscriptions.progress"]).toContain("false");
    });
    expect(posted["feed.subscriptions.action_required"]).toBeUndefined();
  });
});
