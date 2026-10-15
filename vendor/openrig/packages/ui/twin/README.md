# OpenRig UI digital-twin harness (OPR.0.4.1.11.1)

Builds the **real** `@openrig/ui` App with dummy data into ONE self-contained,
double-clickable `intent.html` — so an agent can fork a feature-version, change the one
thing a slice proposes, and emit a clickable mockup that is **1:1 with the live UI by
construction** (it IS the real components; it never needs manual re-syncing).

## Per-slice authoring loop (~2 steps + capture)

1. **Change the one thing** the slice proposes — edit a value in `twin/fixtures.ts` (a
   data/state proposal) or the component/variant under proposal in `src/`. The diff of that
   edit is the durable essence of the change.
2. **`npm run twin:build`** (in `packages/ui`) → emits `twin-out/intent.html` (single file).
   Target a surface with `TWIN_ROUTE`, e.g.
   `TWIN_ROUTE=/topology/rig/rig_delivery npm run twin:build`.
3. **(capture)** screenshot it → `intent.png`:
   `"<chrome>" --headless=new --window-size=1440,900 --virtual-time-budget=9000 --screenshot=intent.png "file://$PWD/twin-out/intent.html"`

Per-slice durable record = the `change.diff` + `intent.png` (the heavy `intent.html` is
regenerable on demand; `twin-out/` is gitignored).

## Seams (daemon-free, NOT MSW)

The twin renders the real App with three thin seams installed before any `@openrig/ui`
module imports (`twin-main.tsx`):

- **cache-seed** (`seed.ts`) — seeds the react-query cache from typed fixtures under the
  exact queryKeys, with `staleTime:Infinity`/`retry:false`. Instant first paint.
- **fetch stub** (`fetch-stub.ts`) — a `globalThis.fetch` override answering `/api/*` from
  the SAME typed fixtures. Required because several hooks hardcode `staleTime:0 +
  refetchInterval` (`useNodePreview`/`useSessionPreview`, `useSettings`, `useSpecLibrary`,
  `useContextFleet`, `useFiles`) and background-refetch even when seeded. NOT MSW / no
  service worker. Benign 404 "unavailable" default so nothing rejects.
- **EventSource stub** (`eventsource-stub.ts`) — no-op for live SSE, EXCEPT it emits a fixed
  set of seeded activity events on `/api/events` so the SSE-driven For-You feed +
  topology activity render cards 1:1.

## Drift guard (FR-4 / D-2)

`twin:build` runs `tsc -p tsconfig.twin.json` first. Fixtures are typed against the REAL
exported hook interfaces (`RigSummary`, `NodeDetailData`, `SliceListResponse`, …), so a
real-interface change BREAKS the twin build = compile-time drift detection. (Proven: a
`string` where a `number` is required fails with `TS2322`.)

## Surfaces seeded (1:1 verified)

| Surface | Route | Driven by |
|---|---|---|
| Dashboard | `/` | rigs/summary, ps, spec-library |
| Topology graph | `/topology/rig/<rigId>` | rig/<id>/graph (xyflow nodes/edges) |
| Live node details | `/rigs/<rigId>/nodes/<logicalId>` | NodeDetailData + session-preview (terminal) |
| For-You feed | `/for-you` | seeded SSE activity events + slices (storytelling) |
| Workspace | `/project` | /api/slices + workspace.root setting |
| Library | `/specs` | spec-library |

## Adding a new surface

1. Add a typed fixture in `twin/fixtures.ts` (against the real hook interface).
2. Seed its queryKey in `seed.ts` and/or add an `/api/*` route in `fetch-stub.ts` (for
   force-refetch hooks). For SSE-driven surfaces, add events to `feedEvents`.
3. `TWIN_ROUTE=<route> npm run twin:build` and screenshot.

## Known follow-up

Graph rigNode badges read STALE/UNKNOWN — the per-node LIVE activity comes from the SSE
topology-activity baseline + clock-freshness, not the static graph fixture. Seeding live
node-activity events is a separate small task; the graph STRUCTURE renders 1:1.

## Gotcha — font stacks in component-scoped CSS (test-invisible footgun)

`@fontsource-variable/*` packages register the family name **`<Family> Variable`**
(`Space Grotesk Variable`, `JetBrains Mono Variable`), NOT the plain name — that
is what `main.tsx` imports and what `tailwind.config.ts` `fontFamily` points at.
A component-scoped CSS file (e.g. a per-surface `*.css`) whose `font-family`
leads with the plain `"JetBrains Mono"` / `"Space Grotesk"` falls through to the
system font **silently**: no build error, jsdom can't catch it in a unit test,
and it surfaces only as visual drift vs the twin/mockup (wrong headline +
mono weight). Lead component-scoped stacks with the registered Variable family
first, mirroring the tailwind tokens, e.g.
`"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace` and
`"Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif`. When you
capture against a mockup, eyeball the headline/mono fonts before declaring a
fidelity PASS. (Surfaced OPR.0.4.1.14.)
