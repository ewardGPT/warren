// OPR.0.4.1.27 Unit 6 — sender-or-owner terminal resolver.
// Human-action cards (action-required / approval) open the SENDER (sourceSession);
// agent-owned cards (progress / shipped / observation) open the current HOLDER
// (destinationSession), falling back to source when no destination resolves.
// Grounded in the tasks-dev2 fidelity map (sourceSession/destinationSession are
// the only terminal-addressable sessions; never handed_off_from).

import { describe, it, expect } from "vitest";
import { resolveCardTerminalSession } from "../src/components/for-you/FeedCard.js";

const SRC = "orch-lead@openrig-delivery";
const DST = "dev1-driver@openrig-delivery";

describe("resolveCardTerminalSession (OPR.0.4.1.27 Unit 6)", () => {
  it("action-required opens the SENDER (sourceSession)", () => {
    expect(resolveCardTerminalSession("action-required", SRC, DST)).toBe(SRC);
  });
  it("approval opens the SENDER (sourceSession)", () => {
    expect(resolveCardTerminalSession("approval", SRC, DST)).toBe(SRC);
  });
  it("progress opens the current HOLDER (destinationSession)", () => {
    expect(resolveCardTerminalSession("progress", SRC, DST)).toBe(DST);
  });
  it("shipped opens the current HOLDER (destinationSession)", () => {
    expect(resolveCardTerminalSession("shipped", SRC, DST)).toBe(DST);
  });
  it("observation opens the current HOLDER (destinationSession)", () => {
    expect(resolveCardTerminalSession("observation", SRC, DST)).toBe(DST);
  });
  it("agent-owned falls back to source when no destination resolves", () => {
    expect(resolveCardTerminalSession("progress", SRC, undefined)).toBe(SRC);
  });
  it("returns undefined when neither session resolves", () => {
    expect(resolveCardTerminalSession("action-required", undefined, undefined)).toBeUndefined();
  });
});
