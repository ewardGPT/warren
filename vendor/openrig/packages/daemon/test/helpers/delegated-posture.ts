import type { OperatingPosture } from "../../src/domain/rig-mode/operating-posture.js";

/** Existing diagnosis mechanics tests deliberately model delegated work.
 * Scope resolution and default/unknown controls use the real reader in operating-posture.test.ts. */
export function delegatedPostureFixture(): OperatingPosture {
  return { posture: "delegated", source: "binding", context: { rigId: "fixture", phase: { value: "planning", source: "fixture" }, sources: ["fixture"] },
    binding: { id: "rig:fixture", scope: "rig", setAt: "2026-09-05T00:00:00Z", evidence: "explicit isolated unit fixture" },
    reason: "Explicit delegated test fixture", grantsAuthority: false };
}
