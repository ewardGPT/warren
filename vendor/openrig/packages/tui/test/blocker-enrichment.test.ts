import { describe, expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createLiveRefresh } from "../src/live.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { isHumanSeatSession } from "../src/pulse/pulse-model.js";

// The four observed external gates, including an external ref that embeds a
// qitem ID, plus the existing human/legacy forms. None names a local qitem.
const gates = [
  "external:founder-pane-demo-idea",
  "external:qitem-20260830095010-42864340",
  "external:dogfood-codex-seat-relaunch-authorization",
  "external:lifecycle-current-dogfood-ready-packet",
  "fold:accepted", "auth:operator", "legacy-release-gate",
  "human-founder@kernel", "human-founder@kernel@remote-host",
];
const refs = [...gates, "qitem-present", "qitem-missing"];
const blocked = refs.map((blockedOn, i) => ({ qitemId: `qitem-waiter-${i}`, blockedOn,
  state: "blocked", destinationSession: "worker@rig", handedOffTo: null,
  tier: null, tags: null, summary: "Waiting", claimedAt: null, tsUpdated: "2026-09-11T00:00:00Z" }));
// Blocker enrichment belongs to the explicitly selected Pulse work view.
const state = { ...createViewState({ instanceId: "fixture" }).get(), viewTab: "pulse" as const };
type Failure = 403 | 404 | 503 | "timeout";
function fail(mode: Failure): Response {
  if (mode === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  return Response.json({ error: "fixture_failure" }, { status: mode });
}
function fixture(humanRefs: string[] = [], collide = false) {
  const requests: string[] = [];
  let failure: { route: string; mode: Failure } | undefined;
  let now = 1000;
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (input) => {
    const url = new URL(String(input)); const route = url.pathname + url.search;
    requests.push(route);
    if (failure?.route === route) return fail(failure.mode);
    if (route === "/api/queue/list?state=blocked") return Response.json([
      ...blocked, ...humanRefs.map((blockedOn, i) => ({ ...blocked[0], qitemId: `qitem-human-${i}`, blockedOn })),
    ]);
    if (collide && humanRefs.some(ref => route === `/api/queue/${encodeURIComponent(ref)}`)) {
      return Response.json({ destinationSession: "unrelated-owner@rig" });
    }
    if (route === "/api/queue/qitem-present") return Response.json({ destinationSession: "reviewer@rig" });
    if (url.pathname.startsWith("/api/queue/") && !["/api/queue/list", "/api/queue/attention-aggregate"].includes(url.pathname)) return fail(404);
    if (route === "/healthz") return Response.json({ selfHostId: "fixture" });
    if (url.pathname === "/api/health") return Response.json({ records: [], total: 0, truncated: false });
    if (url.pathname === "/api/views/execution") return Response.json({ rows: [] });
    if (url.pathname === "/api/scopes") return Response.json({ missions: [] });
    return Response.json([]);
  }) as typeof fetch });
  const live = createLiveRefresh({ now: () => now, onFrame: () => {},
    hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, undefined, undefined, undefined, state) });
  return { client, live, requests, setFailure: (route: string, mode: Failure) => { failure = { route, mode }; },
    recover: () => { failure = undefined; }, tick: () => { now += 1000; } };
}

describe("optional blocker enrichment through the production page composition", () => {
  it.each([false, true])("canonical human precedence prevents local lookup and false owner (collision=%s)", async collide => {
    const humanRefs = [
      "qitem-founder@external", "qitem-slack:UCONTROL@external",
      "qitem-name.part_suffix@external", "qitem-@external",
      "human-founder@kernel", "human-qitem@host", "slack:UCONTROL@external",
    ];
    expect(humanRefs.every(isHumanSeatSession)).toBe(true);
    const f = fixture(humanRefs, collide);
    try {
      await f.live.refresh();
      const humans = f.live.snapshot().blocked.filter(q => q.qitemId.startsWith("qitem-human-"));
      expect(humans.map(q => q.blockedOn)).toEqual(humanRefs);
      expect(humans.map(q => q.blockerSession ?? null)).toEqual(humanRefs.map(() => null));
      for (const ref of humanRefs) expect(f.requests).not.toContain(`/api/queue/${encodeURIComponent(ref)}`);
      expect(f.live.snapshot().blocked.find(q => q.blockedOn === "qitem-present")?.blockerSession).toBe("reviewer@rig");
      expect(f.live.snapshot().readErrors).toEqual([]);
      expect(f.live.load()).toMatchObject({ stale: false, lastSuccessAt: 1000 });
    } finally { f.live.close(); }
  });

  it("loads valid gates and missing local owners without false page failure or fabricated owners", async () => {
    const f = fixture();
    try {
      await f.live.refresh();
      expect(f.live.snapshot().readErrors).toEqual([]);
      expect(f.live.load()).toMatchObject({ settled: true, stale: false, lastSuccessAt: 1000 });
      expect(f.live.snapshot().blocked.map(q => q.blockedOn)).toEqual(refs);
      for (const q of f.live.snapshot().blocked) {
        expect(q.blockerSession ?? null).toBe(q.blockedOn === "qitem-present" ? "reviewer@rig" : null);
      }
      for (const gate of gates) expect(f.requests).not.toContain(`/api/queue/${encodeURIComponent(gate)}`);
      expect(f.requests).toContain("/api/queue/qitem-present");
      expect(f.requests).toContain("/api/queue/qitem-missing");
    } finally { f.live.close(); }
  });

  it.each<Failure>([403, 404, 503, "timeout"])("optional owner %s becomes unresolved without retaining a former owner", async mode => {
    const f = fixture();
    try {
      await f.live.refresh();
      f.setFailure("/api/queue/qitem-present", mode); f.tick(); await f.live.refresh();
      expect(f.live.snapshot().blocked.find(q => q.blockedOn === "qitem-present")?.blockerSession).toBeNull();
      expect(f.live.snapshot().readErrors).toEqual([]);
      expect(f.live.load()).toMatchObject({ stale: false, lastSuccessAt: 2000 });
      expect(f.live.load().retainedAt).toBeUndefined();
    } finally { f.live.close(); }
  });

  it.each<Failure>([403, 404, 503, "timeout"])("required blocked list %s remains a failure, retains only transient failures, and recovers", async mode => {
    const f = fixture();
    try {
      await f.live.refresh();
      f.setFailure("/api/queue/list?state=blocked", mode); f.tick(); await f.live.refresh();
      const transient = mode === 503 || mode === "timeout";
      expect(f.live.snapshot().blocked.length).toBe(transient ? blocked.length : 0);
      expect(f.live.snapshot().readErrors.join()).toContain("/api/queue/list");
      expect(f.live.load()).toMatchObject({ stale: true, lastSuccessAt: 1000 });
      expect(f.live.load().retainedAt).toBe(transient ? 1000 : undefined);
      f.recover(); f.tick(); await f.live.refresh();
      expect(f.live.snapshot().blocked).toHaveLength(blocked.length);
      expect(f.live.snapshot().readErrors).toEqual([]);
      expect(f.live.load()).toMatchObject({ stale: false, lastSuccessAt: 3000 });
    } finally { f.live.close(); }
  });

  it.each<Failure>([403, 404, 503, "timeout"])("direct detail %s still records failure even after optional reads of the same URL", async mode => {
    const f = fixture(); let direct = false; let now = 1000;
    const live = createLiveRefresh({ now: () => now, onFrame: () => {}, hydrate: async (page, signal) => {
      const client = f.client.forPage(page, signal);
      if (!direct) return hydrateSnapshot(client, undefined, undefined, undefined, undefined, state);
      const result = await client.queueItem("qitem-present").catch(() => null);
      return { ...emptySnapshot(), stream: result ? [{ tsEmitted: "", sourceSession: "", body: JSON.stringify(result) }] : [] };
    } });
    try {
      await live.refresh(); direct = true;
      f.setFailure("/api/queue/qitem-present", mode); now = 2000; await live.refresh();
      expect(live.snapshot().stream).toEqual([]); // optional success did not seed required retention
      expect(live.snapshot().readErrors.join()).toContain("/api/queue/qitem-present");
      expect(live.load()).toMatchObject({ stale: true, lastSuccessAt: 1000 });
      f.recover(); now = 3000; await live.refresh();
      expect(live.snapshot().stream).toHaveLength(1);
      expect(live.load()).toMatchObject({ stale: false, lastSuccessAt: 3000 });
      f.setFailure("/api/queue/qitem-present", mode); now = 4000; await live.refresh();
      const transient = mode === 503 || mode === "timeout";
      expect(live.snapshot().stream.length).toBe(transient ? 1 : 0);
      expect(live.load()).toMatchObject({ stale: true, lastSuccessAt: 3000 });
      expect(live.load().retainedAt).toBe(transient ? 3000 : undefined);
    } finally { live.close(); f.live.close(); }
  });
});

it.each<Failure>([403, 404, 503, "timeout"])("required file %s preserves refusal versus transient retention and recovers", async mode => {
  let failing = false; let now = 1000;
  const file = { root: "workspace", path: "SPEC.md", absolutePath: "/fixture/SPEC.md", content: "Authored content", mtime: "2026-09-11T00:00:00Z", contentHash: "fixture", truncated: false };
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async input => {
    if (new URL(String(input)).pathname === "/api/files/roots") return Response.json({ roots: [] });
    return failing ? fail(mode) : Response.json(file);
  }) as typeof fetch });
  const view = { ...state, file: { root: "workspace", path: "SPEC.md" } };
  const live = createLiveRefresh({ now: () => now, onFrame: () => {},
    hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, undefined, undefined, undefined, view) });
  try {
    await live.refresh(); failing = true; now = 2000; await live.refresh();
    const transient = mode === 503 || mode === "timeout";
    expect(live.snapshot().fileRead?.result).toMatchObject(transient ? { content: file.content } : { error: "fixture_failure" });
    expect(live.snapshot().readErrors.join()).toContain("/api/files/read");
    expect(live.load()).toMatchObject({ stale: true, lastSuccessAt: 1000 });
    expect(live.load().retainedAt).toBe(transient ? 1000 : undefined);
    failing = false; now = 3000; await live.refresh();
    expect(live.snapshot().readErrors).toEqual([]);
    expect(live.load()).toMatchObject({ stale: false, lastSuccessAt: 3000 });
  } finally { live.close(); }
});
