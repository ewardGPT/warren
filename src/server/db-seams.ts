/**
 * Persistence seams the HTTP layer consumes (warren-89a6).
 *
 * The handlers under `src/server/handlers/` are a thin surface over the
 * domain. They used to reach for the raw driver handle and assemble their own
 * repo on every request — `DrizzleAdapter.for(deps.db)` in `/metrics`,
 * `createRunPreviewsRepo(deps.db)` in `/readyz` and preview teardown. That put
 * persistence wiring inside a request handler and rebuilt it per call.
 *
 * `createDbSeams` builds both once, next to the db handle they wrap.
 * `buildServerDeps` calls it at boot; test helpers call it when they wire a
 * `db`. `check:layers` fails the build on a handler that goes back to
 * constructing a repo out of `deps.db`.
 */

import type { AnyWarrenDb } from "../db/client.ts";
import { DrizzleAdapter } from "../db/repos/drizzle-adapter.ts";
import { createRunPreviewsRepo } from "../preview/eviction/index.ts";
import type { RunPreviewsRepo } from "../preview/eviction/types.ts";

/** The `ServerDeps` fields derived from a live db handle. */
export interface DbSeams {
	readonly dbAdapter: DrizzleAdapter;
	readonly runPreviews: RunPreviewsRepo;
}

/** Build the derived seams for `db`. Spread straight onto a `ServerDeps`. */
export function createDbSeams(db: AnyWarrenDb): DbSeams {
	return {
		dbAdapter: DrizzleAdapter.for(db),
		runPreviews: createRunPreviewsRepo(db),
	};
}
