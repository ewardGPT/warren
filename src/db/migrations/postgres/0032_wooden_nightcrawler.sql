CREATE INDEX "runs_started_idx" ON "runs" USING btree ("started_at" DESC);--> statement-breakpoint
-- ubuntu-b968: the postgres migrator uses the same "skip when `when` <= max
-- `created_at`" watermark rule as sqlite, so 0031 (which declares
-- `events_kind_ts_idx`) can be skipped the same way. Backfill idempotently; a
-- fresh database that does replay 0031 is unaffected.
CREATE INDEX IF NOT EXISTS "events_kind_ts_idx" ON "events" USING btree ("kind","ts");
