/**
 * The `finalize` seam's intent/result vocabulary (§4), split out of
 * `contract.ts` (warren-4553) so that file stays within its frozen size budget.
 * Re-exported from `./contract.ts` — that remains the canonical import site, so
 * every importer keeps using `../contract.ts` unchanged.
 *
 * Grouped here because they move together: `FinalizeIntent` is the input,
 * `FinalizeResult` (+ `FinalizeEvent`, `FinalizeStageOutcome`) the output, all
 * keyed off the opaque artifact vocabulary in `./finalize-deltas.ts` and the
 * stage vocabulary in `./finalize-stages.ts`.
 */

import type { ArtifactDelta } from "./finalize-deltas.ts";
import type { FinalizeStage } from "./finalize-stages.ts";

/**
 * The reap-where-the-workspace-is seam (§4). `finalize` runs the
 * workspace-DEPENDENT half of reap in place — burrow: host-side over the
 * worktree; K8s: a post-agent step inside the pod — and returns structured
 * artifacts the domain applies on its own side. The domain keeps orchestration
 * (*when* to reap, whether to open a PR, plan-run chaining); only the
 * workspace-touching execution crosses the seam. Ordering is an explicit
 * obligation: the domain calls `finalize`, then `terminate` (§6.8).
 */
export interface FinalizeIntent {
	branch: string;
	/** push HEAD:branch from inside the workspace */
	push: boolean;
	/**
	 * Which artifact sets to extract (the MERGE half — always run in reap),
	 * named by OPAQUE provider keys (warren-df3e). The finalize contract no
	 * longer enumerates features: the domain passes the keys it wants merged
	 * (e.g. `["mulch", "seeds", "plans"]`) and the provider maps each to its own
	 * merge; the returned {@link FinalizeResult.artifacts} is keyed the same way.
	 */
	artifacts: string[];
	/**
	 * Which bookkeeping COMMITS to author before the push (warren-1f56). The
	 * reap pipeline runs the tracker merges unconditionally but gates the
	 * `chore(warren): seeds state` commit on `project.hasSeeds` — so
	 * merge-gating (`artifacts`) and commit-gating cannot be one set. `commit`
	 * decouples them: the provider authors the bookkeeping commit for each key
	 * listed here, keyed off the SAME opaque artifact vocabulary as `artifacts`
	 * (warren-357c — no feature enumeration at the seam). OMITTED ⇒ defaults to
	 * `artifacts` (commit whatever we merge).
	 */
	commit?: string[];
	/**
	 * Base ref for the commits-ahead / empty-push count
	 * (`git rev-list --count <baseBranch>..HEAD`). A provider-NEUTRAL git ref
	 * (RunSpec.baseBranch was promoted first-class, §6.2), NOT a host path.
	 * Omitted ⇒ the count is skipped and `commitsAhead` is `null` — the same
	 * way reap degrades when burrow exposed no base branch (warren-f3bb).
	 */
	baseBranch?: string;
	/**
	 * SEAM SIGNAL (mirrors `RunSpec.hostClonePathHint`): the host path of the
	 * project clone the LocalProvider merges each tracker INTO — a host path
	 * with no provider-neutral home. REQUIRED by the burrow backend whenever
	 * `artifacts` is non-empty (it does the merge host-side against the shared
	 * disk, exactly as reap does today); the K8s backend IGNORES it (the in-pod
	 * finalize has no clone — it emits the deltas above and the control plane
	 * applies them, plan step 20).
	 */
	projectClonePathHint?: string;
	/**
	 * warren-8d95: warren-seeded workspace artifacts (the rendered agent
	 * envelope + `.pi/` drops + `.seeds/workflow.txt`) that must be RESET to
	 * `baseBranch` before `branch_push` so they never ride into a PR. In
	 * projects that themselves track a colliding path, warren's seed dirties the
	 * tracked file and a broad agent commit (`git add -A`) sweeps it in, tripping
	 * Article IX protected-path automerge guard. Each entry carries the path and
	 * the exact bytes warren seeded; finalize only resets a path whose live
	 * workspace content still EQUALS the seeded bytes (so an intentional agent
	 * edit is preserved). Omitted / empty ⇒ the reset stage is skipped (existing
	 * callers unchanged). LocalProvider honors it; the K8s wire does not yet
	 * project it.
	 */
	resetSeededPaths?: ReadonlyArray<{ path: string; contents: string }>;
}

/**
 * One user-visible event a merge stage emitted, captured by finalize's
 * collecting emit/fail and returned for the domain to re-emit through its REAL
 * event surface (warren-1f56). The reap merge functions emit ~10 per-record
 * kinds (`mulch.record.*`, `seeds.closed/created`, `seeds.plan_mirrored`,
 * `reap.seeds_committed`) plus per-line/stage `reap_failed`; finalize returns
 * counts, so those events are unreconstructable unless carried here. This array
 * rides the callback wire from the in-pod finalize later (plan step 20), so
 * `payload` MUST be JSON-serializable — same posture as `NormalizedEvent`.
 */
export interface FinalizeEvent {
	kind: string;
	payload: unknown;
}

export interface FinalizeResult {
	pushed: boolean;
	/** warren-5ea1: set ONLY on a warren-SYNTHESIZED failed result — the in-pod finalize never POSTed one. */
	unposted?: "timeout" | "pod_terminal" | "pod_gone";
	/**
	 * Commits the pushed branch is ahead of `intent.baseBranch`. WIDENED from
	 * the design-doc's `number` to `number | null` to match reap's real shape
	 * (warren-f3bb): the count is genuinely uncomputable when the push was
	 * skipped/failed, no `baseBranch` was supplied, or `git rev-list` failed,
	 * and collapsing that to `0` would masquerade a failed count as an empty
	 * push. `0` means the push landed no new commits; positive means real work.
	 */
	commitsAhead: number | null;
	/** dropped-commit detection: pushed but zero commits ahead of the base */
	emptyPush: boolean;
	/**
	 * Workspace-dirtiness at push time (warren-1f56): `git status --porcelain`
	 * was non-empty. Probed ONLY when `pushed && commitsAhead === 0` (matching
	 * reap's `commitsAheadStep`), `false` otherwise. The domain owns the
	 * `droppedCommit` derivation (`dirty && outcome === "succeeded"`) and the
	 * `reap.empty_push` emission — both need the run outcome, a domain concern
	 * the provider seam does not carry, and the workspace is provider-owned +
	 * destroyed by `terminate`, so the domain cannot re-probe post-finalize.
	 */
	dirty: boolean;
	/**
	 * The workspace-relative paths of every uncommitted change at push time
	 * (warren-89b0), populated ONLY when `dirty` is true (i.e. `pushed &&
	 * commitsAhead === 0` over a dirty tree). The domain uses it to classify a
	 * zero-commit dirty tree: a tree whose ONLY dirty paths are warren-managed
	 * bookkeeping artifacts (`.mulch/`, `.seeds/`) is a deliberate no-op
	 * (`succeeded`) rather than a dropped commit (`failed`). Optional/absent ⇒ the
	 * domain falls back to the conservative dropped-commit posture.
	 */
	dirtyPaths?: readonly string[];
	/**
	 * The workspace `.seeds/plans.jsonl` body snapshotted just before the seeds
	 * bookkeeping commit overwrote it with the clone-union (warren-1f56). This is
	 * exactly what reap's `snapshotWorkspacePlans` reads off the live workspace to
	 * feed auto-plan-run detection; the workspace is provider-owned and destroyed
	 * by `terminate`, so finalize must capture it and hand it back. `null` when
	 * the file was absent or unreadable. The domain parses plan ids from it (gated
	 * on its own auto-dispatch frontmatter checks).
	 */
	workspacePlansBody: string | null;
	/**
	 * The per-record + per-line/stage events the merge functions emitted,
	 * captured verbatim for the domain to re-emit through its real event surface
	 * (warren-1f56 — see `FinalizeEvent`). In pipeline order. Does NOT include
	 * `reap.empty_push` (domain-emitted, needs the run outcome) nor
	 * `reap.workspace_destroyed` (a `terminate` concern).
	 */
	events: FinalizeEvent[];
	/**
	 * Feature-neutral artifact deltas the domain applies to the project clone,
	 * keyed by the SAME opaque provider keys the intent's `artifacts` named
	 * (warren-df3e). An absent key means that merge did not run; the domain reads
	 * a delta back by key and never assumes a fixed feature set.
	 */
	artifacts: Record<string, ArtifactDelta>;
	/**
	 * The pushed branch when it carries real work ready for a PR
	 * (`pushed && commitsAhead > 0`), else `null`. finalize does NOT open the
	 * PR — that stays domain orchestration (§4); this only signals readiness.
	 */
	prBranch: string | null;
	/**
	 * Per-stage outcome trail — a REFINEMENT over the design-doc shape (which
	 * omitted it). Grounds in reap's best-effort `ReapStepError[]`: every
	 * workspace-touching stage is best-effort, so the domain must see which merged,
	 * which were skipped, and which failed (with the message).
	 */
	stages: FinalizeStageOutcome[];
}

export interface FinalizeStageOutcome {
	stage: FinalizeStage;
	status: "ok" | "skipped" | "failed";
	/** present only when `status === "failed"` — the error message */
	error?: string;
}
