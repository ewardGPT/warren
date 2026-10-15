// twin:capture wrapper.
//
// One command turns a twin surface into the durable per-slice artifact set:
//   twin:build (TWIN_ROUTE passthrough) -> headless-Chrome screenshot -> place under
//   digital-twin/<slice-id>/ via the FR-5 resolver -> capture the change.diff -> enforce D-1.
//
// Composes the tested pure helpers (resolveArtifactPaths, buildChromeScreenshotArgs); this file is
// the thin IO orchestration. Zero net-new dependency: reuses the repo's headless Google Chrome and
// the existing twin:build. Determinism (D-1) is ENFORCED at runtime: the surface is shot twice and
// the PNGs are byte-compared; a mismatch fails loudly (never a silently-flaky artifact). The
// emptyOutDir gotcha is handled by copying artifacts OUT of twin-out into the per-slice folder
// within this single invocation (one surface per run).
//
// Usage:
//   tsx twin/capture/twin-capture.ts --slice example-slice --surface "Topology Graph" \
//     --route /topology/rig/rig_alpha --out-root /abs/path/to/digital-twin
// Flags: --slice (req) --surface (req) --route (default "/") --out-root (req)
//        --chrome (optional Chrome binary override)
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveArtifactPaths } from "./artifact-paths.js";
import { buildChromeScreenshotArgs, classifyCaptureResult, fileUrl, type CaptureVerdict } from "./headless-chrome.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** packages/ui (this file lives at packages/ui/twin/capture/). */
const UI_DIR = path.resolve(__dirname, "..", "..");
/** repo/worktree root (for git diff of the fixture/variant edit). */
const REPO_ROOT = path.resolve(UI_DIR, "..", "..");

interface Args {
  slice: string;
  surface: string;
  route: string;
  outRoot: string;
  chrome?: string;
  /** FR-6: optional real shipped-UI URL to capture as the paired PROOF (post-build, daemon-backed). */
  proofUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "";
    }
  }
  const missing = ["slice", "surface", "out-root"].filter((k) => !out[k]);
  if (missing.length) {
    fail(`missing required flag(s): ${missing.map((m) => "--" + m).join(", ")}`);
  }
  return {
    slice: out["slice"] ?? "",
    surface: out["surface"] ?? "",
    route: out["route"] || "/",
    outRoot: out["out-root"] ?? "",
    chrome: out["chrome"] || undefined,
    proofUrl: out["proof-url"] || undefined,
  };
}

function fail(msg: string): never {
  process.stderr.write(`twin:capture FAILED — ${msg}\n`);
  process.exit(1);
}

/** Resolve a usable headless-Chrome binary or fail honestly (never silently skip). */
function resolveChrome(override?: string): string {
  const candidates = [
    override,
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const which = spawnSync("bash", ["-lc", "command -v google-chrome chromium chrome 2>/dev/null | head -1"], {
    encoding: "utf8",
  });
  const found = which.stdout.trim().split("\n")[0];
  if (found) return found;
  return fail("no headless Chrome found (set --chrome or CHROME_BIN; macOS default is Google Chrome.app)");
}

/** vtb settles the static file:// twin deterministically (intent + D-1). */
const INTENT_VTB_MS = 9000;
/** Generous bound for the fast file:// capture. */
const INTENT_TIMEOUT_MS = 30_000;
/** Bounded ceiling for the live http:// proof capture (no vtb) so a non-completing route fails loud. */
const PROOF_TIMEOUT_MS = 20_000;

interface CaptureOpts {
  url: string;
  pngPath: string;
  virtualTimeBudgetMs?: number;
  timeoutMs: number;
}

/**
 * Screenshot a URL with a BOUNDED process timeout, interpret the result honestly, and remove a partial
 * PNG on failure. Never hangs — a non-completing capture is a loud, bounded failure (qa repro 7a578b32:
 * the prior unbounded + always-vtb path hung on live UI routes).
 */
function captureScreenshot(chrome: string, opts: CaptureOpts): CaptureVerdict {
  const r = spawnSync(
    chrome,
    buildChromeScreenshotArgs({ url: opts.url, pngPath: opts.pngPath, virtualTimeBudgetMs: opts.virtualTimeBudgetMs }),
    { encoding: "utf8", timeout: opts.timeoutMs },
  );
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const verdict = classifyCaptureResult({
    status: r.status,
    signal: r.signal,
    timedOut,
    pngExists: existsSync(opts.pngPath),
  });
  if (!verdict.ok) rmSync(opts.pngPath, { force: true });
  return verdict;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const chrome = resolveChrome(args.chrome);
  const paths = resolveArtifactPaths({ slice: args.slice, surface: args.surface, outRoot: args.outRoot });

  // 1. Build the twin for the target surface (TWIN_ROUTE passthrough — the proven mechanism).
  const build = spawnSync("npm", ["run", "twin:build"], {
    cwd: UI_DIR,
    env: { ...process.env, TWIN_ROUTE: args.route },
    stdio: "inherit",
  });
  if (build.status !== 0) fail(`twin:build failed (status ${build.status})`);

  const builtHtml = path.join(UI_DIR, "twin-out", "intent.html");
  if (!existsSync(builtHtml)) fail(`expected build output not found: ${builtHtml}`);

  // 2. Place artifacts under digital-twin/<slice-id>/ BEFORE any next build wipes twin-out.
  mkdirSync(paths.dir, { recursive: true });
  copyFileSync(builtHtml, paths.intentHtml); // regenerable, but emitted for convenience

  // 3. Screenshot the surface (file:// twin) -> the durable intent.png. vtb settles the static page.
  const builtUrl = fileUrl(builtHtml);
  const iv = captureScreenshot(chrome, {
    url: builtUrl,
    pngPath: paths.intentPng,
    virtualTimeBudgetMs: INTENT_VTB_MS,
    timeoutMs: INTENT_TIMEOUT_MS,
  });
  if (!iv.ok) fail(`intent capture failed — ${iv.reason}`);

  // 4. D-1 determinism: shoot again to a scratch png and byte-compare; mismatch = loud failure.
  const scratch = path.join(paths.dir, ".determinism-check.png");
  const dv = captureScreenshot(chrome, {
    url: builtUrl,
    pngPath: scratch,
    virtualTimeBudgetMs: INTENT_VTB_MS,
    timeoutMs: INTENT_TIMEOUT_MS,
  });
  if (!dv.ok) fail(`D-1 second capture failed — ${dv.reason}`);
  const identical = readFileSync(paths.intentPng).equals(readFileSync(scratch));
  rmSync(scratch, { force: true });
  if (!identical) fail("D-1 determinism check FAILED — two captures of the same surface differ (flake)");

  // 5. change.diff — the durable essence: the uncommitted fixture/variant edit that produced this.
  const diff = spawnSync("git", ["-C", REPO_ROOT, "diff", "--", "packages/ui/twin", "packages/ui/src"], {
    encoding: "utf8",
  });
  writeFileSync(paths.changeDiff, diff.stdout ?? "");

  // 6. FR-6 proof-side (optional): capture the REAL shipped UI at --proof-url in the IDENTICAL format
  //    (same chrome mechanism, paired <surface>.proof.png) for side-by-side intent-vs-proof. Needs a
  //    running build/daemon, so it is a post-build step — OFF by default to keep the intent path daemon-free.
  let proofLine = "  proof   : (skipped — pass --proof-url <real-ui-url> post-build to capture)\n";
  if (args.proofUrl) {
    // Live http:// route: NO virtual-time-budget (it hangs on never-idle live UIs); bounded timeout.
    const pv = captureScreenshot(chrome, {
      url: args.proofUrl,
      pngPath: paths.proofPng,
      timeoutMs: PROOF_TIMEOUT_MS,
    });
    if (!pv.ok) fail(`proof capture failed (${args.proofUrl}) — ${pv.reason}`);
    proofLine = `  proof   : ${paths.proofPng} (from ${args.proofUrl})\n`;
  }

  process.stdout.write(
    `twin:capture OK\n` +
      `  surface : ${args.surface} (route ${args.route})\n` +
      `  intent  : ${paths.intentPng}\n` +
      proofLine +
      `  diff    : ${paths.changeDiff}${(diff.stdout ?? "").trim() ? "" : " (empty — no pending edit)"}\n` +
      `  html    : ${paths.intentHtml} (regenerable)\n` +
      `  D-1     : deterministic (two captures byte-identical)\n`,
  );
}

main();
