ALTER TABLE "runs" ADD COLUMN "merge_wait_started_at" text;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "fire_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "completed_at" text;