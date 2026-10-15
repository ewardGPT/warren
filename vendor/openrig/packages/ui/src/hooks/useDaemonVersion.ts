// OPR.0.4.1.14 — running daemon version for the dashboard Field Environment.
//
// Wraps GET /api/health-summary/version, a dependency-free read of the daemon's
// own package.json. This is the REAL running version of the daemon serving the
// UI — deliberately NOT the UI bundle's build-time version, which would
// silently drift if the installed daemon and UI ever differ. The consumer
// renders an honest fallback while loading or if the fetch fails.

import { useQuery } from "@tanstack/react-query";

export interface DaemonVersionPayload {
  version: string;
}

async function fetchDaemonVersion(): Promise<DaemonVersionPayload> {
  const res = await fetch("/api/health-summary/version");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as DaemonVersionPayload;
}

export function useDaemonVersion() {
  return useQuery({
    queryKey: ["health-summary", "version"],
    queryFn: fetchDaemonVersion,
    // The daemon version is fixed for the life of a daemon process; no need to
    // refetch within a session.
    staleTime: Infinity,
  });
}
