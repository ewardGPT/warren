import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { addHostEntry, loadHostRegistry, validateHostRegistry } from "../src/host-registry.js";

// OPR.0.4.4.13 FR-1 — the registry write path: ONE validation source (the
// loader's rules, verbatim), atomic write, duplicate refusal, and the
// qa1-guard ROUND-TRIP proof (add → loader reads back the identical entry).
describe("addHostEntry (rig host add write path)", () => {
  let dir: string;
  let regPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostreg-"));
    regPath = path.join(dir, "hosts.yaml");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("round-trip: add on a MISSING file creates it and the loader reads back the identical entry", () => {
    const res = addHostEntry({ id: "vps-1", transport: "ssh", target: "vps-1.tailnet", user: "openrig" }, regPath);
    expect(res.ok).toBe(true);
    const loaded = loadHostRegistry(regPath);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.registry.hosts).toEqual([{ id: "vps-1", transport: "ssh", target: "vps-1.tailnet", user: "openrig" }]);
    }
  });

  it("round-trip: http entry with bearer_env survives identically", () => {
    const res = addHostEntry({ id: "h1", transport: "http", url: "http://100.1.2.3:7433", bearer_env: "H1_TOKEN", notes: "factory" }, regPath);
    expect(res.ok).toBe(true);
    const loaded = loadHostRegistry(regPath);
    expect(loaded.ok && loaded.registry.hosts[0]).toEqual({ id: "h1", transport: "http", url: "http://100.1.2.3:7433", bearer_env: "H1_TOKEN", notes: "factory" });
  });

  it("validation parity: add-time errors ARE the loader's errors (same fixture, same message)", () => {
    const badEntry = { id: "h1", transport: "http", url: "http://x", bearer_env: "A", bearer_file: "/b" };
    const addRes = addHostEntry(badEntry, regPath);
    const loadRes = validateHostRegistry({ hosts: [badEntry] }, regPath);
    expect(addRes.ok).toBe(false);
    expect(loadRes.ok).toBe(false);
    if (!addRes.ok && !loadRes.ok) expect(addRes.error).toBe(loadRes.error);
  });

  it("refuses duplicate host ids with the loader's own duplicate error", () => {
    expect(addHostEntry({ id: "dup", transport: "ssh", target: "a" }, regPath).ok).toBe(true);
    const res = addHostEntry({ id: "dup", transport: "ssh", target: "b" }, regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("duplicate host id 'dup'");
  });

  it("refuses to modify a present-but-invalid registry (never clobbers operator state)", () => {
    fs.writeFileSync(regPath, "hosts: {not-an-array: true}\n");
    const res = addHostEntry({ id: "h1", transport: "ssh", target: "a" }, regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("refusing to modify an invalid registry");
    expect(fs.readFileSync(regPath, "utf-8")).toContain("not-an-array");
  });

  it("appends to an existing valid registry, preserving prior entries", () => {
    addHostEntry({ id: "a", transport: "ssh", target: "a.host" }, regPath);
    addHostEntry({ id: "b", transport: "http", url: "http://b", bearer_file: "/tok" }, regPath);
    const loaded = loadHostRegistry(regPath);
    expect(loaded.ok && loaded.registry.hosts.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("transport-appropriate field validation fires at add-time (ssh without target)", () => {
    const res = addHostEntry({ id: "x", transport: "ssh" }, regPath);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("target: required");
  });
});
