// OPR.0.4.4.11 FR-6/7 — deploy-identity, daemon side.
//
// The COMMITTED module is the honest dev stub: no stamp → stampFields adds
// NOTHING to /healthz (no invented identity; legacy bodies preserved). The
// stamped shape (written by build-package.sh at package time) carries the
// exact four fields. The real end-to-end stamp is a VM-gate proof
// (build:package → /healthz shows the SHA).

import { describe, it, expect } from "vitest";
import { BUILD_INFO, stampFields } from "../src/build-info.js";

describe("build-info (daemon)", () => {
  it("the committed module IS the honest dev stub: all identity fields null", () => {
    expect(BUILD_INFO).toEqual({ semver: null, commit: null, dirty: null, builtAt: null });
  });

  it("dev stub contributes NOTHING to /healthz (negative AC: no fake identity, exact legacy bodies preserved)", () => {
    expect(stampFields(BUILD_INFO)).toEqual({});
    expect({ status: "ok", ...stampFields(BUILD_INFO) }).toEqual({ status: "ok" });
  });

  it("a stamped build contributes exactly {semver, commit, dirty, builtAt}", () => {
    const stamped = { semver: "0.4.3", commit: "a".repeat(40), dirty: false, builtAt: "2026-07-04T23:00:00Z" };
    expect(stampFields(stamped)).toEqual(stamped);
  });
});
