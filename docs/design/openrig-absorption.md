# OpenRig absorption — the coordination kernel

Status: accepted, in progress (seed ubuntu-cf02, branch warren/openrig-absorption).
Date: 2026-10-15.
Upstream snapshot: `fd097bfdfa` (see vendor/openrig/UPSTREAM.md).

## Problem

Warren dispatches runs. It does not own durable work.

A run starts, works, and stops. Warren cannot say which unit of work is in flight, who holds it, or what it waits on. It cannot say what happens to the baton when a seat stops. Plans carry order, and the coordinator walks them one child at a time. The missing part is the execution ledger between the plan and the run.

OpenRig already owns that part. Its daemon holds a work queue with a closure contract. It also holds a mechanical workflow projector, per-seat orientation, a context library, and health detectors. A scenario harness can prove all of it.

## Decision

Vendor the OpenRig daemon unchanged and supervise it from Warren.

Warren stays the control plane and the product. The kernel becomes the coordination layer. Three rules keep this one system and not two:

1. One writer per fact.
2. No bidirectional synchronization. The bridge reconciles, and a disagreement
stops loudly.
3. Custom code lives outside `vendor/openrig`, so an upstream rebase stays
mechanical.

## Measured facts behind the choice

| Fact | Value |
| --- | --- |
| Kernel source | 697 files, 167,374 lines |
| Kernel tests | 1,049 files, 277,659 lines |
| Files that import the SQLite driver as a value | 9 (133 more import types only) |
| Modules that import the tmux adapter | 58 |
| Transport interface in place today | none (`cmux` is a presentation client) |
| Warren modules that already fit | `RuntimeProvider`, `run_inbox`, the supervisor, tick loops |
| Upstream licence | Apache-2.0, one copyright holder, no CLA, no per-file headers |

Two measurements decided the process model. First, `better-sqlite3` 13 crashes Bun 1.3.14 with a NAPI fatal error on a trivial script. The kernel therefore runs on Node, as a supervised child, and not inside the Bun process. Second, only 9 files import that driver as a value, so a later single-runtime move stays cheap if we ever want it.

## Target shape

```
Warren (Bun)                          OpenRig kernel (Node child)
  warren serve                          Hono app on loopback
  warren.db (drizzle)                   openrig.sqlite (~62 tables)
  projects, runs, plan runs             rigs, pods, seats, queue,
  PR and merge, previews, triggers      workflow, proof, context packs,
  supervision, one API, one UI          snapshots, attention
        \                                        /
         +-- kernel client, one bearer token ----+
         |
  Seeds (.seeds)  intent of record
  Mulch (.mulch)  expertise, referenced by context refs
```

## Truth partition

| Fact | Sole writer |
| --- | --- |
| Rig, pod, seat, occupancy, queue, stream, workflow, proof, snapshot, attention | kernel |
| Project, run, plan run, pull request, merge, preview, trigger, usage | Warren |
| Which work exists, and why | Seeds |
| What a role has learned | Mulch |
| Event history | the kernel log. Warren holds a cache mirror, keyed by sequence number |

The queue is the execution ledger. Seeds remains the intent ledger. A closure carries a reason and, when work continues, a target. That contract makes a dropped baton visible instead of hidden in a free-text note.

## Decisions taken

| Area | Decision |
| --- | --- |
| Process model | Node child under `src/supervisor/`, isolated `OPENRIG_HOME` and `HOME` |
| Seat substrate | keep tmux, extract a `SeatTransport` seam in a later phase |
| Databases | two stores, no Postgres port of the kernel schema |
| Task truth | Seeds for intent, kernel queue for execution, one-way bridge |
| Context | pack refs point at Mulch and Seeds, no content duplication |
| Events | kernel log is authority, Warren mirrors it, sequence-ordered |
| UI | drop the upstream web UI and terminal painting, keep the socket contract |
| Skills | namespaced projection, so the fleet skill roots keep one writer |
| Brand | no upstream name, domain, or logo. Our own registry name. |
| Upstream | vendored tree, recorded sha, sync script, weekly rebase |

## Phases

| Phase | Work | Exit gate |
| --- | --- | --- |
| 0 | vendor, provenance, build, upstream suite in CI | kernel boots from the vendored tree, upstream scenario pair passes |
| 1 | supervision, one token, proxy, unified doctor | kernel survives a Warren restart |
| 2 | Seeds and queue bridge, closure taxonomy | a seeded baton drop fails the pair test |
| 3 | orientation from our intent chain | a real seat receives the chain after compaction |
| 4 | health, attention, ceremony | a stalled seat yields PARKED and one alert |
| 5 | surfaces: CLI, MCP, UI read contracts | no duplicate verb, one entry point |
| 6 | bundles, registry, skill namespacing | one writer per skill root |
| 7 | `SeatTransport` and a second host | one scenario suite passes on two hosts |

## Invariants

These come from the upstream rulebook and they survive absorption.

1. A failed resume stops as `awaiting-decision`. It never falls back to a fresh
session on its own.
2. A snapshot records its occupants. Restore reads that record and never picks the
newest session.
3. The event log is the truth, with one delivery per sequence number.
4. Restore policy narrows only: `resume_if_possible` to `relaunch_fresh` to
`checkpoint_only`.
5. Workspace writes add. They never delete operator content.
6. A change to a high-blast-radius area ships with a scenario whose seeded fault
fails.

## Consequences

The gain is a coordination layer that already works, with its tests.

The cost is a fork. Four debts come with it:

- Upstream ships often. The sync script and the vendored boundary keep a rebase
mechanical, and the upstream suite is the regression net.
- Two runtimes live in one product. The kernel stays on Node until the driver shim
lands behind a passing suite.
- Two databases. Cross-database foreign keys are forbidden, and the reconciler
carries idempotency keys.
- tmux becomes a host requirement for persistent seats only. Batch runs keep the
burrow and k8s paths.

## Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Reimplement the kernel in Warren | discards 278k lines of tests and takes months |
| Port mechanisms only | leaves the queue, workflow, and orientation half-built |
| Make the kernel primary and re-express Warren as seats | loses the headless and k8s paths |
| Merge both schemas into drizzle and Postgres | a large translation for no capability |

## Decision engine (Jev)

The kernel decides mechanically. Some questions are still judgement calls, and
those go to TypeSafe Jev, a decision model that answers typed questions about a
state snapshot in about one second for a tiny cost.

`src/decide/` is the client: providers (`typesafe`, `openrouter`, `vercel`), a
three-way band (`act` / `ask` / `hold`), a timeout, an optional daily cap, an
offline stub provider, and an append-only JSONL log. `warren decide` exposes it
to a shell gate and maps the band onto an exit code, so a script can branch
without parsing prose.

| Band | Exit | Meaning |
| --- | --- | --- |
| `act` | 0 | every answer landed in `act` |
| `ask` | 3 | not sure, so a human or a wider context decides |
| `hold` | 4 | an answer landed in `hold`, so the caller stops |
| unavailable | 5 | no answer arrived, so nothing was decided |

Two rules keep this safe. Silence never becomes action: an unreachable provider,
a missing key, or an unparsed body is `unavailable`, and an answer the engine cannot read
becomes `ask`. The engine records every decision with its state hash, its
questions and its band, at mode 0600, under `$HOME/.warren/decisions.jsonl`.

The key lives outside the repository: `~/.warren/jev.key` (0600), exported as
`JEV_API_KEY` or `TYPESAFE_API_KEY`. Without it the engine degrades to
`unavailable` and changes nothing.

## Evidence

- Kernel build from the vendored tree: `npm ci && npm run build` in
  `vendor/openrig`, both green.
- Upstream repository checks: `npm run test:repo` green — 294 tests, 293 pass, 1
  skipped, 0 fail, 526 s. The run also cleared the docs guard and the
  context-pack generator (57 packs).
- Our suite ignores the vendored tree through `bunfig.toml`. Before that change a
  bare `bun test` picked up 363 vendored files and reported 226 failures.
- Closure contract: `bun test src/seeds-cli/closure scripts/check-closure-contract
  src/cli/commands/closure` green, and the guard fails on a seeded regression in
  `.seeds/issues.jsonl` with `closure_reason_required` and
  `closure_target_required`.
- Refocus hook: `bun test src/omp-hooks` green (17 tests), and the module is
  installed at `~/.omp/agent/hooks/pre/refocus.ts`.
- Kernel supervision end to end: `warren kernel start` brought up the vendored
  build on a scratch home, `warren kernel doctor` reported `healthz ok, stuck
  sweep clean`, `warren kernel stop` ended the child on SIGTERM, and the port
  closed.
- Decision engine live: `warren decide --feature merge-gate` returned `ask` from
  `typesafe/jev-1.13.0` in 134 ms and wrote a 0600 record to the decision log.
- Gates: `bun run lint`, `check:size`, `check:dups` and `check:deps` pass. The
  test runner, knip and the duplicate scan all skip the vendored tree, because
  its own suites and its own internals are not ours to judge.
