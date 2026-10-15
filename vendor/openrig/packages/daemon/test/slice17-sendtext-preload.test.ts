// The original Slice 17 preload is superseded for the four SDLC roles:
// profile skills remain available, but startup must not invoke an unselected
// process. Keep the designer's unchanged explicit action as a restore control.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { normalizeStartupBlock, validateStartupBlock } from "../src/domain/startup-validation.js";

const SPECS = fileURLToPath(new URL("../specs/", import.meta.url));
const SELECTION_DRIVEN_ROLES = [
  "orchestration/orchestrator",
  "development/implementer",
  "development/qa",
  "review/independent-reviewer",
];

function readAgent(spec: string): Record<string, unknown> {
  return parseYaml(readFileSync(`${SPECS}agents/${spec}/agent.yaml`, "utf8"));
}

describe("Product-team startup respects SDLC selection", () => {
  it.each(SELECTION_DRIVEN_ROLES)("%s: fresh and restored seats get role context without process preloading", (spec) => {
    const raw = readAgent(spec);
    expect(validateStartupBlock(raw.startup, `${spec}.startup`)).toEqual([]);
    const startup = normalizeStartupBlock(raw.startup);

    // No action may choose work before the role resolves its assignment.
    expect(startup.actions).toEqual([]);
    expect(startup.files).toContainEqual(expect.objectContaining({
      path: "guidance/role.md",
      deliveryHint: "send_text",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    }));
    const role = readFileSync(`${SPECS}agents/${spec}/guidance/role.md`, "utf8");
    expect(role).toContain("product-journey-sdlc.md#resolve-the-selected-path");
    expect(role).not.toMatch(/BEFORE you do anything else|load and invoke your process skills NOW/i);
  });

  it("an explicitly authored designer action remains runtime-neutral and safe to replay", () => {
    const raw = readAgent("design/product-designer");
    expect(validateStartupBlock(raw.startup, "designer.startup")).toEqual([]);
    const startup = normalizeStartupBlock(raw.startup);
    expect(startup.actions).toHaveLength(1);
    expect(startup.actions[0]).toMatchObject({
      type: "send_text",
      phase: "after_ready",
      appliesOn: ["fresh_start", "restore"],
      idempotent: true,
    });
    expect(startup.actions[0]!.value).toContain("frontend-design");
    expect(startup.actions[0]!.value).not.toMatch(/test-driven-development|the Skill tool/i);
  });
});
