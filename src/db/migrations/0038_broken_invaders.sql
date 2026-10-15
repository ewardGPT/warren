CREATE INDEX `runs_started_idx` ON `runs` ("started_at" DESC);--> statement-breakpoint
-- ubuntu-b968: `events_kind_ts_idx` was declared by 0037 but never landed on the
-- live database. Drizzle's migrator does not test the entry's hash: it skips any
-- journal entry whose `when` is <= the max `created_at` already present in
-- `__drizzle_migrations`. The live ledger's watermark (1788471838003) sits above
-- 0037's `when` (1785708464013), so 0037 — and 0028-0036 with it — was silently
-- classified as applied while its hash is in fact absent. Backfill the index
-- here so a database in that state converges. IF NOT EXISTS keeps a fresh
-- database (which does replay 0037 in order) from erroring on a duplicate.
CREATE INDEX IF NOT EXISTS `events_kind_ts_idx` ON `events` (`kind`,`ts`);
