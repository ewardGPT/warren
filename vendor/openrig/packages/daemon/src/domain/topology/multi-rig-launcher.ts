// OPR.0.4.4.11 — MultiRigLauncher: the THIN walker (FR-3/FR-4/FR-5).
//
// It INVOKES the existing single-rig leaves — it never re-implements stages,
// locks, provenance, or result shapes. A local entry runs through the SAME
// public bootstrap() entry + tryAcquire/release lock pair routes/up.ts uses
// (guard G-2: the per-sourceRef lock is ROUTE-side today — bootstrap() never
// acquires; the launcher explicitly participates in that same lock set,
// acquire before the leaf, release in finally on success AND failure). A
// host-placed entry runs through the shipped remote POST /api/up leaf. Both
// leaves are injected so this module stays testable and the wiring in
// routes/up.ts (the ONLY production caller) binds the real seams.
//
// Aggregate contract (arch ruling 5, verbatim): status is the CLOSED enum
// {ok | failed | skipped}; entries after the failed one report `skipped`
// EXPLICITLY (never absent — omission-proof); `host` is present uniformly on
// every entry (the literal "local" for local entries); overall success =
// every entry ok. Stop-on-failure is the ONLY v0 behavior (FR-5): no new
// entry starts after a failure; already-started rigs are reported honestly
// (mixed state, no rollback ceremony).

import type { TopologyManifest } from "./topology-manifest.js";
import type { HostEntry, HostRegistryLoadResult } from "../hosts/hosts-registry-reader.js";
import { resolvePlacementHost } from "../hosts/hosts-registry-reader.js";

export type TopologyEntryStatus = "ok" | "failed" | "skipped";

export interface TopologyEntryResult {
  rigRef: string;
  /** Uniform on every entry: the placed host id, or the literal "local". */
  host: string;
  status: TopologyEntryStatus;
  error?: string;
}

export interface TopologyLaunchResult {
  /** True ONLY when every entry is ok (FR-5 — no false green). */
  ok: boolean;
  entries: TopologyEntryResult[];
}

export interface MultiRigLauncherDeps {
  /** The SAME public lock pair the up route uses (bootstrap-orchestrator). */
  tryAcquire: (sourceRef: string) => boolean;
  release: (sourceRef: string) => void;
  /** The existing local single-rig leaf (public bootstrap() via routes/up.ts
   *  wiring). Resolves ok:false with the leaf's own error on failure — the
   *  launcher invents no failure taxonomy. */
  launchLocal: (source: string) => Promise<{ ok: boolean; error?: string }>;
  /** The shipped remote POST /api/up leaf for a placed entry. */
  launchRemote: (source: string, host: HostEntry) => Promise<{ ok: boolean; error?: string }>;
  /** Lazy hosts-registry read (shared reader) — consulted only when the
   *  manifest actually places entries on hosts. */
  loadRegistry: () => HostRegistryLoadResult;
  /** Resolve a local entry's manifest source string to the EXACT ref used
   *  for BOTH the lock and the leaf (guard fixback F1): the orchestrator
   *  normalizes lock keys with path.resolve, so locking the raw relative
   *  string would key against the daemon cwd while the leaf launches the
   *  manifest-dir-resolved file — false lock negatives (standalone up of
   *  the real path doesn't conflict) AND false positives (two manifests'
   *  './a.yaml' collide across different files). Identity when omitted. */
  resolveLocalRef?: (source: string) => string;
}

/** Mirrors the route's 409 lock-conflict semantics for a topology entry. */
const LOCK_CONFLICT_ERROR = "Already in progress for this source (conflict): a concurrent up holds this rig's launch lock";

export class MultiRigLauncher {
  private deps: MultiRigLauncherDeps;

  constructor(deps: MultiRigLauncherDeps) {
    this.deps = deps;
  }

  async launch(manifest: TopologyManifest): Promise<TopologyLaunchResult> {
    const entries = manifest.rigs;
    // Every entry starts explicitly skipped — an entry the walk never
    // reaches is REPORTED, not absent (omission-proof aggregate).
    const results: TopologyEntryResult[] = entries.map((e) => ({
      rigRef: e.source,
      host: e.host ?? "local",
      status: "skipped" as TopologyEntryStatus,
    }));

    // ── Pre-launch placement validation (FR-1/FR-4: per-entry structured
    // errors BEFORE any launch attempt). Registry is read once, only if a
    // host-placed entry exists. Any placement failure aborts the whole run
    // before the first leaf call: bad entries report failed, the rest stay
    // skipped.
    const placed = new Map<number, HostEntry>();
    if (entries.some((e) => e.host !== undefined)) {
      const reg = this.deps.loadRegistry();
      let placementFailed = false;
      for (let i = 0; i < entries.length; i++) {
        const hostId = entries[i]!.host;
        if (hostId === undefined) continue;
        if (!reg.ok) {
          results[i]! = { ...results[i]!, status: "failed", error: reg.error };
          placementFailed = true;
          continue;
        }
        const res = resolvePlacementHost(reg.registry, hostId);
        if (!res.ok) {
          results[i]! = { ...results[i]!, status: "failed", error: res.error };
          placementFailed = true;
        } else {
          placed.set(i, res.host);
        }
      }
      if (placementFailed) return { ok: false, entries: results };
    }

    // ── Staged walk: entries START in manifest order under the fixed cap
    // (default 1 = strictly sequential); a failure stops all further starts
    // while in-flight entries complete and report honestly.
    let nextIndex = 0;
    let stopped = false;

    const runEntry = async (i: number): Promise<void> => {
      const entry = entries[i]!;
      const hostEntry = placed.get(i);
      try {
        if (hostEntry) {
          const res = await this.deps.launchRemote(entry.source, hostEntry);
          results[i] = {
            rigRef: entry.source,
            host: hostEntry.id,
            status: res.ok ? "ok" : "failed",
            ...(res.ok ? {} : { error: res.error ?? "remote up failed" }),
          };
          return;
        }
        // Local: the route-side lock discipline, explicitly (guard G-2).
        // Lock key and launch ref are the SAME resolved string (guard F1) —
        // the aggregate's rigRef stays the raw manifest string for display.
        const launchRef = this.deps.resolveLocalRef ? this.deps.resolveLocalRef(entry.source) : entry.source;
        if (!this.deps.tryAcquire(launchRef)) {
          results[i] = { rigRef: entry.source, host: "local", status: "failed", error: LOCK_CONFLICT_ERROR };
          return;
        }
        try {
          const res = await this.deps.launchLocal(launchRef);
          results[i] = {
            rigRef: entry.source,
            host: "local",
            status: res.ok ? "ok" : "failed",
            ...(res.ok ? {} : { error: res.error ?? "bootstrap failed" }),
          };
        } finally {
          this.deps.release(launchRef);
        }
      } catch (err) {
        results[i] = {
          rigRef: entry.source,
          host: hostEntry ? hostEntry.id : "local",
          status: "failed",
          error: (err as Error).message,
        };
      }
    };

    const cap = Math.max(1, manifest.concurrency);
    const workers = Array.from({ length: Math.min(cap, entries.length) }, async () => {
      while (!stopped) {
        const i = nextIndex;
        if (i >= entries.length) return;
        nextIndex += 1;
        await runEntry(i);
        if (results[i]!.status === "failed") stopped = true; // FR-5: stop at the failed entry
      }
    });
    await Promise.all(workers);

    return { ok: results.every((r) => r.status === "ok"), entries: results };
  }
}
