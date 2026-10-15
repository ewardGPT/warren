import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionRead } from "@openrig/daemon/attention";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createLiveRefresh } from "../src/live.js";
import { createViewState } from "../src/state.js";
import { pageReadKey } from "../src/page-read.js";

const item = (id: string, summary = id): AttentionItem => ({ id, summary,
  kind: id.startsWith("queue:") ? "action" : "update", urgency: "routine", unblocks: null,
  at: "2026-09-10T00:00:00Z", project: id.startsWith("proof:other:") ? { id: "other", root: "/other" } : { id: "book", root: "/book" }, scope: "project book", source: id });
const sources = ["queue", "health", "proof: project book", "mission outcomes"];
const ids = ["queue:request", "health:episode", "proof:book:mission/slices/draft:1", "workflow:mission"];

function fixture(open: string | null = null) {
  let now = 1000, status = 200;
  let state = { ...createViewState({ instanceId: "fixture" }).get(), section: "needs", attentionOpen: open };
  let read: AttentionRead = { scope: "instance", readAt: "baseline", items: ids.map(id => item(id)),
    sources: sources.map(source => ({ source, state: "available", detail: "observed" })),
    detail: open ? { item: item(open), lines: ["Complete request body"], files: [] } : null, detailError: null };
  let sibling = "FYI one";
  const client = new DaemonClient({ fetchImpl: (async input => {
    const url = new URL(String(input));
    if (url.pathname === "/api/attention") return Response.json(read, { status });
    if (url.pathname === "/api/queue/human-updates") return Response.json({ limit: 20, truncated: false, items: [{
      qitemId: "update", summary: sibling, body: sibling, humanDetail: null, destinationSession: "reader@external",
      sourceSession: "author@fixture", tags: null, evidenceRef: null, deliveredAt: "today", deliveryReceipt: "posted",
    }] });
    return Response.json({ roots: [] });
  }) as typeof fetch });
  const live = createLiveRefresh({ now: () => now, scopeKey: () => pageReadKey(state), onFrame: () => {},
    hydrate: (page, signal) => hydrateSnapshot(client.forPage(page, signal), undefined, undefined, undefined, undefined, state) });
  return { live, setRead: (next: AttentionRead) => { read = next; }, read: () => read,
    advance: () => { now += 1000; }, status: (next: number) => { status = next; },
    sibling: (next: string) => { sibling = next; }, open: (next: string | null) => { state = { ...state, attentionOpen: next }; } };
}

describe("declared Feed source failures", () => {
  it.each(sources)("retains only failed %s data while siblings advance, then accepts successful removal", async source => {
    const f = fixture();
    try {
      await f.live.refresh();
      const failedId = ids[sources.indexOf(source)]!;
      f.setRead({ ...f.read(), items: ids.filter(id => id !== failedId).map(id => item(id, "Fresh " + id)),
        sources: sources.map(s => ({ source: s, state: s === source ? "unavailable" : "available", detail: "dependency read" })) });
      f.advance(); f.sibling("FYI two"); await f.live.refresh();
      expect(f.live.snapshot().attentionRead?.items.find(i => i.id === failedId)?.summary).toBe(failedId);
      expect(f.live.snapshot().attentionRead?.items.find(i => i.id !== failedId && ids.includes(i.id))?.summary).toMatch(/^Fresh /);
      expect(f.live.snapshot().attentionRead?.items.find(i => i.id === "human-update:update")?.summary).toBe("FYI two");
      expect(f.live.load()).toMatchObject({ stale: true, lastSuccessAt: 1000, retainedAt: 1000 });
      expect(f.live.snapshot().readErrors.join()).toContain(source);
      // A following transport failure must retain the already merged source data.
      f.status(503); f.advance(); await f.live.refresh();
      expect(f.live.snapshot().attentionRead?.items.some(i => i.id === failedId)).toBe(true);
      expect(f.live.load().lastSuccessAt).toBe(1000);
      f.status(200); f.setRead({ ...f.read(), items: [], sources: sources.map(s => ({ source: s, state: "available", detail: "empty" })) });
      f.advance(); await f.live.refresh();
      expect(f.live.snapshot().attentionRead?.items.map(i => i.id)).toEqual(["human-update:update"]);
      expect(f.live.load()).toMatchObject({ stale: false, lastSuccessAt: 4000 });
      expect(f.live.load().retainedAt).toBeUndefined();
    } finally { f.live.close(); }
  });

  it("retains open detail only on a declared failure, not successful removal or another scope", async () => {
    const f = fixture("queue:request");
    try {
      await f.live.refresh();
      const failed = { ...f.read(), items: [], detail: null, detailError: "Selected source unavailable",
        sources: [{ source: "queue", state: "unavailable" as const, detail: "offline" }] };
      f.setRead(failed); f.advance(); await f.live.refresh();
      expect(f.live.snapshot().attentionRead?.detail?.lines).toEqual(["Complete request body"]);
      expect(f.live.load()).toMatchObject({ stale: true, lastSuccessAt: 1000 });
      f.open("queue:another"); f.advance(); await f.live.refresh();
      expect(f.live.snapshot().attentionRead?.detail).toBeNull();
      expect(f.live.snapshot().attentionRead?.items.some(i => i.id === "queue:request")).toBe(false);
      expect(f.live.load().lastSuccessAt).toBeUndefined();
      f.open("queue:request"); f.setRead({ ...failed, sources: [{ source: "queue", state: "available", detail: "removed" }] });
      f.advance(); await f.live.refresh();
      expect(f.live.snapshot().attentionRead?.detail).toBeNull();
      expect(f.live.load()).toMatchObject({ stale: false, lastSuccessAt: 4000 });
    } finally { f.live.close(); }
  });

  it("keeps a successful bounded partial window authoritative", async () => {
    const f = fixture();
    try {
      await f.live.refresh();
      f.setRead({ ...f.read(), items: [item("queue:new")], sources: [{ source: "queue", state: "partial", detail: "1000 row bound" }] });
      f.advance(); await f.live.refresh();
      expect(f.live.snapshot().attentionRead?.items.map(i => i.id)).toEqual(["queue:new", "human-update:update"]);
      expect(f.live.load()).toMatchObject({ stale: false, lastSuccessAt: 2000 });
    } finally { f.live.close(); }
  });

  it.each(["project catalog", "proof: project book/mission", "proof: project book/mission/draft"])("retains dependent outcomes on %s failure while replacing unrelated data", async source => {
    const f = fixture();
    try {
      await f.live.refresh();
      const freshId = source === "project catalog" ? "health:fresh" : "proof:other:mission/slices/draft:1";
      f.setRead({ ...f.read(), items: [item(freshId, "Fresh independent source")],
        sources: [{ source, state: "unavailable", detail: "unreadable" }] });
      f.advance(); await f.live.refresh();
      const items = f.live.snapshot().attentionRead?.items ?? [];
      expect(items.some(i => i.id === ids[2])).toBe(true);
      expect(items.some(i => i.summary === "Fresh independent source")).toBe(true);
      expect(items.some(i => i.id === ids[1])).toBe(false); // successful health absence
    } finally { f.live.close(); }
  });

  it("clears a definitively removed detail within the same page", async () => {
    const f = fixture("queue:request");
    try {
      await f.live.refresh();
      f.setRead({ ...f.read(), items: [], detail: null, detailError: "Removed" });
      f.advance(); await f.live.refresh();
      expect(f.live.snapshot().attentionRead?.detail).toBeNull();
      expect(f.live.snapshot().attentionRead?.detailError).toBe("Removed");
      expect(f.live.load()).toMatchObject({ stale: false, lastSuccessAt: 2000 });
    } finally { f.live.close(); }
  });
});
