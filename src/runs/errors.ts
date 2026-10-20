/**
 * Errors specific to the run-spawn / composition flow (docs/design/agent-composition.md).
 *
 * `RunSpawnError` covers anything that goes wrong between "we have an
 * agent + project" and "we have a dispatched burrow run" that isn't
 * already a `BurrowError` (server envelope), `BurrowUnreachableError`
 * (transport), `NotFoundError` (missing agent/project), or
 * `ValidationError` (caller passed bad input). Examples: malformed
 * cached agent JSON, broken `expertise_seed` line, filesystem write
 * failure while seeding the burrow workspace.
 */

import { WarrenError } from "../core/errors.ts";

export class RunSpawnError extends WarrenError {
	readonly code = "run_spawn_error";
}

/** Why the seed-drain lane refused to dispatch a seed (ubuntu-6ab8). */
export const SEED_DRAIN_REFUSAL_REASONS = [
	"seed_not_found",
	"seed_closed",
	"seed_blocked",
	"project_lacks_seeds",
] as const;
export type SeedDrainRefusalReason = (typeof SEED_DRAIN_REFUSAL_REASONS)[number];

/**
 * A seed the drain lane will not dispatch (ubuntu-6ab8): the id resolves to no
 * project, the seed is already closed, one of its blockers is still open, or
 * the project carries no `.seeds/` directory. The reason rides on the code, so
 * a caller routes on it without parsing the message.
 */
export class SeedDrainRefusedError extends WarrenError {
	readonly code: SeedDrainRefusalReason;
	readonly reason: SeedDrainRefusalReason;

	constructor(reason: SeedDrainRefusalReason, message: string) {
		super(message);
		this.code = reason;
		this.reason = reason;
	}
}
