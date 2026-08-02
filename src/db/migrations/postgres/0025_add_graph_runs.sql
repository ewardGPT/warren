CREATE TABLE "graph_run_children" (
	"id" text PRIMARY KEY NOT NULL,
	"graph_run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"phase" text NOT NULL,
	"run_id" text,
	"state" text NOT NULL,
	"file_path" text,
	"finding_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "graph_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"template" text NOT NULL,
	"agent_name" text DEFAULT 'claude-code' NOT NULL,
	"state" text NOT NULL,
	"scope_json" jsonb NOT NULL,
	"verify_enabled" boolean NOT NULL,
	"synthesize_enabled" boolean NOT NULL,
	"max_fan_out" integer DEFAULT 16 NOT NULL,
	"failure_reason" text,
	"created_at" text NOT NULL,
	"started_at" text,
	"ended_at" text
);
--> statement-breakpoint
ALTER TABLE "graph_run_children" ADD CONSTRAINT "graph_run_children_graph_run_id_graph_runs_id_fk" FOREIGN KEY ("graph_run_id") REFERENCES "public"."graph_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_run_children" ADD CONSTRAINT "graph_run_children_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_runs" ADD CONSTRAINT "graph_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "graph_run_children_graph_run_idx" ON "graph_run_children" USING btree ("graph_run_id","state");--> statement-breakpoint
CREATE INDEX "graph_run_children_run_idx" ON "graph_run_children" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "graph_runs_project_state_idx" ON "graph_runs" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "graph_runs_state_idx" ON "graph_runs" USING btree ("state");