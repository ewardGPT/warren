import type {
	agents,
	burrows,
	conversations,
	events,
	graphRunChildren,
	graphRuns,
	messages,
	planRunChildren,
	planRuns,
	plots,
	projects,
	runs,
	triggers,
	workers,
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
export type WorkerRow = typeof workers.$inferSelect;
export type WorkerInsert = typeof workers.$inferInsert;
export type BurrowRow = typeof burrows.$inferSelect;
export type BurrowInsert = typeof burrows.$inferInsert;
export type PlanRunRow = typeof planRuns.$inferSelect;
export type PlanRunInsert = typeof planRuns.$inferInsert;
export type PlanRunChildRow = typeof planRunChildren.$inferSelect;
export type PlanRunChildInsert = typeof planRunChildren.$inferInsert;
export type GraphRunRow = typeof graphRuns.$inferSelect;
export type GraphRunInsert = typeof graphRuns.$inferInsert;
export type GraphRunChildRow = typeof graphRunChildren.$inferSelect;
export type GraphRunChildInsert = typeof graphRunChildren.$inferInsert;
export type PlotRow = typeof plots.$inferSelect;
export type PlotInsert = typeof plots.$inferInsert;
export type ConversationRow = typeof conversations.$inferSelect;
export type ConversationInsert = typeof conversations.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
