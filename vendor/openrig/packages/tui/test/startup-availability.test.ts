import { expect, it, vi } from "vitest";
import { StartupController, startupLines } from "../src/startup.js";
import { DaemonClient } from "../src/daemon-client.js";
import { LocalReadingController } from "../src/local-reading.js";
import { renderScreen } from "../src/render.js";
import { createViewState, emptySnapshot } from "../src/state.js";

it.each(["down", "unverified"])("keeps Help, local reading and skip usable before and after %s, with no effects", async (state) => {
  let finish!: (value: string) => void;
  const probe = new Promise<string>((resolve) => { finish = resolve; });
  const fetchImpl = vi.fn(async () => { throw new Error("read unavailable"); }); const startDaemon = vi.fn(); const onWork = vi.fn(); const onHelp = vi.fn();
  const controller = new StartupController({ client: new DaemonClient({ fetchImpl }), home: "/fixture", probe: () => probe,
    startDaemon, onWork, onHelp, onChange: () => {}, readLocal: async () => ({ entries: [], source: "/fixture/workspace", readAt: "now" }) });
  const pending = controller.refresh();
  await controller.key("?"); expect(onHelp).toHaveBeenCalledOnce();
  await controller.key("L"); expect(startupLines(controller.state).some((r) => r.text.includes("LOCAL READING"))).toBe(true);
  finish(JSON.stringify(state === "down" ? { state, discovery: { header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] } } : { state, evidence: { reason: "timeout" } }));
  await pending;
  expect(controller.state.local).toBeDefined(); // late status cannot eject a reader
  await controller.key("escape"); expect(controller.state.open).toBe(true);
  await controller.key("escape"); expect(controller.state.open).toBe(false);
  expect(onWork).toHaveBeenCalledOnce();
  expect(startDaemon).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledOnce();
});

it("skip remains available during an unresolved probe and a late response does not reopen startup", async () => {
  let finish!: (value: string) => void;
  const onWork = vi.fn();
  const controller = new StartupController({ client: new DaemonClient({ fetchImpl: async () => { throw new Error("read unavailable"); } }), home: "/fixture", probe: () => new Promise((r) => { finish = r; }),
    startDaemon: vi.fn(), onWork, onChange: () => {} });
  const pending = controller.refresh(); await controller.key("w"); await vi.waitFor(() => expect(finish).toBeDefined());
  expect(controller.state.open).toBe(false); expect(onWork).toHaveBeenCalledOnce();
  finish("{}"); await pending; expect(controller.state.open).toBe(false);
});

it("Back abandons a slow local read without accepting its late result", async () => {
  let finish!: (value: {}) => void;
  const local = new LocalReadingController(() => new Promise((r) => { finish = r; }), () => {});
  const pending = local.load(); expect(await local.key("escape")).toBe(false);
  finish({ error: "late" }); await pending; expect(local.state.result).toEqual({});
});

it("explicit startup return leaves local reading and never claims skipped live data is empty", async () => {
  const controller = new StartupController({ client: new DaemonClient({ fetchImpl: async () => { throw new Error("read unavailable"); } }), home: "/fixture", probe: async () => "{}",
    startDaemon: vi.fn(), onWork: vi.fn(), onChange: () => {}, readLocal: async () => ({ entries: [] }) });
  await controller.key("L"); expect(controller.state.local).toBeDefined();
  await controller.open(); expect(controller.state.local).toBeUndefined();
  expect(controller.state.open).toBe(true);
  const snap = emptySnapshot(); snap.readErrors.push("Live data not loaded · connection unverified · L Local reading · S Startup");
  const screen = renderScreen(createViewState({ instanceId: "test" }).get(), snap, { cols: 80, rows: 24 });
  expect(screen.lines.join("\n")).toContain("Live data not loaded");
  expect(screen.lines.join("\n")).not.toContain("proven empty");
});

it("80-column startup exposes utility keys and local text scrolls as logical rows", () => {
  const controller = new StartupController({ client: new DaemonClient(), home: "/fixture", probe: async () => "{}", startDaemon: vi.fn(), onWork: vi.fn(), onChange: () => {} });
  const view = createViewState({ instanceId: "test" });
  controller.state.busy = true;
  let screen = renderScreen(view.get(), emptySnapshot(), { cols: 80, rows: 24, startup: controller.state });
  expect(screen.lines.join("\n")).toContain("? Help · w Skip · L Local");
  controller.state.local = { request: { op: "read" }, selected: 0, scroll: 15, busy: false,
    result: { content: Array.from({ length: 50 }, (_, i) => `source line ${i}`).join("\r\n"), absolutePath: "/fixture/SPEC.md", totalBytes: 100, mtime: "now", contentHash: "abc" } };
  screen = renderScreen(view.get(), emptySnapshot(), { cols: 80, rows: 24, startup: controller.state });
  expect(screen.lines.join("\n")).toContain("source line 10");
  expect(screen.lines.every((line) => !line.includes("\r"))).toBe(true);
});
