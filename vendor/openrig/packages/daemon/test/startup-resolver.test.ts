import { describe, it, expect } from "vitest";
import { resolveStartup, resolveStartupProof, type StartupLayerInputs } from "../src/domain/startup-resolver.js";
import { normalizeStartupBlock, validateStartupBlock } from "../src/domain/startup-validation.js";
import type { StartupBlock, StartupFile } from "../src/domain/types.js";

function makeFile(path: string): StartupFile {
  return { path, deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] };
}

function makeBlock(paths: string[]): StartupBlock {
  return { files: paths.map(makeFile), actions: [] };
}

describe("Startup resolver", () => {
  const proof = (value: string, applies_on = ["fresh_start", "restore"]) =>
    normalizeStartupBlock({ actions: [{ type: "startup_proof", value, applies_on, idempotent: true }] });

  it("uses the last applicable selection through every authored layer", () => {
    const layers: StartupLayerInputs = { specStartup: proof("authenticated"), rigCultureFile: "culture.md" };
    const order = ["specStartup", "profileStartup", "rigStartup", "podStartup", "memberStartup", "operatorStartup"] as const;
    for (const [index, layer] of order.entries()) {
      const mode = index % 2 ? "none" : "authenticated";
      layers[layer] = proof(mode);
      expect(resolveStartupProof(resolveStartup(layers).actions, "fresh_start"))
        .toEqual({ mode, source: "authored", actionIndex: index });
    }
    layers.operatorStartup = proof("none", ["restore"]);
    const composed = resolveStartup(layers);
    expect(resolveStartupProof(composed.actions, "fresh_start").mode).toBe("authenticated");
    expect(resolveStartupProof(composed.actions, "restore").mode).toBe("none");
    expect(resolveStartupProof([], "fresh_start")).toEqual({ mode: "none", source: "default" });
  });

  it.each(["quiz", "", null, true, {}])("rejects malformed proof value %j even if later overridden", (value) => {
    const raw = { actions: [{ type: "startup_proof", value, idempotent: true }] };
    expect(validateStartupBlock(raw, "startup").length).toBeGreaterThan(0);
    expect(() => resolveStartupProof([
      ...normalizeStartupBlock(raw).actions, ...proof("none").actions,
    ], "fresh_start")).toThrow("startup_proof must select");
  });

  it("validates selection type and restore safety with the shared authoring validator", () => {
    for (const value of ["authenticated", "none"]) {
      expect(validateStartupBlock({ actions: [{ type: "startup_proof", value, idempotent: true }] }, "startup")).toEqual([]);
    }
    for (const action of [null, { type: "proof", value: "none", idempotent: true },
      { type: "startup_proof", value: "none", idempotent: false, applies_on: ["fresh_start"] },
      { type: "startup_proof", value: "none", idempotent: true, applies_on: ["adopt"] }]) {
      expect(validateStartupBlock({ actions: [action] }, "startup").length).toBeGreaterThan(0);
    }
  });

  // T9: startup files ordered: agent base → profile → culture → rig overlay → pod shared → member
  it("startup files ordered correctly across all layers", () => {
    const inputs: StartupLayerInputs = {
      specStartup: makeBlock(["startup/base.md"]),
      profileStartup: makeBlock(["startup/profile.md"]),
      rigCultureFile: "culture.md",
      rigStartup: makeBlock(["startup/rig-overlay.md"]),
      podStartup: makeBlock(["pods/dev/shared.md"]),
      memberStartup: makeBlock(["pods/dev/overlays/impl.md"]),
    };

    const result = resolveStartup(inputs);
    const paths = result.files.map((f) => f.path);

    expect(paths).toEqual([
      "startup/base.md",        // 1. agent base
      "startup/profile.md",     // 2. profile
      "culture.md",             // 3. rig culture
      "startup/rig-overlay.md", // 4. rig overlay
      "pods/dev/shared.md",     // 5. pod shared
      "pods/dev/overlays/impl.md", // 6. member
    ]);
  });

  // T10: operator startup append happens last
  it("operator startup append happens last", () => {
    const inputs: StartupLayerInputs = {
      specStartup: makeBlock(["startup/base.md"]),
      profileStartup: makeBlock(["startup/profile.md"]),
      rigCultureFile: "culture.md",
      rigStartup: makeBlock(["startup/rig.md"]),
      podStartup: makeBlock(["pods/dev/shared.md"]),
      memberStartup: makeBlock(["pods/dev/overlays/impl.md"]),
      operatorStartup: makeBlock(["debug/operator-debug.md"]),
    };

    const result = resolveStartup(inputs);
    const paths = result.files.map((f) => f.path);

    // Operator debug is always last
    expect(paths[paths.length - 1]).toBe("debug/operator-debug.md");
    expect(paths).toHaveLength(7);
    expect(paths.indexOf("debug/operator-debug.md")).toBe(6);
  });

  it("empty layers are skipped without gaps", () => {
    const inputs: StartupLayerInputs = {
      specStartup: makeBlock(["base.md"]),
      // no profile, no culture, no rig, no pod
      memberStartup: makeBlock(["member.md"]),
    };

    const result = resolveStartup(inputs);
    expect(result.files.map((f) => f.path)).toEqual(["base.md", "member.md"]);
  });
});
