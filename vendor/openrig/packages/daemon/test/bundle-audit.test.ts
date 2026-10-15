import { describe, it, expect } from "vitest";
import {
  BundleAuditWriter,
  BundleAuditReader,
  type BundleAuditFsOps,
  type BundleAuditRecord,
} from "../src/domain/bundle-audit.js";

// Item 4 / slice-05 Checkpoint 5.1: bundle-audit unit tests.
// Discriminator pattern: any test asserting append + read round-trip must
// fail if writer.append or reader.list is broken.

function mockFs(): BundleAuditFsOps & { _state: Map<string, string>; _mkdirpCalls: string[] } {
  const state = new Map<string, string>();
  const mkdirpCalls: string[] = [];
  return {
    _state: state,
    _mkdirpCalls: mkdirpCalls,
    appendFile: (p: string, c: string) => {
      state.set(p, (state.get(p) ?? "") + c);
    },
    readFile: (p: string) => state.get(p) ?? "",
    exists: (p: string) => state.has(p),
    mkdirp: (p: string) => {
      mkdirpCalls.push(p);
    },
  };
}

const FIXTURE_PATH = "/test/.openrig/bundle-audit.jsonl";

function makeWriter(fs: BundleAuditFsOps) {
  return new BundleAuditWriter({ opts: { auditPath: FIXTURE_PATH }, fsOps: fs });
}

function makeReader(fs: BundleAuditFsOps) {
  return new BundleAuditReader({ opts: { auditPath: FIXTURE_PATH }, fsOps: fs });
}

function record(overrides?: Partial<BundleAuditRecord>): BundleAuditRecord {
  return {
    installedAt: "2026-05-18T12:00:00Z",
    bundlePath: "/tmp/test.rigbundle",
    archiveHash: "a".repeat(64),
    targetRigId: "01H000000000000000000001",
    targetRigName: "test-rig",
    sourceHost: "test-host.local",
    daemonVersion: "0.3.2",
    cliVersion: "0.3.2",
    outcome: "success",
    ...overrides,
  };
}

describe("BundleAuditWriter + BundleAuditReader", () => {
  // A1: empty file → empty list
  it("reading an empty audit file returns an empty array", () => {
    const fs = mockFs();
    const reader = makeReader(fs);
    expect(reader.list()).toEqual([]);
  });

  // A2: append + read single record round-trips
  it("append + list round-trips a single record verbatim", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    const reader = makeReader(fs);
    const r = record();
    writer.append(r);
    const out = reader.list();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(r);
  });

  // A3: append creates the parent dir
  it("first append creates the parent directory via mkdirp", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record());
    expect(fs._mkdirpCalls.length).toBeGreaterThan(0);
    expect(fs._mkdirpCalls[0]).toBe("/test/.openrig");
  });

  // A4: each record is one JSONL line terminated by newline
  it("each append writes exactly one JSON object followed by a newline (JSONL format)", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ targetRigName: "rig-a" }));
    writer.append(record({ targetRigName: "rig-b" }));
    const raw = fs._state.get(FIXTURE_PATH)!;
    const lines = raw.split("\n");
    // Two records → two non-empty lines + a trailing empty (from trailing \n)
    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[0]!).targetRigName).toBe("rig-a");
    expect(JSON.parse(lines[1]!).targetRigName).toBe("rig-b");
  });

  // A5: list returns records in append order
  it("list returns records in append order (oldest first)", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ installedAt: "2026-05-18T10:00:00Z", targetRigName: "rig-a" }));
    writer.append(record({ installedAt: "2026-05-18T11:00:00Z", targetRigName: "rig-b" }));
    writer.append(record({ installedAt: "2026-05-18T12:00:00Z", targetRigName: "rig-c" }));
    const out = makeReader(fs).list();
    expect(out.map((r) => r.targetRigName)).toEqual(["rig-a", "rig-b", "rig-c"]);
  });

  // A6: rig filter scopes to matching records
  it("rig filter returns only records whose targetRigName matches", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ targetRigName: "alpha" }));
    writer.append(record({ targetRigName: "beta" }));
    writer.append(record({ targetRigName: "alpha" }));
    const out = makeReader(fs).list({ rig: "alpha" });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.targetRigName === "alpha")).toBe(true);
  });

  // A7: since filter scopes to records at-or-after the cutoff
  it("since filter returns only records whose installedAt is >= the cutoff", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ installedAt: "2026-05-18T10:00:00Z" }));
    writer.append(record({ installedAt: "2026-05-18T11:00:00Z" }));
    writer.append(record({ installedAt: "2026-05-18T12:00:00Z" }));
    const out = makeReader(fs).list({ since: "2026-05-18T11:00:00Z" });
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.installedAt)).toEqual([
      "2026-05-18T11:00:00Z",
      "2026-05-18T12:00:00Z",
    ]);
  });

  // A8: combined rig + since filters
  it("rig + since filters both apply (AND semantics)", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ installedAt: "2026-05-18T10:00:00Z", targetRigName: "alpha" }));
    writer.append(record({ installedAt: "2026-05-18T11:00:00Z", targetRigName: "beta" }));
    writer.append(record({ installedAt: "2026-05-18T12:00:00Z", targetRigName: "alpha" }));
    const out = makeReader(fs).list({ rig: "alpha", since: "2026-05-18T11:00:00Z" });
    expect(out).toHaveLength(1);
    expect(out[0]!.installedAt).toBe("2026-05-18T12:00:00Z");
  });

  // A9: malformed lines are skipped silently (forward-compat)
  it("malformed JSONL lines are skipped silently; valid lines still surface", () => {
    const fs = mockFs();
    fs._state.set(FIXTURE_PATH, [
      JSON.stringify(record({ targetRigName: "a" })),
      "not-valid-json{",
      JSON.stringify(record({ targetRigName: "b" })),
    ].join("\n") + "\n");
    const out = makeReader(fs).list();
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.targetRigName)).toEqual(["a", "b"]);
  });

  // A10: outcome field is preserved literally (success / failed / partial)
  it("outcome field round-trips for all three values", () => {
    const fs = mockFs();
    const writer = makeWriter(fs);
    writer.append(record({ outcome: "success", targetRigName: "ok" }));
    writer.append(record({ outcome: "failed", targetRigName: "bad" }));
    writer.append(record({ outcome: "partial", targetRigName: "halfway" }));
    const out = makeReader(fs).list();
    expect(out.map((r) => r.outcome)).toEqual(["success", "failed", "partial"]);
  });
});
