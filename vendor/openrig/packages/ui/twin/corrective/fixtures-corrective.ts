// CORRECTIVE REDESIGN 2026-07-05 — twin fixtures for the ONE-structure
// review contract (§3.1), typed against src/hooks/useReview.ts = the tsc
// drift-guard. Fictional acme/EX.2.0.0 family. Scenario coverage: a UI slice
// (planned mockups + curated proof + verified/unverified/missing + extraProof
// + plan-locked/proof-pending) and a non-UI slice (§5: no plannedRef, not a
// gate). All lookups degrade (?? / miss → 404), never throw at module eval.

import type {
  ComposedSliceReview,
  ComposedMissionReview,
  ReviewMedia,
  NeedsYouBand,
  AgentsBand,
  VerifyLineage,
} from "../../src/hooks/useReview.js";
import type { SliceDetail, SliceListEntry, QueueItemDetail } from "../../src/hooks/useSlices.js";
import { walkthroughWebmDataUri } from "./media-webm.js";

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The PLANNED mockup (what the planning agent locked). */
const plannedMockup: ReviewMedia = {
  kind: "image",
  src: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
      <rect width="640" height="400" fill="#faf9f5"/>
      <text x="20" y="30" font-family="monospace" font-size="13" fill="#57534e">PLANNED MOCKUP — review stack @390</text>
      <rect x="20" y="44" width="290" height="60" fill="#fff" stroke="#d6d3d1"/><text x="30" y="80" font-family="monospace" font-size="12" fill="#292524">INTENT</text>
      <rect x="20" y="112" width="290" height="90" fill="#fff" stroke="#d6d3d1"/><text x="30" y="148" font-family="monospace" font-size="12" fill="#292524">PLAN + mockup</text>
      <rect x="20" y="210" width="290" height="150" fill="#fff" stroke="#d6d3d1"/><text x="30" y="246" font-family="monospace" font-size="12" fill="#292524">DELIVERED (paired proof)</text>
    </svg>`,
  ),
  caption: "planned: the three-section stack at 390 (locked mockup)",
};

/** Curated DELIVERED artifacts. */
const deliveredShot: ReviewMedia = {
  kind: "image",
  src: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
      <rect width="640" height="400" fill="#faf9f5"/>
      <text x="20" y="30" font-family="monospace" font-size="13" fill="#166534">DELIVERED — review stack @390 (real build)</text>
      <rect x="20" y="44" width="290" height="60" fill="#fff" stroke="#a3a3a1"/><text x="30" y="80" font-family="monospace" font-size="12" fill="#292524">INTENT</text>
      <rect x="20" y="112" width="290" height="90" fill="#fff" stroke="#a3a3a1"/><text x="30" y="148" font-family="monospace" font-size="12" fill="#292524">PLAN + mockup</text>
      <rect x="20" y="210" width="290" height="150" fill="#fff" stroke="#a3a3a1"/><text x="30" y="246" font-family="monospace" font-size="12" fill="#292524">DELIVERED (paired proof)</text>
    </svg>`,
  ),
  caption: "delivered: the built stack at 390 — QA compared against the locked mockup",
};

const drawerShot: ReviewMedia = {
  kind: "image",
  src: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
      <rect width="640" height="360" fill="#faf9f5"/>
      <rect x="380" y="0" width="260" height="360" fill="#fff" stroke="#d6d3d1"/>
      <text x="392" y="28" font-family="monospace" font-size="12" fill="#292524">PROOF.md — reader drawer (right)</text>
      <text x="20" y="30" font-family="monospace" font-size="12" fill="#a8a29e">page content behind</text>
    </svg>`,
  ),
  caption: "evidence opens in the shared right-side drawer",
};

const videoPoster = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
    <rect width="640" height="360" fill="#292524"/>
    <circle cx="320" cy="180" r="36" fill="#faf9f5" opacity="0.9"/>
    <path d="M308 160 L344 180 L308 200 Z" fill="#292524"/>
    <text x="20" y="340" font-family="monospace" font-size="12" fill="#a8a29e">walkthrough — 6s, frame counter visible</text>
  </svg>`,
);

/** §7.3 surface leg — REAL playable media (VP8 bytes inline). */
export const walkthroughVideo: ReviewMedia = {
  kind: "video",
  src: walkthroughWebmDataUri,
  poster: videoPoster,
  caption: "walkthrough (6s) — approve+chat flow; the frame counter proves playback",
};

const PROV = "computed from queue + ps + proof artifacts + git · as of Sep 1, 03:12";

const needsYou07: NeedsYouBand = {
  provenance: PROV,
  items: [
    {
      source: "agent",
      identity: "qitem-ex2-07-gate",
      summary: "Sign off the review-surface rebuild for the merge train",
      leg: "attention",
      where: "EX.2.0.0.07",
      ageIso: "2025-09-01T01:12:00.000Z",
      priority: "urgent",
      tier: "human-gate",
      evidenceRef: "PROOF.md",
      unblocks: "merge-train entry",
      qitemId: "qitem-ex2-07-gate",
      destinationSession: "human-mike@host",
      derived: null,
    },
    {
      source: "derived",
      identity: "derived:capture-2:stuck",
      summary: "capture-2 looks stuck on the dark-parity frame (the missing deliverable)",
      leg: "exception",
      where: "EX.2.0.0.07",
      ageIso: "2025-09-01T02:40:00.000Z",
      priority: null,
      tier: null,
      evidenceRef: null,
      unblocks: null,
      qitemId: null,
      destinationSession: null,
      derived: { kind: "stuck", evidence: "idle 47m while holding 1 assigned item", threshold: "idle-with-work ≥ 30m" },
    },
  ],
};

const agents07: AgentsBand = {
  scope: "slice:EX.2.0.0.07",
  provenance: PROV,
  coordinationHealth: "4 handoffs today · 0 overdue",
  rows: [
    { agentName: "builder2", runtime: "claude-code", stateGlyph: "active", doing: "vellum polish on the stack", holdsCount: 1, lastTransitionIso: "2025-09-01T02:58:00.000Z", exception: null, sessionName: "builder2@acme-build", slices: ["EX.2.0.0.07"] },
    { agentName: "qa-1", runtime: "codex", stateGlyph: "parked", doing: "holding the mockup↔delivered comparison log", holdsCount: 1, lastTransitionIso: "2025-09-01T02:10:00.000Z", exception: null, sessionName: "qa-1@acme-build", slices: ["EX.2.0.0.07"] },
    { agentName: "capture-2", runtime: "claude-code", stateGlyph: "unknown", doing: "dark-parity frame (assigned)", holdsCount: 1, lastTransitionIso: "2025-09-01T02:13:00.000Z", exception: { kind: "stuck", evidence: "idle 47m WITH assigned work", threshold: "≥ 30m" }, sessionName: "capture-2@acme-build", slices: ["EX.2.0.0.07"] },
  ],
};

const lineage07: VerifyLineage = {
  candidateSha: "4e91ab77",
  mergeSha: null,
  mainTip: "c27f2aff",
  freshness: "fresh",
  staleBehind: null,
  gateCells: [
    { role: "guard", recordedToken: "CLEAR", tone: "pass", state: "passing", source: "proof/guard-verdict.md" },
    { role: "qa", recordedToken: "PASS", tone: "pass", state: "passing", source: "proof/qa-verdict.md" },
    { role: "rev1-r1", recordedToken: "CLEAR", tone: "pass", state: "passing", source: "proof/rev1-r1.md" },
    { role: "rev1-r2", recordedToken: null, tone: "unknown", state: "missing", source: null },
  ],
};

/** The UI slice — the dogfood case (§9): the rebuilt surface reviewing itself. */
const review07: ComposedSliceReview = {
  slice: "EX.2.0.0.07",
  sliceId: "07",
  title: "Review surface rebuild: the one-structure stack (example)",
  missionId: "release-2.0.0",
  phase: "review",
  laneLabel: "REVIEW",
  composedAt: "2025-09-01T03:12:00.000Z",
  intent: {
    text: "When I open a slice I want one column I scan top-to-bottom: what I intended, the plan it became, and the proof it got built — screenshots paired with what they prove, so I never hunt.",
    media: [],
    ssotPath: "README.md",
    degrade: null,
  },
  plan: {
    concise: {
      text: [
        "**Mini-requirements**",
        "1. ONE vertical stack — INTENT → PLAN → DELIVERED — phone-first at 390.",
        "2. Each planned deliverable pairs with its curated proof; QA's comparison verdict renders per item.",
        "3. Quick actions everywhere: APPROVE + CHAT; media actually plays; vellum cards over the dot grid.",
      ].join("\n"),
      media: [plannedMockup],
    },
    lockedArtifacts: [
      { name: "IMPLEMENTATION-PRD.md", path: "IMPLEMENTATION-PRD.md", kind: "prd" },
      { name: "stack-mockup.png", path: "mockups/stack-390.png", kind: "mockup" },
    ],
    lock: { by: "human-mike@host", at: "Aug 30", auditVerified: true },
    ssotPath: "IMPLEMENTATION-PRD.md",
  },
  delivered: {
    items: [
      {
        promised: { text: "The review tab renders the INTENT → PLAN → DELIVERED stack at 390, single column", plannedRef: plannedMockup },
        proof: [deliveredShot],
        verified: "verified",
        note: "compared against the locked mockup — structure matches; spacing delta < 2px (comparison log in proof/)",
      },
      {
        promised: { text: "Walkthrough video: the approve + chat flow end-to-end" },
        proof: [walkthroughVideo],
        verified: "verified",
        note: "watched the full 6s take — both actions land, terminal preamble correct",
      },
      {
        promised: { text: "Evidence opens in the shared right-side drawer", plannedRef: drawerShot },
        proof: [drawerShot],
        verified: "unverified",
      },
      {
        promised: { text: "Dark-mode parity frame for the full stack" },
        proof: [],
        verified: "missing",
        note: "kicked back — capture-2 holds the item",
      },
    ],
    extraProof: [
      { kind: "image", src: videoPoster, caption: "poster still — walkthrough hero frame (not tied to one deliverable)" },
    ],
    lock: null,
    proofDirPath: "proof/",
  },
  needsYou: needsYou07,
  agents: agents07,
  lineage: lineage07,
  defects: [],
};

/** The non-UI slice (§5) — no mockups, no plannedRef; proves itself its own way. */
const review08: ComposedSliceReview = {
  slice: "EX.2.0.0.08",
  sliceId: "08",
  title: "Proof-drop CLI extension: deliverable + verified args (example)",
  missionId: "release-2.0.0",
  phase: "building",
  laneLabel: "BUILD",
  composedAt: "2025-09-01T03:12:00.000Z",
  intent: {
    text: "QA's proof drop should say WHICH promised deliverable it proves and whether QA actually compared it — so the surface can pair and mark them without guessing.",
    media: [],
    ssotPath: "README.md",
    degrade: null,
  },
  plan: {
    concise: {
      text: "**Mini-requirements**\n1. `rig proof <slice>` gains `--deliverable` + `--verified` + `--note` args (extend the verb, never a new one).\n2. A drop without a comparison verdict leaves the deliverable visibly unverified.",
      media: [],
    },
    lockedArtifacts: [{ name: "IMPLEMENTATION-PRD.md", path: "IMPLEMENTATION-PRD.md", kind: "prd" }],
    lock: { by: "lead@acme-build", at: "Aug 31", auditVerified: true },
    ssotPath: "IMPLEMENTATION-PRD.md",
  },
  delivered: {
    items: [
      {
        promised: { text: "CLI accepts --deliverable and records it in the C1 header" },
        proof: [{ kind: "image", src: drawerShot.src, caption: "terminal transcript — the extended drop (text proof; non-UI slice)" }],
        verified: "verified",
        note: "ran the drop against a fixture slice; header carries the deliverable ref",
      },
      {
        promised: { text: "A drop with no comparison verdict composes as unverified" },
        proof: [],
        verified: "missing",
      },
    ],
    extraProof: [],
    lock: null,
    proofDirPath: "proof/",
  },
  needsYou: { provenance: PROV, items: [] },
  agents: {
    scope: "slice:EX.2.0.0.08",
    provenance: PROV,
    coordinationHealth: null,
    rows: [
      { agentName: "cli-dev1", runtime: "codex", stateGlyph: "active", doing: "extending the proof verb args", holdsCount: 1, lastTransitionIso: "2025-09-01T02:50:00.000Z", exception: null, sessionName: "cli-dev1@acme-build", slices: ["EX.2.0.0.08"] },
    ],
  },
  lineage: {
    candidateSha: null,
    mergeSha: null,
    mainTip: "c27f2aff",
    freshness: "unknown",
    staleBehind: null,
    gateCells: [
      { role: "guard", recordedToken: null, tone: "unknown", state: "missing", source: null },
      { role: "qa", recordedToken: null, tone: "unknown", state: "missing", source: null },
      { role: "rev1-r1", recordedToken: null, tone: "unknown", state: "missing", source: null },
      { role: "rev1-r2", recordedToken: null, tone: "unknown", state: "missing", source: null },
    ],
  },
  defects: [],
};

export const correctiveReviewBySlice: Record<string, ComposedSliceReview> = {
  "EX.2.0.0.07": review07,
  "EX.2.0.0.08": review08,
};

export const correctiveMissionReview: Record<string, ComposedMissionReview> = {
  "release-2.0.0": {
    mission: "release-2.0.0",
    missionId: "release-2.0.0",
    title: "Release 2.0.0 (example)",
    intent: "Ship the corrected review surface — one structure, paired proof, honest verification.",
    briefSpine: {
      building: "1 slice building (the CLI extension).",
      progress: "1 in review · 1 building.",
      proven: "guard + qa + rev1-r1 recorded on the rebuild candidate.",
      needsYou: "1 sign-off pending + 1 derived exception.",
    },
    board: [
      { slice: "EX.2.0.0.07", title: "Review surface rebuild (example)", phase: "review", laneLabel: "REVIEW", agentsCount: 3, stageCell: "proof 2/4 verified", changedSinceStamp: false, attentionWorthy: true },
      { slice: "EX.2.0.0.08", title: "Proof-drop CLI extension (example)", phase: "building", laneLabel: "BUILD", agentsCount: 1, stageCell: "on plan", changedSinceStamp: false, attentionWorthy: false },
    ],
    ledger: [
      { slice: "EX.2.0.0.07", candidateSha: "4e91ab77", gateCells: lineage07.gateCells, mergeSha: null, needsHumanCount: 1, green: false },
    ],
    cutComplete: false,
    cutCompleteBasis: "EX.2.0.0.07 unmerged + rev1-r2 outstanding",
    needsYou: needsYou07,
    agents: { ...agents07, scope: "mission:release-2.0.0" },
    composedAt: "2025-09-01T03:12:00.000Z",
  },
};

// --- Slice-page prerequisites (/api/slices + /api/slices/:id) ---

export const correctiveSlices: SliceListEntry[] = [
  {
    name: "EX.2.0.0.07",
    missionId: "release-2.0.0",
    displayName: "Review surface rebuild: the one-structure stack (example)",
    railItem: "07",
    status: "active",
    rawStatus: "review",
    qitemCount: 1,
    hasProofPacket: true,
    lastActivityAt: "2025-09-01T03:10:00.000Z",
    slicePath: "/Users/x/code/workspace/missions/release-2.0.0/slices/07-review-stack",
  },
];

export const correctiveDetailByName: Record<string, SliceDetail> = {
  "EX.2.0.0.07": {
    name: "EX.2.0.0.07",
    missionId: "release-2.0.0",
    slicePath: "/Users/x/code/workspace/missions/release-2.0.0/slices/07-review-stack",
    displayName: "Review surface rebuild: the one-structure stack (example)",
    railItem: "07",
    status: "active",
    rawStatus: "review",
    qitemIds: ["qitem-ex2-07-gate"],
    commitRefs: ["4e91ab77"],
    lastActivityAt: "2025-09-01T03:10:00.000Z",
    workflowBinding: null,
    story: { events: [], phaseDefinitions: null },
    acceptance: { totalItems: 4, doneItems: 2, percentage: 50, items: [], closureCallout: null, currentStep: null },
    decisions: { rows: [] },
    docs: { tree: [
      { name: "README.md", type: "file", size: 900, mtime: "2025-08-30T10:00:00.000Z", relPath: "README.md" },
      { name: "IMPLEMENTATION-PRD.md", type: "file", size: 4100, mtime: "2025-08-30T12:00:00.000Z", relPath: "IMPLEMENTATION-PRD.md" },
      { name: "PROOF.md", type: "file", size: 1600, mtime: "2025-09-01T02:40:00.000Z", relPath: "PROOF.md" },
    ] },
    tests: { proofPackets: [], aggregate: { passCount: 2, failCount: 0 } },
    topology: { affectedRigs: [{ rigId: "rig_alpha", rigName: "acme-build", sessionNames: ["builder2@acme-build", "qa-1@acme-build"] }], totalSeats: 2, specGraph: null },
  },
};

export const correctiveQitemById: Record<string, QueueItemDetail> = {
  "qitem-ex2-07-gate": {
    qitemId: "qitem-ex2-07-gate",
    tsCreated: "2025-09-01T01:12:00.000Z",
    tsUpdated: "2025-09-01T01:12:00.000Z",
    sourceSession: "qa-1@acme-build",
    destinationSession: "human-mike@host",
    state: "pending",
    priority: "urgent",
    tier: "human-gate",
    tags: ["mission:release-2.0.0", "slice:EX.2.0.0.07", "sign-off"],
    body: "The review-surface rebuild is gate-pending: 2/4 deliverables QA-verified, walkthrough watched end-to-end. Sign off for the merge train once rev1-r2 lands.",
    summary: "Sign off the review-surface rebuild for the merge train",
    chainOfRecord: null,
    blockedOn: null,
  },
};

// --- Evidence markdown for the RIGHT drawer (/api/files/read) ---

export const correctiveMdByPath: Record<string, string> = {
  "missions/release-2.0.0/slices/07-review-stack/PROOF.md": [
    "# PROOF — EX.2.0.0.07 review-surface rebuild",
    "",
    "Curated set (the canonical “this is what it looks like now”):",
    "- stack @390: `proof/stack-390-delivered.png` — **QA-verified** against the locked mockup",
    "- walkthrough: `proof/walkthrough.webm` — **QA-verified** (watched end-to-end)",
    "- drawer frame: `proof/drawer-right.png` — unverified (no recorded comparison yet)",
    "- dark parity: **missing** (kicked back to capture-2)",
  ].join("\n"),
  "missions/release-2.0.0/slices/07-review-stack/IMPLEMENTATION-PRD.md": [
    "# IMPLEMENTATION-PRD — EX.2.0.0.07",
    "",
    "## Mini-requirements",
    "1. ONE vertical stack — INTENT → PLAN → DELIVERED — phone-first at 390.",
    "2. Deliverable↔proof pairing with per-item QA verification.",
    "",
    "## Proof contract",
    "- The review tab renders the stack at 390 (mockup: `mockups/stack-390.png`)",
    "- Walkthrough video: approve + chat end-to-end",
    "- Evidence opens in the shared right-side drawer",
    "- Dark-mode parity frame",
  ].join("\n"),
};
