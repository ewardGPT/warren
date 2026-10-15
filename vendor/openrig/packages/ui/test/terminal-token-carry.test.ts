import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TOKEN = "test-terminal-token-xyz";

beforeEach(() => {
  window.localStorage.setItem("openrig.terminalBearerToken", TOKEN);
});

afterEach(() => {
  window.localStorage.removeItem("openrig.terminalBearerToken");
  vi.restoreAllMocks();
});

function stubFetch(): { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ content: "test", lines: 1, ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { calls };
}

describe("terminal-token carry on protected UI fetches", () => {
  it("fetchNodePreview sends Authorization: Bearer <token>", async () => {
    const { calls } = stubFetch();
    const { fetchNodePreview } = await import("../src/hooks/useNodePreview.js");
    await fetchNodePreview("rig-1", "dev.impl", 20);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/preview");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("fetchSessionPreview sends Authorization: Bearer <token>", async () => {
    const { calls } = stubFetch();
    const { fetchSessionPreview } = await import("../src/hooks/useNodePreview.js");
    await fetchSessionPreview("dev-impl@test-rig", 20);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/preview");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("postOpenCmux sends Authorization: Bearer <token>", async () => {
    const { calls } = stubFetch();
    const { postOpenCmux } = await import("../src/hooks/useCmuxLaunch.js");
    await postOpenCmux({ rigId: "rig-1", logicalId: "dev.impl" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toContain("/open-cmux");
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers?.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("terminalAuthHeaders reads token from localStorage", async () => {
    const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
    expect(terminalAuthHeaders().Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("terminalAuthHeaders returns empty when no token", async () => {
    window.localStorage.removeItem("openrig.terminalBearerToken");
    const { terminalAuthHeaders } = await import("../src/components/mission-control/missionControlAuth.js");
    expect(terminalAuthHeaders().Authorization).toBeUndefined();
  });

  it("source guard: all /open-cmux consumers use postOpenCmux (no direct fetch)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const srcDir = path.resolve(import.meta.dirname, "../src");
    const consumers = [
      "components/LiveNodeDetails.tsx",
      "components/RigNode.tsx",
      "components/topology/LaunchCmuxButton.tsx",
    ];
    for (const file of consumers) {
      const src = fs.readFileSync(path.join(srcDir, file), "utf-8");
      expect(src, `${file} must import postOpenCmux`).toContain("postOpenCmux");
      const lines = src.split("\n");
      const directFetchLines = lines.filter((l) => l.includes("open-cmux") && l.includes("fetch("));
      expect(directFetchLines.length, `${file} has direct fetch to /open-cmux`).toBe(0);
    }
  });

  it("source guard: postOpenCmux owns the /open-cmux fetch with terminalAuthHeaders", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/hooks/useCmuxLaunch.ts"), "utf-8");
    expect(src).toContain("terminalAuthHeaders()");
    expect(src).toContain("open-cmux");
  });

  it("source guard: hook-based open-cmux consumers carry the terminal auth contract via useCmuxLaunch", async () => {
    // OPR.0.4.1.31 fold (dev1-guard) — the table + hybrid surfaces open cmux
    // through the useCmuxLaunch hook (which wraps postOpenCmux -> terminalAuthHeaders).
    // Guard that they keep using the hook and never hand-roll a direct /open-cmux
    // fetch that would bypass the terminal auth contract.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const srcDir = path.resolve(import.meta.dirname, "../src");
    const consumers = [
      "components/topology/TopologyTableView.tsx",
      "components/topology/HybridTopologyNodes.tsx",
    ];
    for (const file of consumers) {
      const src = fs.readFileSync(path.join(srcDir, file), "utf-8");
      expect(src, `${file} must use useCmuxLaunch`).toContain("useCmuxLaunch");
      const lines = src.split("\n");
      const directFetchLines = lines.filter((l) => l.includes("open-cmux") && l.includes("fetch("));
      expect(directFetchLines.length, `${file} has direct fetch to /open-cmux`).toBe(0);
    }
  });
});
