import { ValidationError } from "../../../core/errors.ts";
import { wakeSession } from "../../../runs/session.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { requireParam } from "../index.ts";

/**
 * Reconstitute a run session from Warren's durable event log.
 * `sinceSeq` makes the endpoint suitable for incremental wake/replay.
 */
export function wakeSessionHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const runId = requireParam(ctx, "id");
		const rawSinceSeq = ctx.url.searchParams.get("sinceSeq");
		let sinceSeq = 0;
		if (rawSinceSeq !== null) {
			const parsed = Number(rawSinceSeq);
			if (!Number.isSafeInteger(parsed) || parsed < 0 || rawSinceSeq !== String(parsed)) {
				throw new ValidationError("?sinceSeq must be a non-negative integer");
			}
			sinceSeq = parsed;
		}
		await deps.repos.runs.require(runId);
		const rows = await deps.repos.events.listByRun(runId, sinceSeq === 0 ? {} : { sinceSeq });
		return jsonResponse(200, wakeSession(runId, rows, { sinceSeq }));
	};
}
