# Vendored upstream: OpenRig

Warren does not rewrite OpenRig's coordination layer. It vendors it — byte for
byte — and supervises it. This file is the provenance record a rebase needs.

| Field | Value |
| --- | --- |
| Upstream | https://github.com/mvschwarz/openrig |
| Snapshot sha | `fd097bfdfaedf96669fbd8dbf9e4bf056ee89694` |
| Snapshot date | 2026-10-15 |
| Upstream commit subject | `fix(daemon): stop a seat's transcript capture once its session ends (#1281)` |
| Version at snapshot | 0.6.10 (`3001cc43`, built 2026-10-11) |
| License | Apache-2.0 — see `LICENSE` in this directory and `NOTICE` at the repo root |
| Absorbed paths | the entire upstream tree, unchanged |
| Local modifications | none at import; see the log below |

## Why the whole tree

`vendor/openrig` is upstream's tracked tree exactly, so a later rebase is a
mechanical `git diff` against upstream and not an archaeology exercise. Custom
Warren code lives outside this directory (`src/kernel/`, `src/decide/`) and
reaches the kernel only through its CLI, its HTTP API, and the transport seam.

## Update procedure

```sh
scripts/openrig-vendor-sync.sh            # fetch, replace, diff, verify
scripts/openrig-vendor-sync.sh --to <sha> # pin to a specific upstream commit
```

The script replaces this directory from upstream, prints the upstream log
between the recorded sha and the new one, lists the local modifications it is
about to discard (if any), reruns upstream's own repository checks with its own
toolchain, and rewrites the table above. It refuses to run on a dirty tree.

## Local modifications

Every edit to a file under this directory must be listed here, with the reason.
Apache-2.0 §4(b) requires the change notice; this table is where it is
aggregated, per file, so a reviewer can see the delta from upstream in one
place.

| File | Change | Reason | Date |
| --- | --- | --- | --- |
| _(none)_ | | | |

## Build

The tree ships source only, exactly as upstream ships it: their build output is
gitignored, and ours is too. A fresh clone has no kernel until this runs once:

```sh
scripts/openrig-vendor-build.sh          # npm ci, npm run build, stamp, verify
scripts/openrig-vendor-build.sh --check  # verify a build already exists
```

The stamp step matters. The vendored tree lives inside Warren's repository, so
the daemon's build identity picks up Warren's HEAD and a dirty flag of our own
making. `scripts/openrig-vendor-stamp.sh` replaces that with the sha recorded
above, so `/healthz` reports the kernel's own commit.

## What we do not run from here

`packages/ui/` (upstream's web UI, in maintenance mode upstream and dropped
here), `packages/tui/` (terminal dashboard; only its control socket contract is
reused), and the multi-host registry. They stay in the tree because removing
them would make the rebase non-mechanical; they are simply not built or shipped.

## Upstream suite

Upstream's own checks are the regression net for a rebase:

```sh
cd vendor/openrig && npm ci && npm run test:repo
```

That needs its own toolchain (Node 22/24, npm) and is intentionally not part of
`bun test` — see `bunfig.toml` and `scripts/openrig-vendor-sync.sh`.

Result at import, in this repository: `npm ci` then `npm run build` then
`npm run test:repo` — 294 tests, 293 pass, 1 skipped, 0 fail, 526 s, with the
docs guard and the context-pack generator (57 packs) also clean. Use that as the
baseline for a rebase: a red upstream suite after an update means the update, not
our code, broke something.
