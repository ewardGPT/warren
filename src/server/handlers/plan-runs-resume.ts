import { ValidationError } from "../../core/errors.ts";
import type { PlanRunRow } from "../../db/schema.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";

async function resumeChildTimeout(deps: ServerDeps, id: string, now: Date, reason: string) {
	const child = (await deps.repos.planRuns.listChildren(id)).find(
		(candidate) => candidate.state === "failed" && candidate.failureReason === reason,
	);
	if (child === undefined || child.runId === null) {
		throw new ValidationError(`plan_run ${id} has no timed-out child to resume`);
	}
	await deps.repos.runs.rearmMergeWait(child.runId, now);
	await deps.repos.planRuns.updateChild({
		planRunId: id,
		seq: child.seq,
		patch: { state: "pr_open", endedAt: null, failureReason: null },
		now,
	});
}

async function resumeParentTimeout(deps: ServerDeps, planRun: PlanRunRow, now: Date) {
	if (planRun.parentRunId === null) {
		throw new ValidationError(`plan_run ${planRun.id} has no parent run to resume`);
	}
	await deps.repos.runs.rearmMergeWait(planRun.parentRunId, now);
}

/** POST /plan-runs/:id/resume — recover a child/parent PR merge timeout. */
export function resumePlanRunHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const planRun = await deps.repos.planRuns.require(id);
		if (planRun.state !== "failed") {
			throw new ValidationError(`plan_run ${id} is not resumable from state '${planRun.state}'`);
		}
		const reason = planRun.failureReason;
		if (reason !== "child_pr_merge_timeout" && reason !== "parent_pr_merge_timeout") {
			throw new ValidationError(
				`plan_run ${id} is not resumable: failure reason '${reason ?? "none"}' is not a PR merge timeout`,
			);
		}
		const now = deps.now?.() ?? new Date();
		if (reason === "child_pr_merge_timeout") await resumeChildTimeout(deps, id, now, reason);
		else await resumeParentTimeout(deps, planRun, now);
		const resumed = await deps.repos.planRuns.transitionTo(id, "running", {
			endedAt: null,
			failureReason: null,
			startedAt: planRun.startedAt ?? now.toISOString(),
		});
		return jsonResponse(200, { planRun: resumed, resumed: true });
	};
}
