// Living Notes Packet 2 — MISSION_BRIEF status-spine convergence (OPR.0.4.4.20 FR-8).
//
// ONE computation path: the spine sections (Building / Progress / Proven /
// Needs you) are rendered HERE from the composed mission review; the tab
// serves them always-fresh (pure projection, zero writes) and the SAME
// strings are written into MISSION_BRIEF.md ONLY at the deliberate freeze
// moments — never a watcher, never a continuous writer. Generation is
// SECTION-SCOPED: hand-authored prose in non-spine sections ("What & why",
// "Pointers") is byte-untouched, and the pinned exact-order H2 schema the
// scope audit enforces is preserved by construction (the header list is
// IMPORTED from the audit, not re-declared).

import { MISSION_BRIEF_HEADERS } from "../scope/scope-audit.js";
import type { ComposedMissionReview } from "./types.js";

export interface BriefSpine {
  building: string;
  progress: string;
  proven: string;
  needsYou: string;
}

/** The four generated section bodies — derived from the same composer
 *  queries FR-7 renders (no second computation path). */
export function renderBriefSpine(m: ComposedMissionReview): BriefSpine {
  const byLane = (lane: string) => m.board.filter((b) => b.laneLabel === lane);
  const buildingRows = [...byLane("BUILD"), ...byLane("PLAN")];
  const building =
    buildingRows.length === 0
      ? "_Nothing in flight._"
      : buildingRows.map((b) => `- ${b.slice} — ${b.laneLabel} · ${b.stageCell}`).join("\n");

  const progress =
    m.board.length === 0
      ? "_No slices yet._"
      : ["INTENT", "PLAN", "BUILD", "REVIEW", "LOCKED"]
          .map((lane) => `- ${lane}: ${byLane(lane).length}`)
          .join("\n");

  const greenRows = m.ledger.filter((r) => r.green);
  const proven =
    greenRows.length === 0
      ? "_Nothing proven yet._"
      : greenRows
          .map((r) => `- ${r.slice} — proven at ${r.candidateSha ?? "unknown"} · merged ${r.mergeSha ?? "UNMERGED"}`)
          .join("\n") + `\n\nCut-gating: ${m.cutComplete ? "COMPLETE" : "incomplete"} — ${m.cutCompleteBasis}`;

  const needsYou =
    m.needsYou.items.length === 0
      ? `_${m.needsYou.provenance}_`
      : m.needsYou.items.map((i) => `- ${i.source === "derived" ? "▲" : "●"} ${i.summary} (${i.leg})`).join("\n");

  return { building, progress, proven, needsYou };
}

const SPINE_BY_HEADER: Record<string, keyof BriefSpine> = {
  Building: "building",
  Progress: "progress",
  Proven: "proven",
  "Needs you": "needsYou",
};

/**
 * Section-scoped application: replaces ONLY the four spine section bodies in
 * an existing MISSION_BRIEF.md, preserving every other byte (hand-authored
 * "What & why"/"Pointers", the H1, frontmatter, ordering). Returns null when
 * the brief does not carry the pinned schema (never guess-rewrite a
 * malformed brief — the audit owns that finding).
 */
export function applyBriefSpine(briefContent: string, spine: BriefSpine): string | null {
  const lines = briefContent.split("\n");
  // Locate each pinned H2 (exact-order schema).
  const headerIdx: number[] = [];
  const headerName: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^##\s+(.+?)\s*$/);
    if (m) {
      headerIdx.push(i);
      headerName.push(m[1]!);
    }
  }
  // The brief must carry the exact pinned sequence to be generation-safe.
  if (headerName.length !== MISSION_BRIEF_HEADERS.length) return null;
  for (let i = 0; i < MISSION_BRIEF_HEADERS.length; i++) {
    if (headerName[i] !== MISSION_BRIEF_HEADERS[i]) return null;
  }

  const out: string[] = [];
  out.push(...lines.slice(0, headerIdx[0]!));
  for (let h = 0; h < headerIdx.length; h++) {
    const start = headerIdx[h]!;
    const end = h + 1 < headerIdx.length ? headerIdx[h + 1]! : lines.length;
    const name = headerName[h]!;
    const spineKey = SPINE_BY_HEADER[name];
    out.push(lines[start]!);
    if (spineKey) {
      out.push("", spine[spineKey], "");
    } else {
      out.push(...lines.slice(start + 1, end));
    }
  }
  return out.join("\n");
}
