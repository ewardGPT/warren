import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { GraphRunFindingJson, GraphRunScopeJson } from "./columns.ts";
import {
	GRAPH_RUN_CHILD_PHASES,
	GRAPH_RUN_CHILD_STATES,
	GRAPH_RUN_STATES,
	INDEX_NAMES,
	TABLE_NAMES,
} from "./columns.ts";

export function createSqliteGraphTables<
	TProject extends { id: AnySQLiteColumn },
	TRun extends { id: AnySQLiteColumn },
>(tables: { projects: TProject; runs: TRun }) {
	/** Graph-run coordinator state: scoped audits, verification, and synthesis. */
	const graphRuns = sqliteTable(
		TABLE_NAMES.graphRuns,
		{
			id: text("id").primaryKey(),
			projectId: text("project_id")
				.notNull()
				.references(() => tables.projects.id, { onDelete: "cascade" }),
			template: text("template").notNull(),
			agentName: text("agent_name").notNull().default("claude-code"),
			state: text("state", { enum: GRAPH_RUN_STATES }).notNull(),
			scopeJson: text("scope_json", { mode: "json" }).$type<GraphRunScopeJson>().notNull(),
			verifyEnabled: integer("verify_enabled", { mode: "boolean" }).notNull(),
			synthesizeEnabled: integer("synthesize_enabled", { mode: "boolean" }).notNull(),
			maxFanOut: integer("max_fan_out").notNull().default(16),
			failureReason: text("failure_reason"),
			createdAt: text("created_at").notNull(),
			startedAt: text("started_at"),
			endedAt: text("ended_at"),
		},
		(t) => [
			index(INDEX_NAMES.graphRunsProjectState).on(t.projectId, t.state),
			index(INDEX_NAMES.graphRunsState).on(t.state),
		],
	);

	const graphRunChildren = sqliteTable(
		TABLE_NAMES.graphRunChildren,
		{
			id: text("id").primaryKey(),
			graphRunId: text("graph_run_id")
				.notNull()
				.references(() => graphRuns.id, { onDelete: "cascade" }),
			seq: integer("seq").notNull(),
			phase: text("phase", { enum: GRAPH_RUN_CHILD_PHASES }).notNull(),
			runId: text("run_id").references(() => tables.runs.id, { onDelete: "set null" }),
			state: text("state", { enum: GRAPH_RUN_CHILD_STATES }).notNull(),
			filePath: text("file_path"),
			findingJson: text("finding_json", { mode: "json" }).$type<GraphRunFindingJson>(),
		},
		(t) => [
			index(INDEX_NAMES.graphRunChildrenGraphRun).on(t.graphRunId, t.state),
			index(INDEX_NAMES.graphRunChildrenRun).on(t.runId),
		],
	);

	return { graphRuns, graphRunChildren };
}
