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

## Agentic boxes

A host that runs its own kernel can hold its own seats, and any other host on the
tailnet can watch them. `scripts/agentic-box.sh` turns a Debian or Ubuntu box into
one: it creates the non-root `openrig` user with key-only SSH and a read-only sudo
rule, installs Node 22 and `rig`, and runs the kernel as a systemd unit.

Three choices in that script are deliberate.

1. The unit execs the daemon entry directly. `rig daemon start` detaches and
   unrefs its child, which systemd then cannot supervise.
2. The kernel uses the daemon's default bind: loopback plus the tailnet, never
   the public address. The posture profile checks exactly this, and the kernel
   holds the fleet's work queue.
3. The script refuses two changes it cannot make safely on its own: it leaves
   `PermitRootLogin` alone when root has an authorized_keys file, and it leaves
   password authentication alone when that is still on. Each one can
   lock people out of a box that nobody can reach by hand.

The registry holds two entries per box, `--transport http` for work and
`--transport ssh` for posture, because the posture profile needs a shell.

The fleet, as of 2026-10-15:

| Box | Instance | Tailnet | Registry | Posture |
| --- | --- | --- | --- | --- |
| headroom-aws | t3.xlarge | 100.112.188.99 | http + ssh | 8 pass, ufw off (a live proxy holds two public ports) |
| nexus-gate | t3.medium | 100.94.199.106 | http + ssh | 10 pass |
| mt5-wine | t3.large | 100.111.105.36 | http + ssh | 10 pass |

Verified on each box: the kernel answers on its tailnet address, the posture
doctor reports the daemon healthy and bound to loopback and the tailnet, and a
terminal seat launched there is visible and drivable from the workstation.

Two details the bare-shell seats taught us.

A seat with the `terminal` runtime receives the delivery header as typed text,
so a plain `rig send` lands as a few stray commands. Use `rig send --raw`: it
sends the text alone and the command runs cleanly.

A kernel that starts before the tailnet join binds loopback only. A box that
joins later needs one `systemctl restart openrig-kernel`.

Register an ssh entry by address, not by ssh-config alias. `rig host list` probes
`target:22` over TCP, and a TCP probe cannot resolve an alias, so the entry reads
`unreachable` while every real check passes. The key and user still come from the
ssh config.

## The fleet view

The kernel's TUI reads one daemon, and `hosts.yaml` is a client-side registry the
daemon never merges, so upstream has no single screen for a fleet.
`scripts/fleet-tui.ts` is that screen: every reachable http host with its kernel
health, its rigs and its seats, on a five-second refresh.

```sh
OPENRIG_HOME=/home/ubuntu/warren-data/kernel bun scripts/fleet-tui.ts
```

Keys are `j` and `k` to move between hosts, `r` to refresh now, `q` to leave.
`--once` prints a single frame for a script or a screenshot. It only reads: one
`/healthz` and one `ps --json` per host, and it never writes anywhere.

Two layers sit under it. `scripts/fleet-status.sh --watch` is the plain-text
version for a log or a wall display, and the per-host kernel TUI is one ssh away
when a host needs depth:

```sh
ssh -t headroom-aws 'sudo -u openrig -H env OPENRIG_HOME=/home/openrig/.openrig rig tui'
```

## Fleet health inside warren

Warren now reports the peer kernels it coordinates with. `warren doctor` prints
one line per box: the address, the semver, the sweep outcome, the event loop
state and the pid.

`GET /readyz` reports one aggregate line instead. The split exists on purpose.

A peer box is not a dependency of any warren request path. A peer outage must not
make warren look unhealthy.

The readyz line is always `ok`. It names the hosts that are down and points a
reader at `warren doctor` for the detail.

The codebase already made this call for burrow under k8s (warren-c128). There, a
probe that is not a dependency must not degrade readiness.

A decision model scored the alternatives before the code existed. Failing
readiness on a peer outage scored 0. The risk of coupling readiness to peer state
scored 0.83.

The registry is the kernel's own `hosts.yaml`. This check reads it through
`kernelPaths()` and probes only `transport: http` entries.

A missing registry costs `warren doctor` one information line and costs readyz
nothing. An install without a kernel behaves exactly as before.

The probe reads the bearer token from the file the registry names and drops it
after the call. The readyz line names host ids only, so no tailnet address
reaches the wire.

## Replicating omp onto a box

The fleet boxes run the same harness as the workstation. Per box:

1. `unzip`, then the bun installer, then `bun add -g @oh-my-pi/pi-coding-agent
   @os-eco/mulch-cli @os-eco/seeds-cli`.
2. Copy `~/.omp/agent`: `config.yml`, `models.yml`, `hooks/pre/`,
   `extensions/`, `lib/`, `bin/`, `mcp/` and the `jev-*` state directories. The
   hooks import `lib/jev-core.ts`, so the library travels with them.
3. Provide the provider gateway. The `headroom-bifrost` provider reads its key
   from `/home/ubuntu/bifrost/.env` through the shell command in `models.yml`, so
   that file must exist at the same path, mode 600.
4. Point `baseUrl` at a reachable gateway: `http://127.0.0.1:8085/openai/v1` on
   the box that runs bifrost, and `http://localhost:18086/openai/v1` elsewhere,
   with a systemd unit holding an ssh forward from 18086 to that box's 8085.
5. Verify with a real call: `omp -p "Reply with the single word: ok"`.

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

### Where Jev decides in the kernel

Two seams call Jev today. Both stay off until an operator sets a flag. Both log
every call to the decision log. When the flag is unset, the mechanical default
stays in place.

| Seam | Flag | Shape | On a stop |
| --- | --- | --- | --- |
| `plan-continuation` (`src/plan-runs/jev-gate.ts`) | `WARREN_JEV_PLAN_GATE=1` | **Proceed gate:** the plan needs a yes, because a plan that keeps walking drags hours of work behind it | The plan parks `failed` and the reason names the band |
| `heal-triage` (`src/healer/jev-gate.ts`) | `WARREN_JEV_HEAL_GATE=1` | **Veto gate:** the rails (`enabled`, `cooldown`, `max_retries`) already agreed to a run, so only a confident `hold` overrides them | The intake answers `{status:"skipped", reason:"jevs_hold: …"}` and writes no run row |

The shapes differ on purpose.
`act` and `ask` continue in the veto gate, and neither continues in the proceed gate.
A gate that guards a long autonomous process needs a yes.
A gate that guards one bounded and reversible run, which the rails already approved, needs a no.

**Calibration is the open question, not the wiring.** The first live
`plan-continuation` call saw a healthy plan (6 children merged, 2 left, 3 hours
old) and answered `noul 0.73`. That value is `ask`, so with the flag on today
the plan would park at the first tick.

The band edges (`act >= 0.9`, `hold <= 0.1`) are the engine defaults, not this
question's distribution. `actAt` and `denyAt` on the request set them per
feature. Choose them from 30 or more recorded outcomes.

The veto gate needs no such work. The alerts it must stop answer near 0.1, far
below the default edge.

Other seams stay mechanical for now. A wrong answer costs the most at the trust
verdict in reap (did the run do the work, is a PR a fair offer), then at seed
routing in dispatch (which agent, which model tier), then at the scheduled-seed
drain (is this seed worth a run now).

Each seam already has deterministic signals. Each seam should reach Jev only
for the gray zone.

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
- Healer gate live: `judgeHealTriage` ran two real alerts. An actionable one
  (a TypeError in our own source, 412 events) answered `noul 0.70` in 113 ms,
  so the dispatch went ahead. A quota alert answered `noul 0.10` in 64 ms, so
  the intake returned `jevs_hold` and wrote no run row.
- Healer gate tests: 25 green across `src/healer/jev-gate.test.ts` and
  `src/server/handlers/alerts.test.ts` (band mapping, body clipping, the
  offline provider both ways, and the 200/202 arms of the intake). `bun run
  lint` and `tsc --noEmit` green.
- Gates: `bun run lint`, `check:size`, `check:dups` and `check:deps` pass. The
  test runner, knip and the duplicate scan all skip the vendored tree, because
  its own suites and its own internals are not ours to judge.
