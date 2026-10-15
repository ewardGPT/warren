// OPR.0.4.4.11 — R11-2 CLI leg: `rig up --host <id> <topology>` is rejected
// pre-dispatch; per-entry `host:` is the ONLY topology placement mechanism.
// (The daemon route carries the same rejection on its public write path —
// the double-sided ruling; that leg is pinned in the daemon's route tests.)

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceLooksLikeTopology, HOST_TOPOLOGY_REJECTION } from "../src/commands/up.js";

describe("sourceLooksLikeTopology (the R11-2 pre-dispatch detector)", () => {
  it("detects the .rigtopology extension in bare and path forms without touching the fs", () => {
    expect(sourceLooksLikeTopology("factory.rigtopology")).toBe(true);
    expect(sourceLooksLikeTopology("./nonexistent-dir/factory.rigtopology")).toBe(true);
    expect(sourceLooksLikeTopology("FACTORY.RIGTOPOLOGY")).toBe(true);
  });

  it("detects a path-form YAML file carrying a top-level rigs: list", () => {
    const dir = mkdtempSync(join(tmpdir(), "r11-2-"));
    const topo = join(dir, "factory.yaml");
    writeFileSync(topo, "rigs:\n  - source: a\n");
    const spec = join(dir, "rig.yaml");
    writeFileSync(spec, "name: x\npods: []\n");
    expect(sourceLooksLikeTopology(topo)).toBe(true);
    expect(sourceLooksLikeTopology(spec)).toBe(false); // rig specs pass through untouched
    rmSync(dir, { recursive: true, force: true });
  });

  it("never sniffs name-form sources (rig-name precedence preserved) and stays false on missing/unparseable files", () => {
    expect(sourceLooksLikeTopology("factory")).toBe(false); // bare name — --host + name stays a valid remote restore
    expect(sourceLooksLikeTopology("my-rig-name")).toBe(false);
    expect(sourceLooksLikeTopology("./no/such/file.yaml")).toBe(false);
  });

  it("the rejection message names per-entry host: as the only placement mechanism", () => {
    expect(HOST_TOPOLOGY_REJECTION).toContain("per-entry 'host:'");
    expect(HOST_TOPOLOGY_REJECTION).toContain("ONLY placement mechanism");
  });
});
