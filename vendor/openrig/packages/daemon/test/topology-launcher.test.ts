// OPR.0.4.4.11 — MultiRigLauncher (FR-3/4/5 + guard G-2 lock regressions).
//
// The launcher is a THIN walker: these tests assert INVOCATION of injected
// leaves (never reimplementation), strict ordering under the default cap,
// the cap ceiling, honest partial with explicit `skipped`, the route-side
// lock discipline per local entry (acquire → leaf → release in finally, on
// success AND failure), and pre-launch placement validation through the
// shared hosts-registry reader.

import { describe, it, expect } from "vitest";
import { MultiRigLauncher } from "../src/domain/topology/multi-rig-launcher.js";
import type { MultiRigLauncherDeps } from "../src/domain/topology/multi-rig-launcher.js";
import type { TopologyManifest } from "../src/domain/topology/topology-manifest.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "T" },
    { id: "ssh-only", transport: "ssh", target: "x.local" },
  ],
};

function manifest(rigs: TopologyManifest["rigs"], concurrency = 1): TopologyManifest {
  return { rigs, concurrency };
}

interface Trace {
  calls: string[];
  locks: string[];
}

function deps(overrides: Partial<MultiRigLauncherDeps> = {}, trace?: Trace): MultiRigLauncherDeps {
  return {
    tryAcquire: (ref) => {
      trace?.locks.push(`acquire:${ref}`);
      return true;
    },
    release: (ref) => {
      trace?.locks.push(`release:${ref}`);
    },
    launchLocal: async (source) => {
      trace?.calls.push(`local:${source}`);
      return { ok: true };
    },
    launchRemote: async (source, host) => {
      trace?.calls.push(`remote:${source}@${host.id}`);
      return { ok: true };
    },
    loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    ...overrides,
  };
}

describe("MultiRigLauncher — staged walk (FR-3)", () => {
  it("concurrency 1: strictly sequential — entry 2 does not START until entry 1's leaf returns", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const launcher = new MultiRigLauncher(
      deps({
        launchLocal: async (source) => {
          events.push(`start:${source}`);
          if (source === "a") await gate;
          events.push(`end:${source}`);
          return { ok: true };
        },
      }),
    );
    const run = launcher.launch(manifest([{ source: "a" }, { source: "b" }]));
    await Promise.resolve();
    expect(events).toEqual(["start:a"]); // b has NOT started
    releaseFirst();
    const result = await run;
    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(result.ok).toBe(true);
  });

  it("concurrency 2: at most 2 leaves in flight at any moment; starts follow manifest order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: string[] = [];
    const launcher = new MultiRigLauncher(
      deps({
        launchLocal: async (source) => {
          starts.push(source);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return { ok: true };
        },
      }),
    );
    const result = await launcher.launch(
      manifest([{ source: "a" }, { source: "b" }, { source: "c" }, { source: "d" }], 2),
    );
    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(2); // ceiling honored, parallelism real
    expect(starts).toEqual(["a", "b", "c", "d"]); // manifest start order
  });

  it("invokes the leaf — passes the source ref through unmodified, wraps the leaf's own error verbatim", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps(
        {
          launchLocal: async (source) => {
            trace.calls.push(`local:${source}`);
            return source === "bad.yaml" ? { ok: false, error: "Stage RESOLVE_SPEC failed: no such spec" } : { ok: true };
          },
        },
        trace,
      ),
    );
    const result = await launcher.launch(manifest([{ source: "specs/one.yaml" }, { source: "bad.yaml" }]));
    expect(trace.calls).toEqual(["local:specs/one.yaml", "local:bad.yaml"]);
    expect(result.entries[1]).toEqual({
      rigRef: "bad.yaml",
      host: "local",
      status: "failed",
      error: "Stage RESOLVE_SPEC failed: no such spec", // the leaf's error — no invented taxonomy
    });
  });
});

describe("MultiRigLauncher — honest partial + stop-on-failure (FR-5, arch ruling 5)", () => {
  it("failure stops the walk: prior entries ok, failed entry named, later entries EXPLICITLY skipped, overall ok=false", async () => {
    const launcher = new MultiRigLauncher(
      deps({
        launchLocal: async (source) =>
          source === "b" ? { ok: false, error: "boom" } : { ok: true },
      }),
    );
    const result = await launcher.launch(manifest([{ source: "a" }, { source: "b" }, { source: "c" }]));
    expect(result.ok).toBe(false);
    expect(result.entries).toEqual([
      { rigRef: "a", host: "local", status: "ok" },
      { rigRef: "b", host: "local", status: "failed", error: "boom" },
      { rigRef: "c", host: "local", status: "skipped" }, // present, never absent
    ]);
  });

  it("a THROWING leaf reports failed with the thrown message and still stops the walk", async () => {
    const launcher = new MultiRigLauncher(
      deps({
        launchLocal: async () => {
          throw new Error("leaf exploded");
        },
      }),
    );
    const result = await launcher.launch(manifest([{ source: "a" }, { source: "b" }]));
    expect(result.entries[0]).toMatchObject({ status: "failed", error: "leaf exploded" });
    expect(result.entries[1]!.status).toBe("skipped");
  });

  it("host field is uniform on EVERY entry: literal 'local' or the placed host id", async () => {
    const launcher = new MultiRigLauncher(deps());
    const result = await launcher.launch(manifest([{ source: "a" }, { source: "b", host: "vps-b" }]));
    expect(result.entries.map((e) => e.host)).toEqual(["local", "vps-b"]);
    expect(result.ok).toBe(true);
  });
});

describe("MultiRigLauncher — route-side lock discipline per local entry (guard G-2)", () => {
  it("acquire before the leaf, release in finally — on success AND failure (no lock leak)", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps(
        {
          launchLocal: async (source) => {
            trace.calls.push(`local:${source}`);
            return source === "b" ? { ok: false, error: "x" } : { ok: true };
          },
        },
        trace,
      ),
    );
    await launcher.launch(manifest([{ source: "a" }, { source: "b" }]));
    expect(trace.locks).toEqual(["acquire:a", "release:a", "acquire:b", "release:b"]);
  });

  it("release fires even when the leaf THROWS", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps(
        {
          launchLocal: async () => {
            throw new Error("mid-leaf crash");
          },
        },
        trace,
      ),
    );
    await launcher.launch(manifest([{ source: "a" }]));
    expect(trace.locks).toEqual(["acquire:a", "release:a"]);
  });

  it("lock conflict (standalone up holds the rig) → entry failed with the route's conflict semantics, walk STOPS, no release of a lock we never held", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps(
        {
          tryAcquire: (ref) => {
            trace.locks.push(`acquire:${ref}`);
            return ref !== "contested";
          },
        },
        trace,
      ),
    );
    const result = await launcher.launch(manifest([{ source: "contested" }, { source: "b" }]));
    expect(result.ok).toBe(false);
    expect(result.entries[0]!.status).toBe("failed");
    expect(result.entries[0]!.error).toMatch(/Already in progress for this source/);
    expect(result.entries[1]!.status).toBe("skipped");
    expect(trace.locks).toEqual(["acquire:contested"]); // never released, never leaked
    expect(trace.calls).toEqual([]); // the leaf was never invoked
  });

  it("F1: lock key === launch ref — resolveLocalRef output feeds BOTH tryAcquire/release AND the leaf; rigRef stays the raw manifest string", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps({ resolveLocalRef: (s) => `/manifest/dir/${s.replace(/^\.\//, "")}` }, trace),
    );
    const result = await launcher.launch(manifest([{ source: "./a.yaml" }]));
    expect(trace.locks).toEqual(["acquire:/manifest/dir/a.yaml", "release:/manifest/dir/a.yaml"]);
    expect(trace.calls).toEqual(["local:/manifest/dir/a.yaml"]); // same string, no drift
    expect(result.entries[0]!.rigRef).toBe("./a.yaml"); // display keeps the portable manifest form
  });

  it("F1: same-file alias entries CONFLICT under concurrency — the resolved key is the lock domain", async () => {
    const held = new Set<string>();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const launcher = new MultiRigLauncher({
      resolveLocalRef: (s) => `/mdir/${s.replace(/^\.\//, "")}`,
      tryAcquire: (ref) => {
        if (held.has(ref)) return false;
        held.add(ref);
        return true;
      },
      release: (ref) => held.delete(ref),
      launchLocal: async (ref) => {
        if (ref === "/mdir/a.yaml" && held.size === 1) await gate; // hold entry 1 in flight
        return { ok: true };
      },
      launchRemote: async () => ({ ok: true }),
      loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    });
    // './a.yaml' and 'a.yaml' resolve to the SAME file; with cap 2 the second
    // starts while the first is in flight and must hit the lock conflict.
    const run = launcher.launch(manifest([{ source: "./a.yaml" }, { source: "a.yaml" }], 2));
    await new Promise((r) => setTimeout(r, 5)); // let both workers start
    releaseFirst();
    const result = await run;
    expect(result.ok).toBe(false);
    expect(result.entries[1]!.status).toBe("failed");
    expect(result.entries[1]!.error).toMatch(/Already in progress for this source/);
    expect(held.size).toBe(0); // no lock leak either way
  });

  it("remote entries take NO local lock (the remote daemon's route owns its own)", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(deps({}, trace));
    await launcher.launch(manifest([{ source: "r", host: "vps-b" }]));
    expect(trace.locks).toEqual([]);
    expect(trace.calls).toEqual(["remote:r@vps-b"]);
  });
});

describe("MultiRigLauncher — pre-launch placement validation (FR-1/FR-4)", () => {
  it("unknown host id fails per-entry BEFORE any launch: no leaf is ever invoked, other entries skipped", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(deps({}, trace));
    const result = await launcher.launch(
      manifest([{ source: "a" }, { source: "b", host: "nope" }, { source: "c" }]),
    );
    expect(result.ok).toBe(false);
    expect(trace.calls).toEqual([]); // nothing launched — validation precedes the walk
    expect(result.entries[1]!.status).toBe("failed");
    expect(result.entries[1]!.error).toContain("unknown host id 'nope'");
    expect(result.entries[0]!.status).toBe("skipped");
    expect(result.entries[2]!.status).toBe("skipped");
  });

  it("ssh-transport placement fails with the cannot-carry-remote-up fix message, before any launch", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(deps({}, trace));
    const result = await launcher.launch(manifest([{ source: "a", host: "ssh-only" }]));
    expect(result.entries[0]!.status).toBe("failed");
    expect(result.entries[0]!.error).toContain("cannot carry remote rig-up");
    expect(trace.calls).toEqual([]);
  });

  it("registry load failure fails the placed entries with the reader's error; nothing launches", async () => {
    const trace: Trace = { calls: [], locks: [] };
    const launcher = new MultiRigLauncher(
      deps({ loadRegistry: () => ({ ok: false, error: "host registry not found at /x/hosts.yaml. Create it..." }) }, trace),
    );
    const result = await launcher.launch(manifest([{ source: "a", host: "vps-b" }, { source: "b" }]));
    expect(result.entries[0]!.status).toBe("failed");
    expect(result.entries[0]!.error).toContain("host registry not found");
    expect(result.entries[1]!.status).toBe("skipped");
    expect(trace.calls).toEqual([]);
  });

  it("an all-local manifest NEVER reads the hosts registry", async () => {
    const launcher = new MultiRigLauncher(
      deps({
        loadRegistry: () => {
          throw new Error("registry must not be read for an all-local topology");
        },
      }),
    );
    const result = await launcher.launch(manifest([{ source: "a" }, { source: "b" }]));
    expect(result.ok).toBe(true);
  });
});
