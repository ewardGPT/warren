import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.1.18 — queue_items.summary column.
 *
 * Adds `summary TEXT` (NULLABLE) to queue_items: a short human-readable
 * 1–2 sentence summary of the work, authored on `rig queue create` /
 * `handoff` via `--summary`. The agent-speak `body` (TEXT NOT NULL) stays the
 * source of truth and is unchanged + additive.
 *
 * NULLABLE by contract: all pre-18 rows (and any qitem an author omitted) stay
 * NULL and DEGRADE in the Story consumer — slice-detail-projector.ts builds
 * `summary: r.summary ?? <source→dest + body truncation>` — so StoryEvent.summary
 * (slice 19) stays a non-null string and never breaks. Do NOT make this NOT NULL
 * or backfill a non-degrading default.
 *
 * Base table: 024_queue_items.ts. Numbering note: the slice README named "042",
 * but at the build base (dbe6cce7) 042_rig_archive + 043_resume_provenance
 * already exist — this is the next free number, 044.
 */
export const queueItemSummarySchema: Migration = {
  name: "044_queue_item_summary.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN summary TEXT;
  `,
};
