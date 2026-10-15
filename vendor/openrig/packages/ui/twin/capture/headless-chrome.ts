// OPR.0.4.1.11.2 (FR-2 + FR-6) — deterministic headless-chrome screenshot argv + result classifier.
// URL-based so the SAME mechanism captures the INTENT (file:// twin) and the PROOF (http:// real
// shipped UI). The timing flag is PARAMETERIZED, not shared blindly: --virtual-time-budget settles a
// static/daemon-free file:// page deterministically (D-1), but it does NOT complete on a live http://
// OpenRig route (SSE/polling keep the page from going idle, so the virtual clock never finishes and
// Chrome hangs — qa repro, candidate 7a578b32). Intent keeps vtb; proof omits it. Capture failures
// are interpreted honestly + boundedly by classifyCaptureResult (no silent hang).
export interface ChromeScreenshotInput {
  /** The page to capture — a file:// twin URL (intent) or an http:// real-UI URL (proof). */
  url: string;
  /** Absolute path the screenshot PNG is written to. */
  pngPath: string;
  /**
   * Milliseconds for --virtual-time-budget. Pass for STATIC/file:// captures (intent + D-1) so async
   * paints settle deterministically. OMIT for live http:// routes — vtb hangs when the page never
   * goes idle. When undefined/0 the flag is left off and Chrome shoots after load.
   */
  virtualTimeBudgetMs?: number;
}

/** Turn an absolute filesystem path into a file:// URL (for capturing the twin's intent.html). */
export function fileUrl(absPath: string): string {
  return `file://${absPath}`;
}

/**
 * Build the argv for a deterministic headless-Chrome screenshot. `--virtual-time-budget` is included
 * only when a positive `virtualTimeBudgetMs` is given (static intent/D-1); omitted for live proof URLs.
 */
export function buildChromeScreenshotArgs(input: ChromeScreenshotInput): string[] {
  const args = ["--headless=new", "--window-size=1440,900"];
  if (typeof input.virtualTimeBudgetMs === "number" && input.virtualTimeBudgetMs > 0) {
    args.push(`--virtual-time-budget=${input.virtualTimeBudgetMs}`);
  }
  args.push(`--screenshot=${input.pngPath}`, input.url);
  return args;
}

export interface CaptureResultInput {
  /** spawnSync status (null if the process was killed/errored). */
  status: number | null;
  /** spawnSync signal (e.g. SIGTERM when the bounded timeout killed it). */
  signal: string | null;
  /** True when the process exceeded its bounded timeout (spawnSync ETIMEDOUT). */
  timedOut: boolean;
  /** Whether the screenshot file actually exists after the run. */
  pngExists: boolean;
}

export interface CaptureVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Interpret a screenshot process result honestly and boundedly. A timeout is a loud failure (never a
 * silent hang); a non-zero/killed exit is a failure; an exit-0 with no PNG is a failure; only exit-0
 * WITH the PNG present is success. Pure — unit-testable without spawning.
 */
export function classifyCaptureResult(r: CaptureResultInput): CaptureVerdict {
  if (r.timedOut) {
    return { ok: false, reason: "timed out (bounded kill) — capture did not complete" };
  }
  if (r.status !== 0) {
    const sig = r.signal ? ` (signal ${r.signal})` : "";
    return { ok: false, reason: `chrome exited with status ${r.status ?? "null"}${sig}` };
  }
  if (!r.pngExists) {
    return { ok: false, reason: "chrome exited 0 but no screenshot was written" };
  }
  return { ok: true, reason: "ok" };
}
