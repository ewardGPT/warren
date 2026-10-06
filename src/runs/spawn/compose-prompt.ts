/**
 * Dispatch-prompt composition for spawn (extracted from `dispatch.ts` under
 * the per-file line budget, warren-4553).
 *
 * Burrow's claude-code runtime feeds the dispatch prompt to the agent as a
 * single user turn — it never reads `.warren/agent.json` itself, so the
 * canopy `system` body must ride the prompt or it is dead text on disk.
 * `runs.prompt` (warren-side) keeps the user-typed input verbatim; only the
 * body sent on POST /burrows/:id/runs is composed here.
 */

/**
 * Compose the dispatched prompt from the agent's `system` section, the
 * optional seed-relevant prior block (ubuntu-2bb5), and the operator prompt.
 * Each non-empty section joins with a horizontal-rule delimiter, so the
 * model sees the operating contract first and the task last.
 */
export function composeDispatchPrompt(
	systemBody: string | undefined,
	userPrompt: string,
	priorBlock?: string,
): string {
	const sections = [(systemBody ?? "").trim(), (priorBlock ?? "").trim()].filter(
		(section) => section !== "",
	);
	if (sections.length === 0) return userPrompt;
	return `${sections.join("\n\n---\n\n")}\n\n---\n\n${userPrompt}`;
}
