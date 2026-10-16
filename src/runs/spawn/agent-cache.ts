/**
 * Read-side helpers for the spawn flow: re-validate the cached
 * rendered-agent envelope, resolve operator / project frontmatter
 * overrides, and read the project's `.warren/defaults.json`. Extracted
 * from the legacy `src/runs/spawn.ts` under warren-f71c / pl-9088 step 6.
 */

import {
	type AgentDefinition,
	parseRenderedAgent,
	RenderResponseSchema,
} from "../../registry/schema.ts";
import type {
	DefaultsConfig,
	WarrenConfigCache,
	WarrenConfigFileError,
} from "../../warren-config/index.ts";
import { WarrenConfigInvalidError, warrenConfigRelativePath } from "../../warren-config/index.ts";
import { RunSpawnError } from "../errors.ts";

/**
 * Re-validate the cached row's renderedJson before use. Refresh.ts stores
 * a parsed `AgentDefinition` directly, so the column shape is normally
 * exactly that — but the column type is `unknown`, and a corrupted row
 * shouldn't crash the spawn flow with a TypeError. If the cache holds the
 * raw `cn render` envelope (older registry refresh path), fall back to
 * parsing it.
 */
export function readCachedAgent(raw: unknown, name: string): AgentDefinition {
	if (typeof raw !== "object" || raw === null) {
		throw new RunSpawnError(`cached agent "${name}" has malformed renderedJson`);
	}
	const candidate = raw as Record<string, unknown>;
	if (
		typeof candidate.name === "string" &&
		typeof candidate.version === "number" &&
		typeof candidate.sections === "object" &&
		candidate.sections !== null &&
		!Array.isArray(candidate.sections)
	) {
		const sections = candidate.sections as Record<string, unknown>;
		for (const [key, value] of Object.entries(sections)) {
			if (typeof value !== "string") {
				throw new RunSpawnError(`cached agent "${name}" has non-string section "${key}"`);
			}
		}
		return {
			name: candidate.name,
			version: candidate.version,
			sections: sections as Record<string, string>,
			resolvedFrom: Array.isArray(candidate.resolvedFrom)
				? candidate.resolvedFrom.filter((s): s is string => typeof s === "string")
				: [],
			frontmatter:
				typeof candidate.frontmatter === "object" &&
				candidate.frontmatter !== null &&
				!Array.isArray(candidate.frontmatter)
					? (candidate.frontmatter as Record<string, unknown>)
					: {},
		};
	}
	if (RenderResponseSchema.safeParse(raw).success) {
		return parseRenderedAgent(raw, name);
	}
	throw new RunSpawnError(`cached agent "${name}" does not match AgentDefinition shape`);
}

/**
 * Which layer supplied an effective provider/model (warren-9663). Surfaced on
 * the `spawn.dispatched` log line so a silently-stamped project default is
 * visible at a glance instead of only showing up as a provider 401 two
 * seconds later.
 */
export type ProviderSource = "override" | "agent" | "project-default";

export interface AxisResolution {
	/**
	 * The value to stamp onto the rendered agent frontmatter. `undefined`
	 * means "stamp nothing" — the agent's own frontmatter stays in force.
	 */
	readonly value: string | undefined;
	readonly source: ProviderSource;
}

/**
 * Resolve one provider/model axis for a spawn (warren-9663).
 *
 * Precedence:
 *   1. an explicit per-run `providerOverride` / `modelOverride` — always wins;
 *   2. the agent's own frontmatter value — BUT only when the caller named the
 *      agent explicitly (an `agent` field on `POST /runs`). Naming an agent
 *      means "run this agent", so its own provider/model must not be replaced
 *      by the project's `defaultProvider` / `defaultModel`;
 *   3. the project default (`defaultProvider` / `defaultModel`), which stays
 *      in force for role-based dispatches (a `defaultRole` scheduled seed, the
 *      CI-fixer, plan-runs) — those never name the agent, so a project-wide
 *      provider the operator pinned is exactly what they asked for.
 *
 * Empty / whitespace-only strings are treated the same as "not provided"
 * (matches `withProviderOverrides`'s shape). When no layer supplies a value
 * the axis resolves to `{ source: "agent" }` with no stamp, leaving the
 * agent's frontmatter (or the runtime default) untouched.
 */
export function resolveProviderAxis(
	operator: string | undefined,
	projectDefault: string | undefined,
	agentValue: string | undefined,
	explicitAgent: boolean,
): AxisResolution {
	const op = operator?.trim();
	if (op !== undefined && op !== "") return { value: op, source: "override" };
	const av = agentValue?.trim();
	if (explicitAgent && av !== undefined && av !== "") return { value: undefined, source: "agent" };
	const pd = projectDefault?.trim();
	if (pd !== undefined && pd !== "") return { value: pd, source: "project-default" };
	return { value: undefined, source: "agent" };
}

/**
 * The `.warren/` files that carry dispatch guardrails: the admission cap,
 * the quality gate, the resource limits, and the cost caps all live in the
 * global-defaults tier. A parse / schema failure in either tier means the
 * project HAS a policy we could not read (warren-02aa).
 *
 * `triggers.yaml` and `pr-template.md` are deliberately NOT in this list.
 * Neither constrains what a dispatched run may do, so a typo there keeps
 * degrading gracefully the way it always has.
 */
const GUARDRAIL_CONFIG_FILES: readonly string[] = [
	warrenConfigRelativePath("config"),
	warrenConfigRelativePath("defaults"),
];

/**
 * Fail closed on a present-but-unreadable guardrail file (warren-02aa).
 *
 * `DefaultsConfigSchema` is `.strict()`, so one unknown key rejects the
 * whole document and `loadWarrenConfig` yields `defaults: null` plus an
 * `errors[]` entry. Before this guard every consumer optional-chained past
 * that null and dispatched with no cap, no gate, no limits, and no spend
 * ceiling — the loudest possible failure rendered as the quietest possible
 * behavior.
 *
 * We keep whole-document strictness rather than salvaging section by
 * section. Per-section validation would still drop the very knob the
 * operator fat-fingered (`admission.maxConcurrentRun` silently uncaps the
 * project), which is the same bug in a smaller blast radius. Whole-document
 * strictness plus a dispatch-blocking failure is the only shape where a
 * typo cannot widen a guardrail.
 *
 * A project with NO config file at all is untouched: the loader reports no
 * errors, and dispatch proceeds on built-in defaults exactly as before.
 */
export function assertGuardrailConfigUsable(
	errors: readonly WarrenConfigFileError[],
	projectId: string,
): void {
	const blocking = errors.filter((err) => GUARDRAIL_CONFIG_FILES.includes(err.file));
	if (blocking.length === 0) return;
	const detail = blocking.map((err) => `${err.file}: ${err.message}`).join("; ");
	throw new WarrenConfigInvalidError(
		`project ${projectId} has an unreadable guardrail config, refusing dispatch — ${detail}`,
		{
			recoveryHint:
				"fix the reported file (unknown keys are rejected) and re-dispatch; " +
				"GET /projects/:id/warren-config shows the same errors",
		},
	);
}

/**
 * Load the project's global-defaults envelope through the cache.
 *
 * Returns `null` when no cache is wired (CLI/tests that don't care about
 * project defaults) or when the whole load failed at the filesystem level —
 * a vanished clone surfaces on the refresh path with a better error.
 *
 * Throws `WarrenConfigInvalidError` when a guardrail file exists but failed
 * to parse or validate (warren-02aa). Dispatch must not proceed as if the
 * project had no policy.
 */
export async function readProjectDefaults(
	cache: WarrenConfigCache | undefined,
	projectId: string,
	projectPath: string,
): Promise<DefaultsConfig | null> {
	if (cache === undefined) return null;
	let envelope: Awaited<ReturnType<WarrenConfigCache["get"]>>;
	try {
		envelope = await cache.get(projectId, projectPath);
	} catch {
		// Project clone vanished or .warren/ I/O errored — leave the agent
		// frontmatter as the final source of truth and let the rest of the
		// flow surface any project-state failure on its own path.
		return null;
	}
	assertGuardrailConfigUsable(envelope.errors, projectId);
	return envelope.defaults;
}
