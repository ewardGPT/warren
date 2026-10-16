/**
 * Closure stage of the seed-drain lane (ubuntu-6ab8).
 *
 * Close a drained seed the moment its pull request merges.
 *
 * The seeds store that dispatches is the one that closes: this stage writes
 * only the project that owns the seed, delegated to `closeMergedChildSeed`
 * (`src/plan-runs/close-child-seed.ts`) — the single host-side close warren
 * already runs for plan-run children. It authors a `chore(warren)` commit on
 * that project's default branch through the bot identity (Article VII). An
 * already-closed seed returns `noop` without a commit, so a repeat drain
 * closes nothing twice. Any non-merge outcome is `skipped` with the reason.
 */

import {
	type CloseMergedChildSeedResult,
	closeMergedChildSeed,
} from "../plan-runs/close-child-seed.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { SeedsCliDeps } from "../seeds-cli/index.ts";
import type { SeedDrainOutcome } from "./seed-drain-wait.ts";

export type SeedDrainCloseResult =
	| { readonly kind: "closed"; readonly seedId: string; readonly branch: string }
	| { readonly kind: "noop"; readonly seedId: string }
	| { readonly kind: "skipped"; readonly seedId: string; readonly reason: string };

export interface SeedDrainCloseInput {
	readonly seedId: string;
	readonly outcome: SeedDrainOutcome;
	/** Clone of the project that owns the seed — the store that closes it. */
	readonly projectPath: string;
	readonly defaultBranch: string;
	readonly seedsCli: SeedsCliDeps;
	readonly spawn: SpawnFn;
	readonly gitBinary: string;
	readonly githubToken?: string;
	/** Test seam — defaults to the live `closeMergedChildSeed`. */
	readonly closeFn?: typeof closeMergedChildSeed;
}

/**
 * Close the drained seed when its pull request merged. Any other outcome is
 * `skipped` with the reason, so a caller never closes a seed whose work did
 * not land.
 *
 * Closure is idempotent: the close implementation reports `noop` for a seed
 * that is already closed on the default branch.
 */
export async function closeSeedAfterDrain(
	input: SeedDrainCloseInput,
): Promise<SeedDrainCloseResult> {
	if (input.outcome.kind !== "merged") {
		return { kind: "skipped", seedId: input.seedId, reason: input.outcome.kind };
	}
	const close = input.closeFn ?? closeMergedChildSeed;
	const result: CloseMergedChildSeedResult = await close({
		projectPath: input.projectPath,
		defaultBranch: input.defaultBranch,
		seedId: input.seedId,
		seedsCli: input.seedsCli,
		spawn: input.spawn,
		gitBinary: input.gitBinary,
		...(input.githubToken !== undefined ? { githubToken: input.githubToken } : {}),
	});
	return result.kind === "closed"
		? { kind: "closed", seedId: input.seedId, branch: result.branch }
		: { kind: "noop", seedId: input.seedId };
}
