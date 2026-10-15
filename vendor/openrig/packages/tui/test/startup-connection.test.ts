import { afterEach, expect, it, vi } from "vitest";
import { DaemonClient } from "../src/daemon-client.js";
import { StartupController, startupLines } from "../src/startup.js";

afterEach(() => vi.useRealTimers());
const unavailable = JSON.stringify({ state: "unverified", evidence: { pidState: "alive", probeResult: "timeout", failedSignal: "700ms recovery probe" } });
function fixture(fetchImpl: typeof fetch, verdict = unavailable) {
  const probe = vi.fn(async () => verdict), onWork = vi.fn(), startDaemon = vi.fn();
  const controller = new StartupController({ client: new DaemonClient({ baseUrl: "http://entry-fixture", fetchImpl, headers: { Authorization: "Bearer fixture" } }),
    home: "/fixture", probe, onWork, startDaemon, onChange: () => {} });
  return { controller, probe, onWork, startDaemon };
}
it("enters from a normal authenticated read slower than the recovery probe without manual refresh", async () => {
  vi.useFakeTimers();
  const fetchImpl = vi.fn(async () => { await new Promise(r => setTimeout(r, 900));
    return new Response(JSON.stringify([{ id: "r", name: "working", lifecycleState: "running" }])); });
  const f = fixture(fetchImpl); const pending = f.controller.refresh();
  await vi.advanceTimersByTimeAsync(900); await pending;
  expect(f.controller.state.connection).toBe("up"); expect(f.controller.state.open).toBe(false);
  expect(f.onWork).toHaveBeenCalledOnce(); expect(f.probe).not.toHaveBeenCalled();
  expect(f.startDaemon).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledOnce();
  expect(fetchImpl).toHaveBeenCalledWith("http://entry-fixture/api/rigs/summary",
    expect.objectContaining({ headers: { Authorization: "Bearer fixture" }, signal: expect.any(AbortSignal) }));
});
it.each([401, 403])("keeps a %s catalog refusal visible even if the recovery probe says up", async status => {
  const f = fixture(vi.fn(async () => new Response("denied", { status })), JSON.stringify({ state: "up" }));
  await f.controller.refresh();
  expect(f.controller.state.connection).toBe("unverified"); expect(f.controller.state.page).toBe("unavailable");
  expect(f.controller.state.notice).toContain(String(status)); expect(f.onWork).not.toHaveBeenCalled();
  expect(f.startDaemon).not.toHaveBeenCalled();
  expect(startupLines(f.controller.state).some(r => r.text.includes("Start daemon;"))).toBe(false);
});
it("does not treat a malformed successful catalog as a confirmed connection", async () => {
  const f = fixture(vi.fn(async () => new Response(JSON.stringify([null]))), JSON.stringify({ state: "up" }));
  await f.controller.refresh();
  expect(f.controller.state.connection).toBe("unverified"); expect(f.controller.state.page).toBe("unavailable");
  expect(f.controller.state.notice).toContain("usable rig list"); expect(f.onWork).not.toHaveBeenCalled();
  expect(f.startDaemon).not.toHaveBeenCalled();
});
it("retains positive down discovery only after the ordinary read fails, without automatic effects", async () => {
  const fetchImpl = vi.fn(async () => { throw new Error("connection refused"); });
  const f = fixture(fetchImpl, JSON.stringify({ state: "down", discovery: { header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] } }));
  await f.controller.refresh();
  expect(fetchImpl).toHaveBeenCalledOnce(); expect(f.probe).toHaveBeenCalledOnce();
  expect(f.controller.state.connection).toBe("down"); expect(f.controller.state.page).toBe("down");
  expect(f.startDaemon).not.toHaveBeenCalled(); expect(f.onWork).not.toHaveBeenCalled();
});
