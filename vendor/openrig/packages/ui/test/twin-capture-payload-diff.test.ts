// OPR.0.4.1.11.2 (FR-4) — data-medium capture: a deterministic payload before/after artifact for
// non-visual / data-shape slices (the data-medium equivalent of intent.png). Pure + deterministic
// (stable key ordering, sorted change paths) so the same before/after always yields the same artifact.
import { describe, it, expect } from "vitest";
import { canonicalJson, diffPaths, buildPayloadDiff } from "../twin/capture/payload-diff.js";

describe("payload-diff (OPR.0.4.1.11.2 FR-4: data-medium before/after artifact)", () => {
  it("canonicalJson is stable regardless of key insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{\n  "a": 2,\n  "b": 1\n}');
  });

  it("diffPaths reports added / removed / changed leaf paths (sorted, deterministic, deep)", () => {
    const before = { keep: 1, change: "old", gone: true, nested: { x: 1 } };
    const after = { keep: 1, change: "new", added: 5, nested: { x: 2 } };
    expect(diffPaths(before, after)).toEqual([
      "added (+): added",
      "changed (~): change",
      "changed (~): nested.x",
      "removed (-): gone",
    ]);
  });

  it("buildPayloadDiff assembles BEFORE / AFTER canonical + CHANGED sections", () => {
    const art = buildPayloadDiff({ before: { a: 1 }, after: { a: 2 } });
    expect(art).toContain("# BEFORE");
    expect(art).toContain("# AFTER");
    expect(art).toContain("# CHANGED");
    expect(art).toContain("changed (~): a");
  });
});
