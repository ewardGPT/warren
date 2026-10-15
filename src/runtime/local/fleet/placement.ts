/**
 * Where a fleet run goes.
 *
 * The decision is deliberately small and pure, because it is the one place that
 * decides how a fleet's capacity is used:
 *
 *   1. Only HEALTHY boxes are candidates. An unreachable box is not a slow box;
 *      dispatching to it produces a run that dies at the first call.
 *   2. Among those, the box with the fewest live workspaces wins — least-loaded,
 *      so three boxes fill in a step rather than stacking on the first one.
 *   3. Ties break on box id, ascending. Determinism matters more than fairness
 *      here: the same inputs must produce the same placement, so a test can pin
 *      it and a bug report is reproducible.
 *
 * Capacity is counted per PROJECT when the caller knows it (`projectLive`). Two
 * runs of the same project on one box compete for the same clone and the same
 * git index, so a box that already runs project P counts as full for P even
 * when it has room for other work.
 */

export interface BoxCandidate {
	readonly id: string;
	readonly healthy: boolean;
	/** Live workspaces on the box right now. */
	readonly live: number;
	/** Live workspaces on the box for THIS project, when the caller knows it. */
	readonly projectLive?: number;
}

export interface PlacementOptions {
	/** A box already carrying this many runs for this project is skipped. */
	readonly projectLimit?: number;
	/** A box already carrying this many runs in total is skipped. */
	readonly boxLimit?: number;
}

/** The chosen box id, or `null` when no candidate can take the run. */
export function chooseBox(
	candidates: readonly BoxCandidate[],
	options: PlacementOptions = {},
): string | null {
	const usable = candidates.filter((candidate) => isUsable(candidate, options));
	if (usable.length === 0) return null;
	let best = usable[0] as BoxCandidate;
	for (const candidate of usable.slice(1)) {
		if (compare(candidate, best) < 0) best = candidate;
	}
	return best.id;
}

function isUsable(candidate: BoxCandidate, options: PlacementOptions): boolean {
	if (!candidate.healthy) return false;
	if (options.boxLimit !== undefined && candidate.live >= options.boxLimit) return false;
	const projectLive = candidate.projectLive ?? 0;
	if (options.projectLimit !== undefined && projectLive >= options.projectLimit) return false;
	return true;
}

/** Fewer total runs first, then fewer for this project, then id ascending. */
function compare(a: BoxCandidate, b: BoxCandidate): number {
	if (a.live !== b.live) return a.live - b.live;
	const aProject = a.projectLive ?? 0;
	const bProject = b.projectLive ?? 0;
	if (aProject !== bProject) return aProject - bProject;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
