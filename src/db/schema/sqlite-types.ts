import type {
	agents,
	events,
	graphRunChildren,
	graphRuns,
	planRunChildren,
	planRuns,
	projects,
	runs,
	triggers,
} from "./sqlite.ts";

export type AgentRow = typeof agents.$inferSelect;
export type AgentInsert = typeof agents.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type RunInsert = typeof runs.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type TriggerRow = typeof triggers.$inferSelect;
export type TriggerInsert = typeof triggers.$inferInsert;
export type PlanRunRow = typeof planRuns.$inferSelect;
export type PlanRunInsert = typeof planRuns.$inferInsert;
export type PlanRunChildRow = typeof planRunChildren.$inferSelect;
export type PlanRunChildInsert = typeof planRunChildren.$inferInsert;
export type GraphRunRow = typeof graphRuns.$inferSelect;
export type GraphRunInsert = typeof graphRuns.$inferInsert;
export type GraphRunChildRow = typeof graphRunChildren.$inferSelect;
export type GraphRunChildInsert = typeof graphRunChildren.$inferInsert;
