import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { reviewReadIndexesSchema } from "../src/db/migrations/083_review_read_indexes.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

const NOW = "2026-09-11T23:49:05.118Z";
const TODAY = "2026-09-11T00:00:00.000Z";
const THROUGH = ALL_MIGRATIONS.filter(m => m.name <= reviewReadIndexesSchema.name);
const BEFORE = THROUGH.filter(m => m.name < reviewReadIndexesSchema.name);
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database(upgrade = false): Database.Database {
  const db = createDb(); databases.push(db);
  migrate(db, upgrade ? BEFORE : THROUGH);
  return db;
}
function compose(db: Database.Database) {
  // Rig review uses queue/session projections, never the slice indexer.
  return new ReviewGatherer({ db, indexer: null!, now: () => NOW }).composeRig();
}
function seed(db: Database.Database) {
  const insert = db.prepare(`INSERT INTO queue_items
    (qitem_id, ts_created, ts_updated, source_session, destination_session, state, tags, body, summary, blocked_on)
    VALUES (?, ?, ?, 'source@rig', ?, ?, ?, 'retained body', ?, ?)`);
  // Reverse IDs and tied timestamps exercise the existing first-row tie behavior.
  for (const [i, state] of ["pending", "in-progress", "claimed", "blocked", "handed-off", "done", "canceled", "failed", "denied"].entries()) {
    for (const id of ["z", "a"]) insert.run(`${state}-${id}`, TODAY, NOW, `${state}@rig`, state,
      JSON.stringify(["slice:test", "mission:release-test"]), id === "z" ? null : `${state} second`, state === "blocked" ? "external:test" : null);
    if (i > 4) insert.run(`${state}-older`, TODAY, TODAY, `${state}@rig`, state, '["slice:older"]', "older", null);
  }
  insert.run("human", TODAY, NOW, "human:founder", "pending", '["slice:test"]', "Decision", null);
  const transition = db.prepare(`INSERT INTO queue_transitions
    (qitem_id, ts, state, actor_session, closure_reason, closure_target, identity_provenance)
    VALUES (?, ?, 'handed-off', 'source@rig', ?, ?, ?)`);
  transition.run("handed-off-z", NOW, "handed_off_to", "next@rig", "transport:v1");
  transition.run("handed-off-a", NOW, "handed_off_to", null, null);
  transition.run("deleted-item", NOW, "handed_off_to", "other@rig", "transport:v1");
  transition.run("done-a", NOW, "no-follow-on", null, null);
  transition.run("done-z", "2026-09-10T23:59:59.999Z", "handed_off_to", "old@rig", null);
}
function queueBytes(db: Database.Database) {
  return {
    items: db.prepare("SELECT * FROM queue_items ORDER BY qitem_id").all(),
    transitions: db.prepare("SELECT * FROM queue_transitions ORDER BY transition_id").all(),
  };
}
function plans(db: Database.Database) {
  return {
    recent: db.prepare(`EXPLAIN QUERY PLAN SELECT qitem_id FROM queue_items
      WHERE ts_updated >= ? AND state NOT IN (?,?,?,?,?) AND tags LIKE '%"slice:%'`)
      .all(TODAY, "pending", "in-progress", "claimed", "blocked", "handed-off"),
    settled: db.prepare(`EXPLAIN QUERY PLAN SELECT t.qitem_id, t.ts, q.summary FROM queue_transitions t
      LEFT JOIN queue_items q ON q.qitem_id = t.qitem_id
      WHERE t.closure_reason = 'handed_off_to' AND t.ts >= ? ORDER BY t.ts DESC`).all(TODAY),
  };
}
function expectIndexed(db: Database.Database) {
  const p = plans(db);
  expect(JSON.stringify(p.recent)).toContain("idx_queue_items_ts_updated");
  expect(JSON.stringify(p.settled)).toContain("idx_queue_transitions_handoff_ts");
  expect(JSON.stringify(p.settled)).not.toContain("SCAN t");
  expect(JSON.stringify(p.settled)).not.toContain("TEMP B-TREE");
}

describe("083 review read access paths", () => {
  it("fresh install registers just the two indexes and reapplying migrations is inert", () => {
    const db = database(); seed(db);
    expect(BEFORE).toHaveLength(82);
    expect(db.prepare("SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1").get()).toEqual({ name: reviewReadIndexesSchema.name });
    expectIndexed(db);
    const before = { output: compose(db), rows: queueBytes(db), schema: db.prepare("SELECT * FROM schema_migrations ORDER BY name").all() };
    migrate(db, THROUGH);
    expect({ output: compose(db), rows: queueBytes(db), schema: db.prepare("SELECT * FROM schema_migrations ORDER BY name").all() }).toEqual(before);
  });

  it("82 upgrade preserves full composition, nulls, handed-off membership and equal-timestamp ordering", () => {
    const db = database(true); seed(db);
    const before = compose(db), rows = queueBytes(db);
    const indexNames = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map(row => row.name));
    expect(before.agents.rows.some(row => row.sessionName === "handed-off@rig")).toBe(true);
    expect(before.settled.map(row => row.qitemId)).toEqual(["handed-off-z", "handed-off-a", "deleted-item"]);
    expect(before.settled[0]!.summary).toBeNull();
    expect(before.settled[1]!.toSession).toBe("unknown");
    expect(JSON.stringify(plans(db).recent)).toContain("SCAN queue_items");
    migrate(db, THROUGH);
    expectIndexed(db);
    const added = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name").all() as { name: string }[]).map(row => row.name).filter(name => !indexNames.has(name));
    expect(added).toEqual(["idx_queue_items_ts_updated", "idx_queue_transitions_handoff_ts"]);
    expect(queueBytes(db)).toEqual(rows);
    expect(compose(db)).toEqual(before);
  });

  it("queue create, claim, update and transactional handoff maintain the indexed reads", async () => {
    const db = database();
    const repo = new QueueRepository(db, new EventBus(db)); repo.attachOutbox(new OutboxHandler(db));
    const created = await repo.create({ sourceSession: "source@rig", destinationSession: "owner@rig", body: "work", summary: "first", tags: ["slice:test"], nudge: false });
    repo.claim({ qitemId: created.qitemId, destinationSession: "owner@rig" });
    repo.update({ qitemId: created.qitemId, actorSession: "owner@rig", state: "in-progress", transitionNote: "progress" });
    const result = await repo.handoff({ qitemId: created.qitemId, fromSession: "owner@rig", toSession: "review@rig", body: "review", summary: "ready", nudge: false });
    expect(repo.getById(created.qitemId)?.state).toBe("handed-off");
    expect(repo.getById(result.created.qitemId)?.destinationSession).toBe("review@rig");
    const last = db.prepare("SELECT * FROM queue_transitions WHERE closure_reason='handed_off_to' ORDER BY ts DESC").all();
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ qitem_id: created.qitemId, closure_target: "review@rig" });
    expectIndexed(db);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
