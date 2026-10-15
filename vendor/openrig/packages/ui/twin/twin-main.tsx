// OPR.0.4.1.11.1 (FR-1) — digital-twin entry. Mounts the REAL @openrig/ui App UNMODIFIED;
// the ONLY divergence from production main.tsx is: (a) the EventSource SSE stub, (b) a
// seeded react-query cache, (c) staleTime:Infinity/retry:false so seeded data never
// fetches. No forked component tree — the twin IS the real components, so it is 1:1 with
// the live UI by construction and never needs manual re-sync.

// MUST be first: install the daemon-free seams before any @openrig/ui module imports —
// the no-op EventSource (SSE) + the fixture-backed fetch (for staleTime:0 refetch hooks).
import "./eventsource-stub.js";
import "./fetch-stub.js";

// Fonts + global styles, identical to production main.tsx.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "../src/globals.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createRouter, createMemoryHistory } from "@tanstack/react-router";
import { queryClient } from "../src/lib/query-client.js";
import { routeTree } from "../src/routes.js";
import { seedTwinCache } from "./seed.js";
import { ThemeProvider } from "../src/components/ThemeProvider.js";
import { THEME_STORAGE_KEY } from "../src/lib/theme.js";

// The surface this intent.html lands on, injected at build time from the TWIN_ROUTE env
// (vite `define`); per-slice authoring sets it to the surface under proposal. Default "/".
declare const __TWIN_ROUTE__: string;
const TWIN_ROUTE = __TWIN_ROUTE__;

// 0.4.3.29 theming in the twin — the REAL ThemeProvider mounts below (same as
// production main.tsx). `TWIN_THEME=dark|light|system npm run twin:build` seeds
// the persisted choice pre-mount so a capture defaults to a palette; empty = the
// provider's normal resolution (the operator toggles via the real ThemeSelector).
declare const __TWIN_THEME__: string;
if (__TWIN_THEME__) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, __TWIN_THEME__);
  } catch {
    /* localStorage unavailable (some file:// contexts) — provider falls back */
  }
}

// Seeded data is authoritative: never stale, never refetch, never retry (daemon-free).
queryClient.setDefaultOptions({
  queries: {
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  },
});
seedTwinCache(queryClient);

// The twin's own router over the REAL routeTree, with a MEMORY history pinned to the target
// route — a static double-clickable file (file://) has no server path for browser history
// to match, so without this the app renders Not Found. Same components as production; only
// the history + entry wiring differ (FR-1).
const twinRouter = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: [TWIN_ROUTE] }),
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ThemeProvider>
        <RouterProvider router={twinRouter} />
      </ThemeProvider>
    </StrictMode>,
  );
}
