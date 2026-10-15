import { expect, it } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { hydrateSnapshot } from "../src/hydrate.js";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { parseCommand } from "../src/grammar.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot } from "../src/types.js";

it.each([[140, 42], [80, 24]])("retains exact project through equal-ID work, file, Back and in-flight switching at %ix%i", async (cols, rows) => {
  const requests: string[] = [];
  let unavailable = false;
  const projects = ["a", "b"].map(id => ({ id, name: "Book", root: `/books/${id}`, sourcePath: `/books/${id}/SPEC.md`, missionsRoot: `/books/${id}/missions` }));
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async (url, init) => {
    const u = new URL(String(url)); requests.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
    const id = u.searchParams.get("project");
    let body: unknown;
    if (u.pathname === "/api/scopes/projects") body = { catalogPath: "/books/workspace.yaml", projects: projects.map(p => ({ ...p, ...(unavailable && p.id === "a" ? { error: "SPEC unavailable" } : {}) })) };
    else if (u.pathname === "/api/files/roots") body = { roots: projects.map(p => ({ name: p.id, path: p.root })) };
    else if (u.pathname === "/api/scopes") body = { missions: [{ mission: "release-x", slices: [{ ...demoSnapshot().scopes![0]!.slices[0]!, dirName: "01-story", id: "same-id", intent: `${id} unique intent`, sourcePath: `/books/${id}/missions/release-x/slices/01-story/SPEC.md` }] }], sources: { "release-x": `/books/${id}/missions/release-x/SPEC.md` } };
    else if (u.pathname === "/api/views/execution") body = { rows: [{ view: "execution", mission: "release-x", sources: {}, q1_lanes: [], q2_sequencing: [], q4_ladder: [], q5_park: [] }] };
    else if (u.pathname.startsWith("/api/slices")) body = null;
    else if (u.pathname === "/api/files/read") body = { root: u.searchParams.get("root"), path: u.searchParams.get("path"), absolutePath: `/books/${u.searchParams.get("root")}/SPEC.md`, content: "Authored project source", mtime: "2026-09-10T00:00:00Z", contentHash: "abc", size: 10, truncated: false, truncatedAtBytes: null, totalBytes: 10 };
    else throw new Error(`Unexpected read ${u.pathname}`);
    return Response.json(body);
  }) as typeof fetch });
  let snap: FleetSnapshot = emptySnapshot();
  const view = createViewState({ instanceId: "projects", getSnapshot: () => snap });
  async function refresh() { snap = await hydrateSnapshot(client, undefined, view.get().scopesMission, view.get().scopesSelected?.slice, null, view.get()); }
  const text = () => renderScreen(view.get(), snap, { cols, rows }).lines.join("\n");
  view.dispatch(parseCommand("projects")); await refresh();
  expect(text()).toContain("PROJECTS"); expect(text()).toContain("Book · a"); expect(text()).toContain("Book · b");
  view.dispatch(parseCommand("project a")); await refresh();
  view.dispatch(parseCommand("mission release-x")); await refresh();
  view.dispatch({ type: "scopes-open", mission: "release-x", slice: "01-story" }); await refresh();
  const caller = view.get();
  view.dispatch(parseCommand("source")); expect(view.get().file?.path).toContain("01-story/SPEC.md"); await refresh();
  expect(text()).toContain("Project a");
  view.dispatch({ type: "back" }); await refresh(); expect(view.get().project).toEqual(caller.project); expect(view.get().scopesSelected).toEqual(caller.scopesSelected);
  view.dispatch(parseCommand("project b"));
  expect(text()).toContain("Reading selected project"); expect(text()).not.toContain("a unique intent");
  await refresh(); expect(text()).toContain("PROJECT b"); expect(view.get().scopesMission).toBeNull();
  expect(computeExplorerRows(view.get(), snap)[view.get().selection]?.key).toBe("project:b");
  view.dispatch({ type: "back" }); await refresh(); expect(view.get().project?.id).toBe("a"); expect(view.get().scopesSelected?.slice).toBe("01-story");
  unavailable = true; await refresh(); expect(text()).toContain("SPEC unavailable"); expect(text()).not.toContain("a unique intent");
  expect(requests.every(r => r.startsWith("GET "))).toBe(true);
  for (const request of requests.filter(r => /GET \/api\/(scopes\?|views\/execution|slices\/)/.test(r))) {
    expect(request).toMatch(/project=[ab]/); expect(request).toMatch(/projectRoot=%2Fbooks%2F[ab]/);
  }
});

it.each([[140, 42], [80, 24]])("localizes malformed entries and recovers without contaminating healthy browsing at %ix%i", async (cols, rows) => {
  let repaired = false;
  const calls: string[] = [];
  const good = { ...demoSnapshot().scopes![0]!.slices[0]!, dirName: "good", id: "good", intent: "Healthy sibling intent" };
  const client = new DaemonClient({ baseUrl: "http://fixture", fetchImpl: (async url => {
    const u = new URL(String(url)); calls.push(u.pathname);
    if (u.pathname === "/api/scopes/projects") return Response.json({ catalogPath: "/books/workspace.yaml", projects: [{ id: "a", name: "Book", root: "/books/a" }] });
    if (u.pathname === "/api/scopes") return Response.json({ readErrors: [], missions: [
      { mission: "broken", slices: [], error: "Invalid frontmatter: /books/a/missions/broken/SPEC.md" },
      { mission: "mixed", slices: [good, { ...good, id: "bad", dirName: "bad", ...(repaired ? { intent: "Repaired source intent" } : { error: "Invalid frontmatter: /books/a/missions/mixed/slices/bad/SPEC.md", intent: "", status: null }) }] },
      { mission: "healthy", slices: [good] },
    ] });
    if (u.pathname === "/api/views/execution") return Response.json({ rows: [{ view: "execution", mission: u.searchParams.get("mission"), q1_lanes: [], q2_sequencing: [], q4_ladder: [], q5_park: [] }] });
    if (u.pathname.startsWith("/api/slices")) return Response.json(null);
    if (u.pathname === "/api/files/roots") return Response.json({ roots: [] });
    throw Error("Unexpected " + u.pathname);
  }) as typeof fetch });
  let snap = emptySnapshot();
  const view = createViewState({ instanceId: "errors", getSnapshot: () => snap });
  async function refresh() { snap = await hydrateSnapshot(client, undefined, view.get().scopesMission, view.get().scopesSelected?.slice, null, view.get()); }
  const content = () => renderScreen(view.get(), snap, { cols, rows }).lines.join("\n");
  view.dispatch(parseCommand("projects")); await refresh();
  view.dispatch(parseCommand("project a")); await refresh();
  expect(content()).toContain("broken · source unavailable");
  view.dispatch(parseCommand("mission healthy")); await refresh();
  expect(snap.readErrors).toEqual([]); expect(content()).not.toContain("Invalid frontmatter");
  view.dispatch(parseCommand("mission mixed")); await refresh();
  expect(content()).toContain("bad · source unavailable");
  view.dispatch({ type: "scopes-open", mission: "mixed", slice: "good" }); await refresh();
  expect(content()).not.toContain("Invalid frontmatter");
  view.dispatch({ type: "scopes-open", mission: "mixed", slice: "bad" }); calls.length = 0; await refresh();
  expect(content()).toContain("Source unavailable"); expect(content()).not.toContain("PROOF");
  expect(calls).not.toContain("/api/slices/bad"); expect(snap.readErrors).toEqual([]);
  repaired = true; await refresh(); expect(content()).not.toContain("Invalid frontmatter");
  view.dispatch({ type: "back" }); await refresh(); expect(view.get().scopesSelected?.slice).toBe("good");
  view.dispatch(parseCommand("mission broken")); calls.length = 0; await refresh();
  expect(content()).toContain("Source unavailable"); expect(calls).not.toContain("/api/views/execution");
  expect(content()).not.toContain("No missions found");
});
