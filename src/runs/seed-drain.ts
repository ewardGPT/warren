/**
 * The seed-drain lane (ubuntu-6ab8).
 *
 * One path from a seed id to a closed seed:
 *
 *   1. resolve what the seed needs from the seed itself — its home project
 *      (the registered project whose clone carries `.seeds/` and owns the id)
 *      and, at dispatch time, its own status and blockers;
 *   2. dispatch one run for it, recording `seed_id` on the run row;
 *   3. wait, with a bound, for that run's pull request to merge;
 *   4. close the seed when the PR merges. The seeds store that dispatched the
 *      run is the one that closes it — the lane never writes another
 *      project's `.seeds/issues.jsonl`.
 *
 * Step 4 delegates to `closeMergedChildSeed` (`src/plan-runs/close-child-seed.ts`),
 * the one host-side close warren already runs for plan-run children. It authors
 * a `chore(warren)` commit on the project's default branch through the bot
 * identity (Article VII) and returns `noop` for a seed that is already closed,
 * so a repeat drain closes nothing twice.
 *
 * ## Wait semantics
 *
 * `awaitSeedDrain` is a bounded poll with one outcome for every exit: a run
 * that fails or is cancelled, a run that succeeds without opening a PR, a PR
 * that closes unmerged, a merge, or the deadline. A poll loop with no exit is
 * not an outcome, so the deadline (default {@link DEFAULT_SEED_DRAIN_WAIT_MS})
 * is always armed, and a deadline that arrives while the PR is still open
 * reports `timed_out` with the run state, the failure reason, and the PR URL.
 *
 * ## Composition
 *
 * The stages are separately callable and separately testable; `drainSeed`
 * composes them. Every seam (`spawnRun`, the run-state reader, the merge
 * checker, the close implementation) is injected, so a test drives the whole
 * lane without a sandbox, a database, or GitHub.
 */

import type { Repos } from "../db/repos/index.ts";
import type { closeMergedChildSeed } from "../plan-runs/close-child-seed.ts";
import type { SpawnFn } from "../projects/clone.ts";
import type { ProjectsConfig } from "../projects/config.ts";
import type { RuntimeProvider } from "../runtime/contract.ts";
import { listSeedStatuses, type SeedsCliDeps, showSeed } from "../seeds-cli/index.ts";
import type { WarrenConfigCache } from "../warren-config/index.ts";
import { buildDispatchPrompt } from "./dispatch-prompt.ts";
import { SeedDrainRefusedError } from "./errors.ts";
import { closeSeedAfterDrain, type SeedDrainCloseResult } from "./seed-drain-close.ts";
import {
	awaitSeedDrain,
	type SeedDrainOutcome,
	type SeedDrainRunSnapshot,
	type SeedDrainWaitDeps,
} from "./seed-drain-wait.ts";
import { spawnRun } from "./spawn/index.ts";

export {
	closeSeedAfterDrain,
	type SeedDrainCloseInput,
	type SeedDrainCloseResult,
} from "./seed-drain-close.ts";
export {
	awaitSeedDrain,
	DEFAULT_SEED_DRAIN_POLL_MS,
	DEFAULT_SEED_DRAIN_WAIT_MS,
	type SeedDrainMergeState,
	type SeedDrainOutcome,
	type SeedDrainOutcomeKind,
	type SeedDrainRunSnapshot,
	type SeedDrainWaitDeps,
} from "./seed-drain-wait.ts";

/** Trigger label for every run this lane dispatches. */
export const SEED_DRAIN_TRIGGER = "seed-drain";

/**
 * The prompt a drained seed receives when the operator supplies no template.
 * It names the seed and inlines its text, so the executor needs no other
 * input to start.
 */
export const DEFAULT_SEED_DRAIN_PROMPT =
	"Implement seed {seed_id}. Deliver one focused change and open a pull request.\n\n{seed_body}";

/* ----------------------------------------------------------------------- */
/* Resolution                                                              */
/* ----------------------------------------------------------------------- */

/** What a seed needs before it can be dispatched: its home project and text. */
export interface SeedDrainSeedRef {
	/** Registered project whose clone carries the seed. */
	readonly projectId: string;
	readonly seedId: string;
	readonly title?: string;
	readonly body?: string;
}

export interface ResolveSeedDrainRefInput {
	readonly repos: Repos;
	readonly seedsCli: SeedsCliDeps;
	readonly seedId: string;
	/**
	 * Optional home project. When omitted, every registered project that
	 * carries `.seeds/` is probed for the id — the lane resolves the project
	 * from the seed instead of demanding it from the caller.
	 */
	readonly projectId?: string;
}

/**
 * Resolve a seed id to its home project. `projectId` short-circuits the probe;
 * without it the projects that carry `.seeds/` are searched in registration
 * order.
 *
 * @throws SeedDrainRefusedError `seed_not_found` when no project owns the id.
 */
export async function resolveSeedDrainRef(
	input: ResolveSeedDrainRefInput,
): Promise<SeedDrainSeedRef> {
	const candidates =
		input.projectId !== undefined
			? [await input.repos.projects.require(input.projectId)]
			: (await input.repos.projects.listAll()).filter((project) => project.hasSeeds);

	for (const project of candidates) {
		try {
			const seed = await showSeed(input.seedsCli, project.localPath, input.seedId);
			return {
				projectId: project.id,
				seedId: seed.id,
				...(seed.title !== undefined ? { title: seed.title } : {}),
				...(seed.description !== undefined ? { body: seed.description } : {}),
			};
		} catch (err) {
			// A missing id in this project is expected while probing. Any other
			// `sd` failure (timeout, lock, malformed envelope) is real and must
			// not read as "some other project owns it".
			if (!isSeedNotFound(err)) throw err;
		}
	}

	throw new SeedDrainRefusedError(
		"seed_not_found",
		`seed ${input.seedId} was not found in any project that carries .seeds/`,
	);
}

function isSeedNotFound(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return err.name === "SeedNotFoundError" || (err as { code?: unknown }).code === "seed_not_found";
}

/* ----------------------------------------------------------------------- */
/* Dispatch                                                                */
/* ----------------------------------------------------------------------- */

export interface SeedDrainDispatchInput {
	readonly repos: Repos;
	readonly runtimeProvider: RuntimeProvider;
	readonly seedsCli: SeedsCliDeps;
	readonly agentName: string;
	/** A ref resolved by {@link resolveSeedDrainRef}. */
	readonly seed: SeedDrainSeedRef;
	/** Prompt template; `{seed_id}` and `{seed_body}` are substituted. */
	readonly promptTemplate?: string;
	readonly projectsConfig?: ProjectsConfig;
	readonly projectSpawn?: SpawnFn;
	readonly githubToken?: string;
	readonly warrenConfigs?: WarrenConfigCache;
	readonly runBranchPrefixDefault?: string;
	readonly providerOverride?: string;
	readonly modelOverride?: string;
	readonly metadata?: unknown;
	readonly now?: () => Date;
	/** Test seam — defaults to the live `spawnRun`. */
	readonly spawnRunFn?: typeof spawnRun;
}

export interface SeedDrainDispatchResult {
	readonly seedId: string;
	readonly projectId: string;
	readonly runId: string;
	readonly agentName: string;
	readonly prompt: string;
}

/**
 * Dispatch one run against a seed.
 *
 * The seed is re-read here, so the gate sees its state at dispatch time rather
 * than at resolution time. A `closed` seed and a seed with at least one open
 * blocker are both refused.
 *
 * @throws SeedDrainRefusedError `seed_closed`, `seed_blocked`, or
 *   `project_lacks_seeds`.
 */
export async function dispatchSeedDrain(
	input: SeedDrainDispatchInput,
): Promise<SeedDrainDispatchResult> {
	const project = await input.repos.projects.require(input.seed.projectId);
	if (!project.hasSeeds) {
		throw new SeedDrainRefusedError(
			"project_lacks_seeds",
			`project ${project.id} has no .seeds/ directory; the seed-drain lane needs one`,
		);
	}

	const seed = await showSeed(input.seedsCli, project.localPath, input.seed.seedId);
	if (seed.status === "closed") {
		throw new SeedDrainRefusedError("seed_closed", `seed ${seed.id} is already closed`);
	}
	const blockers = await openBlockers(input.seedsCli, project.localPath, seed.blockedBy);
	if (blockers.length > 0) {
		throw new SeedDrainRefusedError(
			"seed_blocked",
			`seed ${seed.id} is blocked by ${blockers.join(", ")}`,
		);
	}

	const prompt = buildDispatchPrompt({
		template: input.promptTemplate ?? DEFAULT_SEED_DRAIN_PROMPT,
		seed: { id: seed.id, title: seed.title, body: seed.description },
	});
	const spawn = input.spawnRunFn ?? spawnRun;
	const result = await spawn({
		repos: input.repos,
		runtimeProvider: input.runtimeProvider,
		agentName: input.agentName,
		projectId: project.id,
		prompt,
		trigger: SEED_DRAIN_TRIGGER,
		seedId: seed.id,
		seedsCli: input.seedsCli,
		...(input.providerOverride !== undefined ? { providerOverride: input.providerOverride } : {}),
		...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
		...(input.projectsConfig !== undefined ? { projectsConfig: input.projectsConfig } : {}),
		...(input.projectSpawn !== undefined ? { projectSpawn: input.projectSpawn } : {}),
		...(input.githubToken !== undefined ? { githubToken: input.githubToken } : {}),
		...(input.warrenConfigs !== undefined ? { warrenConfigs: input.warrenConfigs } : {}),
		...(input.runBranchPrefixDefault !== undefined
			? { runBranchPrefixDefault: input.runBranchPrefixDefault }
			: {}),
		...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	return {
		seedId: seed.id,
		projectId: project.id,
		runId: result.run.id,
		agentName: input.agentName,
		prompt,
	};
}

/** Blocker ids that are still open, read from the project's seed statuses. */
async function openBlockers(
	seedsCli: SeedsCliDeps,
	projectPath: string,
	blockedBy: readonly string[] | undefined,
): Promise<readonly string[]> {
	if (blockedBy === undefined || blockedBy.length === 0) return [];
	const statuses = await listSeedStatuses(seedsCli, projectPath);
	return blockedBy.filter((id) => statuses.get(id) !== "closed");
}

/* ----------------------------------------------------------------------- */
/* Composition                                                             */
/* ----------------------------------------------------------------------- */

export interface DrainSeedInput extends Omit<SeedDrainDispatchInput, "seed"> {
	readonly seedId: string;
	/** Optional home project; the seed resolves it when this is absent. */
	readonly projectId?: string;
	/** Wait seams; `runState` is filled from the repos. */
	readonly wait?: Omit<SeedDrainWaitDeps, "runState">;
	/** Closure seams: the git spawn plus an optional close override. */
	readonly closure: {
		readonly spawn: SpawnFn;
		readonly gitBinary: string;
		readonly closeFn?: typeof closeMergedChildSeed;
	};
}

export interface DrainSeedResult {
	readonly seed: SeedDrainSeedRef;
	readonly runId: string;
	readonly prompt: string;
	readonly outcome: SeedDrainOutcome;
	readonly closure: SeedDrainCloseResult;
}

/**
 * Resolve, dispatch, wait, and close — the whole lane in one call. A refusal
 * at the dispatch gate propagates as {@link SeedDrainRefusedError} before any
 * run exists.
 */
export async function drainSeed(input: DrainSeedInput): Promise<DrainSeedResult> {
	const seed = await resolveSeedDrainRef({
		repos: input.repos,
		seedsCli: input.seedsCli,
		seedId: input.seedId,
		...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
	});
	const dispatched = await dispatchSeedDrain({ ...input, seed });
	const outcome = await awaitSeedDrain(
		{ runId: dispatched.runId },
		{
			...input.wait,
			runState: (runId) => readRunSnapshot(input.repos, runId),
		},
	);
	const project = await input.repos.projects.require(seed.projectId);
	const closure = await closeSeedAfterDrain({
		seedId: seed.seedId,
		outcome,
		projectPath: project.localPath,
		defaultBranch: project.defaultBranch,
		seedsCli: input.seedsCli,
		spawn: input.closure.spawn,
		gitBinary: input.closure.gitBinary,
		...(input.githubToken !== undefined ? { githubToken: input.githubToken } : {}),
		...(input.closure.closeFn !== undefined ? { closeFn: input.closure.closeFn } : {}),
	});
	return { seed, runId: dispatched.runId, prompt: dispatched.prompt, outcome, closure };
}

/** Read the wait's snapshot off a run row, or `null` when the row is gone. */
export async function readRunSnapshot(
	repos: Pick<Repos, "runs">,
	runId: string,
): Promise<SeedDrainRunSnapshot | null> {
	const row = await repos.runs.get(runId);
	if (row === null) return null;
	return { state: row.state, failureReason: row.failureReason, prUrl: row.prUrl };
}
