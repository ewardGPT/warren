import { z } from "zod";

/** Optional Agent Cortex URL and identity overrides for a project. */
export const CortexConfigSchema = z
	.object({
		natsUrl: z.string().min(1, "cortex.natsUrl must be non-empty if provided").optional(),
		apiUrl: z.string().min(1, "cortex.apiUrl must be non-empty if provided").optional(),
		role: z.string().min(1, "cortex.role must be non-empty if provided").optional(),
		scope: z.string().min(1, "cortex.scope must be non-empty if provided").optional(),
	})
	.strict();

export type CortexConfig = z.infer<typeof CortexConfigSchema>;
