import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.4.19 FR-5 — queue_items.evidence_ref column.
 *
 * Adds `evidence_ref TEXT` (NULLABLE) to queue_items: a pointer to the
 * durable artifact a human judges when the item is human-routed (convention
 * C3), authored via `--evidence-ref` on `rig queue create` / `handoff` and
 * persistable at park time (`rig queue block`, FR-6). Follows the 044
 * summary-column pattern exactly: additive, nullable, defensive
 * detectQueueColumn read so pre-048 fixtures degrade.
 *
 * NULLABLE by contract: required ONLY for human-routed items (the §5
 * predicate, enforced at the domain write path — FR-4/FR-5), so ordinary
 * agent-to-agent rows stay NULL forever (BR-1 zero-friction). Do NOT make
 * this NOT NULL or add a default.
 */
export const queueItemEvidenceRefSchema: Migration = {
  name: "048_queue_item_evidence_ref.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN evidence_ref TEXT;
  `,
};
