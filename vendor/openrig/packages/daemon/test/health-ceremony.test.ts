import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { HealthCheckpointSource } from "../src/domain/health-checkpoints.js";
import { HealthProjectionService, LiveContextHealthSource } from "../src/domain/health-detectors.js";

import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { HealthDiagnosisService } from "../src/domain/health-diagnosis.js";
import { healthAuthority } from "../src/domain/health-context.js";
import { delegatedPostureFixture } from "./helpers/delegated-posture.js";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).reverse().forEach((f) => f()));
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "health-ceremony-"));
  const workspace = join(home, "workspace"); mkdirSync(workspace);
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanups.push(() => db.close());
  const queue = new QueueRepository(db, new EventBus(db));
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const root = await queue.create({ qitemId: "product-root", sourceSession: "author@rig", destinationSession: "builder@rig", body: "Build one outcome", nudge: false });
  let parent = root.qitemId;
  const all = [parent];
  for (let i = 0; i < 8; i++) {
    const child = await queue.create({ qitemId: `review-${i}`, handedOffFrom: parent, sourceSession: "builder@rig", destinationSession: "reviewer@rig", body: "Review the same outcome", tags: [i % 2 ? "gate:r2" : "gate:qa"], nudge: false });
    queue.update({ qitemId: child.qitemId, actorSession: "reviewer@rig", state: "in-progress" });
    queue.update({ qitemId: child.qitemId, actorSession: "reviewer@rig", state: "done", closureReason: "no-follow-on" });
    parent = child.qitemId; all.push(parent);
  }
  const transitions = all.flatMap((id) => queue.listTransitions(id));
  let now = new Date().toISOString();
  writeFileSync(join(workspace, "outcome.md"), "One delivered outcome, all review corrections belong to it.");
  writeFileSync(join(workspace, "expectation.md"), "One whole-outcome review at completion; no per-increment gates.");
  const source = new HealthCheckpointSource(home, queue, policy, () => now);
  const projection = new HealthProjectionService(source, () => policy.read());
  const cp = { schema: "openrig.health-checkpoint/v0alpha1", lineageQitemId: root.qitemId, includeHandoffs: true,
    scope: { type: "rig", rigId: "rig" }, startedAt: transitions[0]!.ts, observedAt: now,
    transitionIds: transitions.map((t) => t.transitionId), productOutcomes: [{ id: "outcome", observedAt: now, evidenceRef: "outcome.md" }],
    productCensusRef: "outcome.md", boundedAuthority: { applies: false, evidenceRef: "outcome.md" },
    sdlc: { expectation: "One whole-outcome review at completion", evidenceRef: "expectation.md" },
    authorityPaths: { project: [], mission: [], slice: [] } };
  return { home, workspace, db, queue, policy, source, projection, cp, tick: (ms: number) => { now = new Date(Date.parse(now) + ms).toISOString(); return now; } };
}

it("follows real handoffs: the root alone is below threshold while the exact family exposes ceremony", async () => {
  const t = await setup();
  expect(t.queue.listTransitions(t.cp.lineageQitemId)).toHaveLength(1);
  t.source.submit(t.cp, "author@rig");
  const changes = t.db.prepare("SELECT total_changes() AS n").get();
  const first = t.projection.list().records[0]!;
  expect(first).toMatchObject({ status: "active", detector: "process.ceremony-amplification", confidence: "medium" });
  expect(first.explanation).toContain("25 coordination transitions for 1 product-state change");
  expect(first.explanation).toContain("9 qitems");
  expect(first.explanation).toContain("gate:qa=12");
  expect(first.explanation).toContain("gate:r2=12");
  expect(first.explanation).toContain(t.cp.sdlc.expectation);
  expect(first.evidence.filter((e) => e.type === "queue-transition")).toHaveLength(25);
  expect(t.projection.get(first.id)).toEqual(first);
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
});

it("refuses omitted descendants and does not infer a family from similar names", async () => {
  const t = await setup();
  await t.queue.create({ qitemId: "product-root-lookalike", sourceSession: "author@rig", destinationSession: "builder@rig", body: "Unrelated", nudge: false });
  expect(() => t.source.submit({ ...t.cp, transitionIds: t.cp.transitionIds.slice(0, 1) }, "author@rig")).toThrow("census");
  t.source.submit(t.cp, "author@rig");
  expect(t.projection.list().records[0]!.evidence.some((e) => e.type === "queue-transition" && e.qitemId.endsWith("lookalike"))).toBe(false);
});

it("missing SDLC expectation is indeterminate, including legacy single-row checkpoints", async () => {
  const t = await setup();
  const { sdlc: _sdlc, ...without } = t.cp;
  t.source.submit(without, "author@rig");
  expect(t.projection.list().records[0]!.status).toBe("indeterminate");
  expect(t.projection.list().records[0]!.explanation).toContain("SDLC expectation unavailable");
  t.source.submit({ ...t.cp, observedAt: t.tick(1), sdlc: { ...t.cp.sdlc, evidenceRef: "missing.md" } }, "author@rig");
  expect(t.projection.list().records[0]!.status).toBe("indeterminate");
});

it("preserves one episode across refresh, bounded authority clears it, and recurrence starts a new one", async () => {
  const t = await setup(); t.source.submit(t.cp, "author@rig");
  const id = t.projection.list().records[0]!.id;
  t.source.submit({ ...t.cp, observedAt: t.tick(1) }, "author@rig");
  expect(t.projection.get(id)?.status).toBe("active");
  t.source.submit({ ...t.cp, observedAt: t.tick(1), boundedAuthority: { applies: true, evidenceRef: "outcome.md" } }, "author@rig");
  expect(t.projection.list().records).toEqual([]);
  expect(t.projection.get(id)?.status).toBe("cleared");
  t.source.submit({ ...t.cp, observedAt: t.tick(1) }, "author@rig");
  expect(t.projection.list().records[0]!.id).not.toBe(id);
});

it("resolves diagnosis authority by episode when the root has no transition inside the window", async () => {
  const t = await setup();
  t.db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run("2026-01-01T00:00:00.000Z", t.cp.lineageQitemId);
  const dir = join(t.workspace, "missions", "mission", "slices", "work"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SPEC.md"), "---\nid: slice-1\nmission: mission\n---\n# One outcome");
  t.source.submit({ ...t.cp, scope: { type: "slice", projectId: "project", missionId: "mission", sliceId: "slice-1" },
    transitionIds: t.cp.transitionIds.slice(1), authorityPaths: { project: [], mission: [], slice: ["missions/mission/slices/work/SPEC.md"] } }, "author@rig");
  const finding = t.projection.list().records[0]!;
  expect(finding.evidence.some((e) => e.type === "queue-transition" && e.qitemId === t.cp.lineageQitemId)).toBe(false);
  expect(healthAuthority(t.workspace, t.source, finding)).toContainEqual(expect.objectContaining({ level: "slice", state: "available" }));
});

it("bounds recursive traversal even when the handoff family exceeds the admitted size", async () => {
  const t = await setup();
  const insert = t.db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,handed_off_from,body) VALUES(?,?,?,'a@r','b@r','done',?,'fixture')");
  t.db.transaction(() => { for (let i = 0; i < 1001; i++) insert.run(`large-${i}`, t.cp.startedAt, t.cp.startedAt, t.cp.lineageQitemId); })();
  expect(() => t.queue.transitionLog.listForHandoffWindow(t.cp.lineageQitemId, t.cp.startedAt, t.cp.observedAt, 10001)).toThrow("health_checkpoint_lineage_limit");
});

it("100 live-source context seats remain quiet below 95, clear naturally, and never compete with delegated ceremony admission", async () => {
  const t = await setup(); const rigs = new RigRepository(t.db); const sessions = new SessionRegistry(t.db);
  const rig = rigs.createRig("context-scale"); const samples = new UsageSamplesStore(t.db);
  const base = Date.now() - 60000;
  const seats = Array.from({ length: 100 }, (_, i) => {
    const node = rigs.addNode(rig.id, `seat-${i}`, { role: "worker" });
    const session = sessions.registerSession(node.id, `seat-${i}@context-scale`);
    t.db.prepare("UPDATE occupant_tenures SET boot_at = ? WHERE node_id = ?").run(new Date(base - 1000).toISOString(), node.id);
    return { node, session };
  });
  const write = (percent: number, offset: number) => t.db.transaction(() => {
    const at = new Date(base + offset).toISOString();
    for (const { node, session } of seats) {
      t.db.prepare(`INSERT INTO context_usage(node_id,session_id,session_name,availability,source,used_percentage,sampled_at)
        VALUES(?,?,?,'known','codex_token_count_jsonl',?,?) ON CONFLICT(node_id) DO UPDATE SET used_percentage=excluded.used_percentage,sampled_at=excluded.sampled_at`)
        .run(node.id, session.id, session.sessionName, percent, at);
      samples.appendContextSample({ nodeId: node.id, seatSession: session.sessionName, source: "codex_token_count_jsonl", sampledAt: at, totalInputTokens: 200000, totalOutputTokens: 0, usedPercentage: percent }, at);
    }
  })();
  const context = new LiveContextHealthSource({ db: t.db, rigRepo: rigs, sessionRegistry: sessions, contextUsageStore: new ContextUsageStore(t.db, { stateDir: t.home }) });
  const projection = new HealthProjectionService({ read: () => [...context.read(), ...t.source.read()] }, () => t.policy.read(), delegatedPostureFixture);
  write(94, 0); expect(projection.list({ limit: 200 }).total).toBe(0);
  write(95, 10000); const ids = projection.list({ limit: 200 }).records.map((r) => r.id);
  expect(ids).toHaveLength(100);
  write(96, 20000); expect(projection.list({ limit: 200 }).records.map((r) => r.id)).toEqual(ids);
  t.source.submit(t.cp, "author@rig");
  const p = t.policy.read().policy; t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig", detectors: ["process.ceremony-amplification", "context.pressure"] } }, "author@rig");
  const service = new HealthDiagnosisService({ queue: t.queue, projection, policy: t.policy, authority: () => [] });
  const before = t.db.prepare("SELECT total_changes() AS n").get();
  expect(projection.list({ limit: 1 }).records[0]!.detector).toBe("process.ceremony-amplification");
  expect(projection.list({ limit: 200 }).records.filter((r) => r.detector === "context.pressure")).toHaveLength(100);
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  await service.evaluate("author@rig", true); await service.evaluate("author@rig", true);
  expect(service.list()).toHaveLength(1);
  expect(service.list()[0]!.finding.detector).toBe("process.ceremony-amplification");
  write(30, 30000);
  expect(projection.list({ status: "cleared", limit: 200 }).records.map((r) => r.id)).toEqual(ids);
  expect(projection.list().records.filter((r) => r.detector === "context.pressure")).toHaveLength(0);
  await service.evaluate("author@rig", true); expect(service.list()).toHaveLength(1);
});

it("does not present an unknown denominator as zero or compute a ratio from it", async () => {
  const t = await setup();
  t.source.submit({ ...t.cp, productCensusRef: "missing.md" }, "author@rig");
  const finding = t.projection.list().records[0]!;
  expect(finding.status).toBe("indeterminate");
  expect(finding.explanation).toContain("no ratio is computed");
  expect(finding.explanation).not.toContain("25.0:1");
  expect(finding.summary).toContain("indeterminate");
});

it("unavailable suppression evidence cannot hide a potential condition", async () => {
  const t = await setup();
  t.source.submit({ ...t.cp, boundedAuthority: { applies: true, evidenceRef: "missing-authority.md" } }, "author@rig");
  expect(t.projection.list().records[0]!.status).toBe("indeterminate");
});

it("derives and retains the complete census once without making the author enumerate handoffs", async () => {
  const t = await setup(); const input = { ...t.cp, transitionIds: "derive" };
  const first = t.source.submit(input, "author@rig");
  expect(first.checkpoint.transitionIds).toEqual(t.cp.transitionIds);
  expect(input.transitionIds).toBe("derive");
  expect(t.source.submit(input, "author@rig")).toEqual(first);
  expect(t.source.entries()[0]!.checkpoint.transitionIds).toEqual(t.cp.transitionIds);
});

it("refuses an explicitly different slice in a handoff census rather than mixing its product scope", async () => {
  const t = await setup();
  t.db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify(["slice:another-slice"]), "review-7");
  expect(() => t.source.submit({ ...t.cp, scope: { type: "slice", projectId: "project", missionId: "mission", sliceId: "slice-1" } }, "author@rig")).toThrow("crosses the declared checkpoint scope");
});
