// OPR.0.4.1.11.2 (FR-5) — deterministic artifact naming + placement for twin captures.
// A pure resolver: given a slice + surface + output root, it returns the stable, collision-safe
// paths the capture wrapper writes (intent.html / intent.png / change.diff) under a per-slice
// folder. Pure + deterministic so the same input always yields the same paths — the foundation
// FR-2's deterministic-naming + the D-1 capture-twice check depend on. `outRoot` is a parameter
// (not baked) because the canonical root path + normalize-existing decision are an open
// convention call (Open-Q3); this module owns only the deterministic MECHANISM.
import path from "node:path";

export interface ArtifactPathInput {
  /** Slice identifier — becomes the per-slice folder name (slugified). */
  slice: string;
  /** The surface/mockup the artifact captures (e.g. a route or human label) — becomes the file base (slugified). */
  surface: string;
  /** The digital-twin artifact root the per-slice folder lands under. */
  outRoot: string;
}

export interface ArtifactPaths {
  /** outRoot/<slice-slug> — the per-slice folder. */
  dir: string;
  /** <dir>/<surface-slug>.intent.html — the regenerable single-file prototype. */
  intentHtml: string;
  /** <dir>/<surface-slug>.intent.png — the durable INTENT screenshot (from the twin, pre-build). */
  intentPng: string;
  /** <dir>/<surface-slug>.proof.png — the durable PROOF screenshot (from the real shipped UI, post-build). Pairs with intentPng. */
  proofPng: string;
  /** <dir>/<surface-slug>.change.diff — the durable fixture/variant override diff. */
  changeDiff: string;
}

/**
 * Slugify an arbitrary label/route into a lowercase, filesystem-safe token for the SURFACE base:
 * collapse every run of non-alphanumeric characters (including dots and slashes) to a single
 * hyphen and trim leading/trailing hyphens. Deterministic (no time/randomness) so output is
 * reproducible. Use for surface/route names — NOT for the slice-id (see sanitizeSliceId).
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Sanitize a slice identifier into the per-slice FOLDER name. Unlike slugify, this PRESERVES dots
 * because the ratified convention (pm + brief1-curator) is digital-twin/<slice-id>/ where the
 * slice-id is the dotted OPR id (e.g. `opr-0.4.1.11.2`). Lowercases and collapses any other unsafe
 * run (spaces/slashes/etc.) to a single hyphen; dots stay. Deterministic.
 */
export function sanitizeSliceId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** Resolve the deterministic artifact paths for a twin capture. */
export function resolveArtifactPaths(input: ArtifactPathInput): ArtifactPaths {
  const dir = path.posix.join(input.outRoot, sanitizeSliceId(input.slice));
  const base = slugify(input.surface);
  return {
    dir,
    intentHtml: path.posix.join(dir, `${base}.intent.html`),
    intentPng: path.posix.join(dir, `${base}.intent.png`),
    proofPng: path.posix.join(dir, `${base}.proof.png`),
    changeDiff: path.posix.join(dir, `${base}.change.diff`),
  };
}
