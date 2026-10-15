import type { Migration } from "../migrate.js";

/** Keep inventory folds on their event types instead of scanning activity history.
 * Fleet and rig restore reads need different leading keys to retain their order. */
export const inventoryEventIndexesSchema: Migration = {
  name: "084_inventory_event_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_events_restore_seq ON events(seq DESC)
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled');
    CREATE INDEX IF NOT EXISTS idx_events_restore_rig_seq ON events(rig_id, seq DESC)
      WHERE type IN ('restore.completed', 'restore.subset_completed', 'restore.outcome_reconciled');
    CREATE INDEX IF NOT EXISTS idx_events_startup_node_seq ON events(node_id, seq DESC)
      WHERE type IN ('node.startup_challenged','node.startup_proof_skipped','node.startup_proof_verified','node.startup_proof_rejected');
  `,
};
