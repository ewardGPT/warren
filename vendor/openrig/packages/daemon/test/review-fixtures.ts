// Living Notes Packet 2 — hand-authored fixture builders (OPR.0.4.4.20).
//
// Builds real on-disk slice fixtures conforming to the ratified convention
// contracts: C1 proof-artifact headers (closed sets), C7 pinned spec name
// (IMPLEMENTATION-PRD.md), the D2 `## Proof contract` section, and the
// approval frontmatter stamps (Packet 1 FR-9 shape). Used by the composer
// unit tests and by the proof-walk fixtures (two-regime walk, ledger
// tracking-gap replay).

import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { C1ArtifactType, C1Verdict } from "../src/domain/review/types.js";

export interface FixtureWorkspace {
  /** missions root (contains missions/<mission>/slices/<slice>). */
  root: string;
  missionDir(mission: string): string;
  sliceDir(mission: string, slice: string): string;
}

export function makeFixtureWorkspace(): FixtureWorkspace {
  const root = mkdtempSync(join(tmpdir(), "review-fixture-"));
  return {
    root,
    missionDir: (mission) => join(root, mission),
    sliceDir: (mission, slice) => join(root, mission, "slices", slice),
  };
}

export interface SliceFixtureOpts {
  /** Frontmatter id (dot-ID). */
  id?: string;
  title?: string;
  status?: string;
  /** Adds `ux-change: true`. */
  uxChange?: boolean;
  /** Approval stamps (Packet 1 FR-9 frontmatter shape). */
  approvedBy?: string;
  approvedAt?: string;
  specApprovedBy?: string;
  specApprovedAt?: string;
  /** Corrective §3.1 — the pinned plan set (`locked-artifacts:` frontmatter list). */
  lockedArtifacts?: Array<{ name: string; path: string; kind: string }>;
  /** README intent section body (verbatim-projected by FR-1). Omit to skip README. */
  intent?: string;
  /**
   * IMPLEMENTATION-PRD.md content controls:
   *  - miniReqs: the pinned concise tier lines at the PRD top
   *  - proofContract: `## Proof contract` checkbox items (D2)
   *  - prdBody: extra body markdown
   *  - prdCheckboxes: acceptance checkbox lines inside the PRD
   * Omit `prd` entirely (prd: false) for a not-specced slice.
   */
  prd?: false | {
    miniReqs?: string[];
    proofContract?: string[];
    prdCheckboxes?: Array<{ text: string; done?: boolean }>;
    prdBody?: string;
  };
  /** PROGRESS.md checkbox lines (the conflicting-source fixture). */
  progressCheckboxes?: Array<{ text: string; done?: boolean }>;
  /** README checkbox lines. */
  readmeCheckboxes?: Array<{ text: string; done?: boolean }>;
}

function checkboxLines(items: Array<{ text: string; done?: boolean }> | undefined): string {
  if (!items?.length) return "";
  return items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n") + "\n";
}

/** Writes a fixture slice dir; returns its absolute path. */
export function writeFixtureSlice(
  ws: FixtureWorkspace,
  mission: string,
  slice: string,
  opts: SliceFixtureOpts = {},
): string {
  const dir = ws.sliceDir(mission, slice);
  mkdirSync(join(dir, "proof"), { recursive: true });

  const fm: string[] = [];
  if (opts.id) fm.push(`id: ${opts.id}`);
  fm.push(`title: ${opts.title ?? slice}`);
  fm.push(`status: ${opts.status ?? "active"}`);
  if (opts.uxChange) fm.push("ux-change: true");
  if (opts.approvedBy) fm.push(`approved-by: ${opts.approvedBy}`);
  if (opts.approvedAt) fm.push(`approved-at: ${opts.approvedAt}`);
  if (opts.specApprovedBy) fm.push(`approved-spec-by: ${opts.specApprovedBy}`);
  if (opts.specApprovedAt) fm.push(`approved-spec-at: ${opts.specApprovedAt}`);
  if (opts.lockedArtifacts?.length) {
    fm.push("locked-artifacts:");
    for (const a of opts.lockedArtifacts) {
      fm.push(`  - name: ${a.name}`, `    path: ${a.path}`, `    kind: ${a.kind}`);
    }
  }

  if (opts.intent !== undefined || opts.readmeCheckboxes) {
    writeFileSync(
      join(dir, "README.md"),
      `---\n${fm.join("\n")}\n---\n\n# ${opts.title ?? slice}\n\n## Intent\n\n${opts.intent ?? ""}\n\n${checkboxLines(opts.readmeCheckboxes)}`,
    );
  } else {
    // Frontmatter still needs a home for status/stamps even without intent.
    writeFileSync(join(dir, "README.md"), `---\n${fm.join("\n")}\n---\n\n# ${opts.title ?? slice}\n`);
  }

  if (opts.prd !== false && opts.prd !== undefined) {
    const p = opts.prd;
    const mini = p.miniReqs?.length
      ? `## Mini-requirements\n\n${p.miniReqs.map((m, i) => `${i + 1}. ${m}`).join("\n")}\n\n`
      : "";
    const contract = p.proofContract?.length
      ? `## Proof contract\n\n${p.proofContract.map((c) => `- [ ] ${c}`).join("\n")}\n\n`
      : "";
    const acceptance = p.prdCheckboxes?.length ? `## Acceptance\n\n${checkboxLines(p.prdCheckboxes)}\n` : "";
    writeFileSync(
      join(dir, "IMPLEMENTATION-PRD.md"),
      `---\ntitle: ${opts.title ?? slice} PRD\n---\n\n${mini}# Spec\n\n${p.prdBody ?? ""}\n\n${acceptance}${contract}`,
    );
  }

  if (opts.progressCheckboxes) {
    writeFileSync(join(dir, "PROGRESS.md"), `# Progress\n\n${checkboxLines(opts.progressCheckboxes)}`);
  }

  return dir;
}

export interface ProofArtifactOpts {
  slice: string;
  candidateSha: string;
  artifactType: C1ArtifactType;
  /** Pass an out-of-set string to fixture an invalid verdict; omit for a missing one. */
  verdict?: C1Verdict | string;
  moneyEvidence?: string;
  evidences?: string[];
  selfCheck?: string;
  /** Filename under proof/ (defaults to <artifactType>.md). */
  fileName?: string;
  /** mtime for latest-wins ordering. */
  mtime?: Date;
  body?: string;
}

/** Drops a C1-headed proof artifact into <sliceDir>/proof/. */
export function writeProofArtifact(sliceDir: string, opts: ProofArtifactOpts): string {
  const fm: string[] = [
    `slice: ${opts.slice}`,
    `candidate_sha: ${opts.candidateSha}`,
    `artifact_type: ${opts.artifactType}`,
  ];
  if (opts.verdict !== undefined) fm.push(`verdict: ${opts.verdict}`);
  if (opts.moneyEvidence) fm.push(`money_evidence: ${opts.moneyEvidence}`);
  if (opts.evidences?.length) fm.push(`evidences:\n${opts.evidences.map((e) => `  - ${e}`).join("\n")}`);
  if (opts.selfCheck) fm.push(`self_check: ${opts.selfCheck}`);

  const file = join(sliceDir, "proof", opts.fileName ?? `${opts.artifactType}.md`);
  writeFileSync(file, `---\n${fm.join("\n")}\n---\n\n${opts.body ?? "Evidence body.\n"}`);
  if (opts.mtime) utimesSync(file, opts.mtime, opts.mtime);
  return file;
}

/** The regime-1 fixture: all four independent gate verdicts passing for one candidate SHA. */
export function writeFullGateSet(
  sliceDir: string,
  slice: string,
  candidateSha: string,
  overrides: Partial<Record<"guard" | "qa" | "rev1-r1" | "rev1-r2", C1Verdict | string | null>> = {},
): void {
  const defaults: Record<"guard" | "qa" | "rev1-r1" | "rev1-r2", C1Verdict> = {
    guard: "CLEAR",
    qa: "PASS",
    "rev1-r1": "CLEAR",
    "rev1-r2": "CLEAR",
  };
  for (const role of ["guard", "qa", "rev1-r1", "rev1-r2"] as const) {
    const v = role in overrides ? overrides[role] : defaults[role];
    if (v === null) continue; // absent artifact fixture
    writeProofArtifact(sliceDir, {
      slice,
      candidateSha,
      artifactType: role,
      verdict: v,
      moneyEvidence: `${role} money line`,
    });
  }
}
