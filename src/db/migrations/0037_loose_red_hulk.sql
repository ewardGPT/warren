CREATE TABLE `graph_run_children` (
	`id` text PRIMARY KEY NOT NULL,
	`graph_run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`phase` text NOT NULL,
	`run_id` text,
	`state` text NOT NULL,
	`file_path` text,
	`finding_json` text,
	FOREIGN KEY (`graph_run_id`) REFERENCES `graph_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `graph_run_children_graph_run_idx` ON `graph_run_children` (`graph_run_id`,`state`);--> statement-breakpoint
CREATE INDEX `graph_run_children_run_idx` ON `graph_run_children` (`run_id`);--> statement-breakpoint
CREATE TABLE `graph_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`template` text NOT NULL,
	`agent_name` text DEFAULT 'claude-code' NOT NULL,
	`state` text NOT NULL,
	`scope_json` text NOT NULL,
	`verify_enabled` integer NOT NULL,
	`synthesize_enabled` integer NOT NULL,
	`max_fan_out` integer DEFAULT 16 NOT NULL,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `graph_runs_project_state_idx` ON `graph_runs` (`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `graph_runs_state_idx` ON `graph_runs` (`state`);--> statement-breakpoint
ALTER TABLE `runs` ADD `merge_wait_started_at` text;--> statement-breakpoint
ALTER TABLE `triggers` ADD `fire_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `triggers` ADD `completed_at` text;