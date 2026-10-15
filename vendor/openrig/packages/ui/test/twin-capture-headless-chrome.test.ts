// OPR.0.4.1.11.2 (FR-2 + FR-6) — deterministic headless-chrome screenshot argv + bounded verdict.
// The timing flag is parameterized by capture kind: intent (static file://) RETAINS
// --virtual-time-budget for a deterministic settle (D-1); proof (live http://) OMITS it because it
// hangs on never-idle live routes (qa repro on candidate 7a578b32). classifyCaptureResult makes any
// failure (timeout / non-zero / no-png) loud and bounded — never a silent hang.
import { describe, it, expect } from "vitest";
import { buildChromeScreenshotArgs, classifyCaptureResult, fileUrl } from "../twin/capture/headless-chrome.js";

describe("buildChromeScreenshotArgs (OPR.0.4.1.11.2 FR-2/FR-6: deterministic headless capture)", () => {
  it("intent (static file://) RETAINS --virtual-time-budget for deterministic settle / D-1", () => {
    const args = buildChromeScreenshotArgs({
      url: "file:///x/twin-out/intent.html",
      pngPath: "/x/out/topology.intent.png",
      virtualTimeBudgetMs: 9000,
    });
    expect(args).toEqual([
      "--headless=new",
      "--window-size=1440,900",
      "--virtual-time-budget=9000",
      "--screenshot=/x/out/topology.intent.png",
      "file:///x/twin-out/intent.html",
    ]);
  });

  it("proof (live http://) OMITS --virtual-time-budget (it hangs on never-idle live routes)", () => {
    const args = buildChromeScreenshotArgs({
      url: "http://localhost:5173/topology",
      pngPath: "/x/out/topology.proof.png",
    });
    expect(args.some((a) => a.startsWith("--virtual-time-budget"))).toBe(false);
    expect(args[args.length - 1]).toBe("http://localhost:5173/topology");
    expect(args).toContain("--screenshot=/x/out/topology.proof.png");
  });

  it("fileUrl turns an absolute path into a file:// URL", () => {
    expect(fileUrl("/x/twin-out/intent.html")).toBe("file:///x/twin-out/intent.html");
  });

  it("is deterministic — identical inputs yield identical argv", () => {
    const a = buildChromeScreenshotArgs({ url: "file:///i.html", pngPath: "/o.png", virtualTimeBudgetMs: 9000 });
    const b = buildChromeScreenshotArgs({ url: "file:///i.html", pngPath: "/o.png", virtualTimeBudgetMs: 9000 });
    expect(a).toEqual(b);
  });
});

describe("classifyCaptureResult (OPR.0.4.1.11.2 FR-6: bounded/honest capture verdict)", () => {
  it("a timeout is a loud, bounded failure (never a silent hang)", () => {
    const v = classifyCaptureResult({ status: null, signal: "SIGTERM", timedOut: true, pngExists: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/timed out/i);
  });

  it("exit 0 WITH the png present is success", () => {
    expect(classifyCaptureResult({ status: 0, signal: null, timedOut: false, pngExists: true })).toEqual({
      ok: true,
      reason: "ok",
    });
  });

  it("exit 0 but NO png written is a failure (honest, not silently ok)", () => {
    const v = classifyCaptureResult({ status: 0, signal: null, timedOut: false, pngExists: false });
    expect(v.ok).toBe(false);
  });

  it("a non-zero exit is a failure naming the status", () => {
    const v = classifyCaptureResult({ status: 1, signal: null, timedOut: false, pngExists: false });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/status 1/);
  });
});
