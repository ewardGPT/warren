# The seed-drain lane (ubuntu-6ab8)

One path from a seed id to a closed seed. Point the lane at a seed, and it
resolves what the seed needs, dispatches a run, waits for that run's pull
request, and closes the seed when the PR merges.

## The four stages

`src/runs/seed-drain.ts` owns resolution, dispatch, and the composition.
The wait and closure stages live beside it in `seed-drain-wait.ts` and
`seed-drain-close.ts`.

1. **Resolve.** `resolveSeedDrainRef` maps a seed id to the registered
   project whose clone carries `.seeds/` and owns the id. The caller passes
   an id; it does not pass a project. An explicit `--project` short-circuits
   the probe.
2. **Dispatch.** `dispatchSeedDrain` re-reads the seed, refuses a `closed`
   seed or one with an open blocker, then calls `spawnRun` with
   `seedId` set. The run row records `seed_id`, so reap's seed bookkeeping
   and the run API's back-link both work unchanged.
3. **Wait.** `awaitSeedDrain` observes the run to a terminal outcome against
   a bound. Every exit carries a reason.
4. **Close.** `closeSeedAfterDrain` closes the seed on a merge and skips
   every other outcome.

## Which store owns closure

**The seeds store that dispatches is the one that closes.** The lane closes
the seed in the project that owns it, and nowhere else. A seed in project A
dispatched from project B's configuration closes in A.

Closure is delegated to `closeMergedChildSeed`
(`src/plan-runs/close-child-seed.ts`) — the same host-side close warren
already runs when a plan-run child's PR merges (warren-3806). That function
is the single implementation:

- it fetches `origin`, spins a throwaway worktree off `origin/<defaultBranch>`,
  runs `sd close` there, and pushes a `chore(warren)` commit authored through
  the bot identity (`src/bot-identity.ts`, Article VII);
- it re-applies the close against a moved head when a push is refused as
  non-fast-forward;
- it returns `noop` when the seed is already closed on the default branch.

The lane adds no second close path. The reap-time safety net
(`src/runs/reap/seed-close-lifecycle.ts`) closes the seed in the project
**clone** after a clean pushed reap; the plan-run close and this lane close
the seed on the **default branch**. Both are idempotent, so the two coexist
without a race that matters.

## Wait semantics

A poll loop with no exit is not an outcome, so the bound is always armed
(default 30 minutes; `--timeout-ms 0` disables it). The outcome union is
exhausted:

| Kind | Meaning | Seed |
|------|---------|------|
| `merged` | The PR merged. | Closed. |
| `run_failed` | The run failed; `failureReason` is reported. | Stays open. |
| `run_cancelled` | The run was cancelled. | Stays open. |
| `run_succeeded_no_pr` | The run succeeded with no PR. | Stays open. |
| `pr_closed_unmerged` | The PR closed without merging. | Stays open. |
| `run_missing` | The run row is gone. | Stays open. |
| `timed_out` | The budget elapsed with the PR still open. | Stays open. |

`run_succeeded_no_pr` is deliberately not a merge. A run that pushed no
commits delivered no work, so closing the seed would claim work that never
landed.

## Surfaces

`warren seed-drain <seed-id> --agent <name>` runs the lane in-process,
mirroring `warren run` and `warren best-of`. Exit codes: `0` merged and
closed; `1` a run failure or a timeout; `2` a refusal (closed, blocked,
unknown id, or a project without `.seeds/`); `3` the run finished without a
merge.

The lane is a CLI command. No HTTP route, no coordinator row: one seed, one
run, one PR. Routing it through the plan-run coordinator would need a
plan for a single child, which is more state than the work has.
