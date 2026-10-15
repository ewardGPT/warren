# twin:capture — intent/proof artifact tooling (OPR.0.4.1.11.2)

Turns the 11.1 digital twin (and the real shipped UI) into the durable **intent** and **proof**
artifacts the visual-intent→proof convention needs. The 11.1 twin already produces a single
self-contained `intent.html` per surface; this tooling makes capturing + attaching it routine and
generalizes beyond screenshots to the highest-bandwidth artifact for each slice's medium.

## One-command capture

```
npm run twin:capture -- \
  --slice opr-0.4.1.11.2 \
  --surface "Topology Graph" \
  --route /topology/rig/rig_delivery \
  --out-root <abs path>/openrig-work/digital-twin
```

| Flag | Required | Meaning |
|---|---|---|
| `--slice` | yes | Slice id; the per-slice folder name (dots preserved, e.g. `opr-0.4.1.11.2`). |
| `--surface` | yes | The surface/mockup label; becomes the artifact file base (slugified). |
| `--route` | no (default `/`) | `TWIN_ROUTE` passthrough — the twin surface to land on. |
| `--out-root` | yes | The `digital-twin/` root the per-slice folder lands under. |
| `--proof-url` | no | Post-build: capture the REAL shipped UI at this URL as the paired proof (FR-6). |
| `--chrome` | no | Headless-Chrome binary override (else `CHROME_BIN` / the macOS default). |

What one run does: `twin:build` (TWIN_ROUTE) → headless-Chrome screenshot → place artifacts under
`digital-twin/<slice-id>/` → capture the `change.diff` → enforce **D-1 determinism** (shoot twice,
byte-compare, fail loudly on drift). One surface per run (so the `emptyOutDir` build wipe never
races the artifacts — they are copied out within the run).

## Artifact convention (FR-5 — ratified by pm + brief1-curator)

Location: **`digital-twin/<slice-id>/`** — one folder per slice; the dotted slice-id is preserved
(`opr-0.4.1.11.2`, never `opr-0-4-1-11-2`). Per surface:

| File | Durable? | What it is |
|---|---|---|
| `<surface>.intent.png` | yes | Intent screenshot (from the twin, pre-build). |
| `<surface>.proof.png` | yes | Proof screenshot (from the real shipped UI, post-build; FR-6). |
| `<surface>.change.diff` | yes | The fixture/variant override diff — the durable essence of the change. |
| `<surface>.intent.html` | no | Regenerable single-file prototype (need not be committed; `twin-out/` is gitignored). |

**Forward-only.** This convention governs new captures. Existing ad-hoc sets
(`slice-15-batch-N`, `full-harness`, `gate-0`) are FROZEN — not renamed or migrated (the slice-15
set is under a live founder design-gate). Any normalization is a separate later cleanup.

## Media (pick the highest-bandwidth for the slice)

- **Screenshot** (FR-2) — `twin:capture`, headless Google Chrome, zero net-new dependency.
  Deterministic (D-1) because the twin is cache-seeded (no daemon, no timing flake; D-2) and the
  chrome flag set is fixed. Determinism is enforced at runtime, not assumed.
- **CLI / asciicast** (FR-3) — `asciicast.ts`: emits the documented asciicast v2 format directly
  (zero-dep), and `captureCommandCast` wraps a command's output into a valid `.cast`. asciinema is
  NOT required (and is absent on the current host); install it only if you want interactive timed
  recording — the cast format is identical. Never fake a capture; degrade honestly.
- **Data / payload-diff** (FR-4) — `payload-diff.ts`: canonical before/after JSON + the sorted set
  of changed paths, for non-visual / data-shape slices.

## Intent vs proof — same format, side by side (FR-6)

Intent and proof use the **identical** capture mechanism (the same `buildChromeScreenshotArgs`,
only the URL differs: `file://` twin for intent, `http://` real UI for proof) and pair by the same
file base (`<surface>.intent.png` ↔ `<surface>.proof.png`) so the founder can compare them directly.

Proof standard (OPR.0.4.0.37): founder-grade proof is the **real** OpenRig UI in a real context —
not an unlabeled or stubbed env. The proof path therefore needs a running build/daemon and is a
**post-build** step (`--proof-url`), deliberately off by default so the intent path stays daemon-free.

## Out of scope (fences)

- The twin itself (11.1) — this tooling captures it, does not modify it. `--route` (`TWIN_ROUTE`) is
  the proven landing mechanism; tab-landing (`TWIN_TAB`) is not a merged twin capability and is out
  of scope here.
- The IMPL-PRD / brief template slots (11.3) and the convention principle (11.4).
- Animated / scripted-SSE video (deferred; the twin stubs EventSource to seeded events only).
