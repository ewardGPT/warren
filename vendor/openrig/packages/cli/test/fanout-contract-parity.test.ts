import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { LOCAL_HOST_ID, hostsCovered, type AggregatedPayload } from "../src/lib/hosts/fanout-contract.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

// OPR.0.4.4.21 × OPR.0.4.4.15 — THE intra-P4 shared fan-out contract.
// Slice 15 defines the module daemon-side (first lander, 0ecd329b); the CLI
// cannot import across the package boundary (deliberately daemon-free), so
// it carries a BYTE-IDENTICAL copy enforced here — the shipped scope-audit
// parity pattern. Any intentional contract change lands in BOTH copies and
// is a cross-PRD re-review (slices 15 + 21) per the arch adjudication.
describe("fanout-contract CLI/daemon parity (CI-FAILING)", () => {
  it("fanout-contract.ts is byte-equivalent across CLI and daemon", () => {
    const cliContent = fs.readFileSync(path.join(REPO_ROOT, "packages/cli/src/lib/hosts/fanout-contract.ts"), "utf-8");
    const daemonContent = fs.readFileSync(path.join(REPO_ROOT, "packages/daemon/src/domain/hosts/fanout-contract.ts"), "utf-8");
    expect(cliContent).toBe(daemonContent);
  });

  it("exports the pinned contract members", () => {
    expect(LOCAL_HOST_ID).toBe("local");
    const payload: AggregatedPayload<{ x: number }> = {
      items: [{ x: 1 }],
      hosts: [{ hostId: "h1", status: "ok" }, { hostId: "h2", status: "unsupported-transport", error: "ssh" }],
    };
    expect(hostsCovered(payload, ["h1", "h2"])).toBe(true);
    expect(hostsCovered(payload, ["h1"])).toBe(false); // extra host = violation
    expect(hostsCovered({ items: [], hosts: [] }, ["h1"])).toBe(false); // omission = violation
  });
});
