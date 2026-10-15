import { describe, it, expect } from "vitest";
import { crashCartRenderOpts, probeCrashCart, type CrashCartEmit } from "../src/crash-cart/from-emit.js";

// Crash-cart C3 unit-C — map the `rig crash-cart --json` verdict → the renderScreen daemon-down opts.
// DOWN+discovery → the cockpit; UNVERIFIED+evidence → the cannot-verify screen; UP → normal TUI. Rail 3:
// a DOWN+refusal (the read fail-closed because a daemon answered) NEVER renders the cockpit → normal TUI.

describe("crashCartRenderOpts — verdict → render opts", () => {
  it("DOWN + discovery → daemonState down + a built cockpit model", () => {
    const emit: CrashCartEmit = {
      state: "down",
      discovery: {
        header: { lastActivityAt: "2026-08-06T08:12:00Z" },
        foundOnHost: [{ rigName: "alpha", seatCount: 2, resumableCount: 2, lastActiveAt: "2026-08-06T08:00:00Z" }],
        whereWorkStopped: [],
      },
    };
    const o = crashCartRenderOpts(emit);
    expect(o.daemonState).toBe("down");
    expect(o.crashCart?.foundOnHost[0]?.name).toBe("alpha");
    expect(o.crashCart?.header.lastSeen).toBe("08:12");
  });

  it("UNVERIFIED + evidence → daemonState unverified + the evidence", () => {
    const o = crashCartRenderOpts({ state: "unverified", evidence: { pidState: "alive", probeResult: "timeout", failedSignal: "x" } });
    expect(o.daemonState).toBe("unverified");
    expect(o.daemonEvidence?.probeResult).toBe("timeout");
    expect(o.crashCart).toBeUndefined();
  });

  it("UP → normal TUI (no daemon-down opts)", () => {
    expect(crashCartRenderOpts({ state: "up" })).toEqual({});
  });

  it("DOWN + refusal stays visible and does not authorize daemon-down recovery", () => {
    const o = crashCartRenderOpts({ state: "down", refusal: "a daemon answered /healthz — refusing the direct read" });
    expect(o.unavailable).toContain("a daemon answered");
    expect(o.daemonState).toBeUndefined();
  });
});

describe("probeCrashCart — run the verb + map; failures never fabricate a cockpit", () => {
  it("maps valid verb JSON to opts", async () => {
    const o = await probeCrashCart(async () => JSON.stringify({ state: "unverified", evidence: { pidState: "p", probeResult: "timeout", failedSignal: "s" } }));
    expect(o.daemonState).toBe("unverified");
  });
  it("verb errors retain a named unavailable prerequisite", async () => {
    expect((await probeCrashCart(async () => { throw new Error("spawn failed"); })).unavailable).toContain("spawn failed");
  });
  it("unparseable output never becomes an empty instance", async () => {
    const result = await probeCrashCart(async () => "not json");
    expect(result.unavailable).toBeTruthy();
    expect(result.crashCart).toBeUndefined();
  });
  it("retains the public CLI's native-load failure detail", async () => {
    const result = await probeCrashCart(async () => JSON.stringify({ error: { message: "ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch" } }));
    expect(result.unavailable).toContain("ERR_DLOPEN_FAILED");
    expect(result.daemonState).toBeUndefined();
  });
});
