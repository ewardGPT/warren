// OPR.0.4.1.6 — read-time-trust derivation for rig scope (FR-5).
// Mirrors the scope-and-versioning §2 keystone: trust is DERIVED at read time
// from (stage x verified), never stored. 90-day freshness window mirrors
// packages/daemon/src/domain/skill-audit.ts:34.

import { describe, expect, it } from "vitest";
import {
  FRESHNESS_WINDOW_DAYS,
  deriveVerifiedTrust,
  deriveEffectiveStage,
} from "../src/lib/scope/trust.js";

const NOW = new Date("2026-06-20T00:00:00Z");

function daysAgo(n: number): string {
  const d = new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

describe("deriveVerifiedTrust (mirrors skill-audit checkStaleness, 90-day window)", () => {
  it("pins the freshness window at 90 days", () => {
    expect(FRESHNESS_WINDOW_DAYS).toBe(90);
  });

  it("verified within the window with a real source => verified", () => {
    const r = deriveVerifiedTrust(`${daysAgo(19)} against runtime (npm+tag)`, NOW);
    expect(r.status).toBe("verified");
    expect(r.source).toBe("runtime (npm+tag)");
  });

  it("BOUNDARY: 89 days => verified (fresh)", () => {
    expect(deriveVerifiedTrust(`${daysAgo(89)} against founder review`, NOW).status).toBe("verified");
  });

  it("BOUNDARY: 91 days => stale_verified", () => {
    expect(deriveVerifiedTrust(`${daysAgo(91)} against founder review`, NOW).status).toBe("stale_verified");
  });

  it("BOUNDARY: unparseable/bare date => bare_verified", () => {
    expect(deriveVerifiedTrust("sometime against the docs", NOW).status).toBe("bare_verified");
    expect(deriveVerifiedTrust("2026-13-99 against the docs", NOW).status).toBe("bare_verified");
  });

  it("missing/empty verified => missing_verified", () => {
    expect(deriveVerifiedTrust(undefined, NOW).status).toBe("missing_verified");
    expect(deriveVerifiedTrust("   ", NOW).status).toBe("missing_verified");
  });

  it("a scaffold/backfill/unverified provenance is NOT a real verification (regardless of date)", () => {
    expect(deriveVerifiedTrust(`${daysAgo(1)} against scaffold (rig scope create)`, NOW).status).toBe("unverified_provenance");
    expect(deriveVerifiedTrust(`${daysAgo(1)} against backfill (rig scope repair)`, NOW).status).toBe("unverified_provenance");
    expect(deriveVerifiedTrust(`${daysAgo(1)} against (unverified)`, NOW).status).toBe("unverified_provenance");
  });
});

describe("deriveEffectiveStage (the §2 self-correcting downgrade)", () => {
  it("established + fresh verified stays established", () => {
    const r = deriveEffectiveStage("established", "verified");
    expect(r.effectiveStage).toBe("established");
    expect(r.downgraded).toBe(false);
  });

  it("canonical + fresh verified stays canonical", () => {
    expect(deriveEffectiveStage("canonical", "verified").effectiveStage).toBe("canonical");
  });

  it("established + stale verified => effectively provisional", () => {
    const r = deriveEffectiveStage("established", "stale_verified");
    expect(r.effectiveStage).toBe("provisional");
    expect(r.downgraded).toBe(true);
    expect(r.reason).toMatch(/stale/);
  });

  it("established + missing verified => effectively provisional", () => {
    expect(deriveEffectiveStage("established", "missing_verified").effectiveStage).toBe("provisional");
  });

  it("canonical + bare/unverified provenance => effectively provisional", () => {
    expect(deriveEffectiveStage("canonical", "bare_verified").effectiveStage).toBe("provisional");
    expect(deriveEffectiveStage("canonical", "unverified_provenance").effectiveStage).toBe("provisional");
  });

  it("wip/provisional are never downgraded (only established/canonical can coast)", () => {
    expect(deriveEffectiveStage("wip", "missing_verified").downgraded).toBe(false);
    expect(deriveEffectiveStage("provisional", "stale_verified").downgraded).toBe(false);
    expect(deriveEffectiveStage("provisional", "stale_verified").effectiveStage).toBe("provisional");
  });
});
