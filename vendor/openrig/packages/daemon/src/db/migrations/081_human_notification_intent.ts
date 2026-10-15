import type { Migration } from "../migrate.js";

export const humanNotificationIntentSchema: Migration = {
  name: "081_human_notification_intent.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN human_intent TEXT CHECK (human_intent IN ('decision', 'update'));
    ALTER TABLE queue_items ADD COLUMN human_detail TEXT;
    CREATE INDEX idx_queue_human_intent_updated ON queue_items(human_intent, ts_updated DESC);
  `,
};
