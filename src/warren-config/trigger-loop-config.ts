/** Schemas for the loop-engineering trigger kinds (`goal` and `loop`). */

import { z } from "zod";

const TriggerIdSchema = z
	.string()
	.min(1, "id must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"id must be kebab/snake-case (lowercase, digits, dots, dashes, underscores)",
	);
const SeedRefSchema = z.string().min(1, "seed must be non-empty");
const RoleNameSchema = z
	.string()
	.min(1, "role must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"role must be a canopy agent name (lowercase, digits, dots, dashes, underscores)",
	);
const TimezoneSchema = z.string().min(1, "timezone must be non-empty if provided");
const PromptSchema = z.string().min(1, "prompt must be non-empty if provided");
const CronExpressionSchema = z
	.string()
	.min(1, "cron must be non-empty")
	.refine(
		(value) => {
			const tokens = value.trim().split(/\s+/);
			return tokens.length === 5 || tokens.length === 6;
		},
		{ message: "cron must have 5 or 6 whitespace-separated fields" },
	);

/** Run until an independent stop-check says the goal is satisfied. */
export const GoalTriggerSchema = z
	.object({
		id: TriggerIdSchema,
		kind: z.literal("goal"),
		seed: SeedRefSchema.optional(),
		role: RoleNameSchema,
		timezone: TimezoneSchema.optional(),
		prompt: PromptSchema.optional(),
		stopPrompt: z.string().min(1, "stopPrompt must be non-empty").optional(),
		maxRuns: z.number().int().positive().default(10),
		maxCostUsd: z.number().positive("maxCostUsd must be positive").finite().optional(),
	})
	.strict();

/** Fixed-cadence loop with a bounded number of iterations. */
export const LoopTriggerSchema = z
	.object({
		id: TriggerIdSchema,
		kind: z.literal("loop"),
		cron: CronExpressionSchema,
		seed: SeedRefSchema.optional(),
		role: RoleNameSchema,
		timezone: TimezoneSchema.optional(),
		prompt: PromptSchema.optional(),
		maxIterations: z.number().int().positive().default(30),
		maxCostUsd: z.number().positive("maxCostUsd must be positive").finite().optional(),
	})
	.strict();

export type GoalTrigger = z.infer<typeof GoalTriggerSchema>;
export type LoopTrigger = z.infer<typeof LoopTriggerSchema>;
