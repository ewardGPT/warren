// OPR.0.4.1.19 — Story tab: reconstruct a FOREST of DAGs from queue-item lineage.
//
// The edges are REAL, never inferred. The daemon records lineage three ways
// (queue-repository.ts / migrations 024,025,035):
//   - chain_of_record: an ordered ancestry array of qitem-ids
//     `[...source.chain, source.qitemId]` — the tail is the DIRECT parent, the
//     whole array is the path back to a root.
//   - handed_off_from: the parent QITEM ID on a handoff-created qitem (== chain
//     tail). (NB the asymmetry: the source's handed_off_to is a SESSION.)
//   - workflow_step_trails prior->next: explicit edges when a workflow is active.
//
// Each qitem has at most ONE parent => the Story graph is a TRUE ACYCLIC
// git-history DAG (loops are linear repetition; branches need not reconverge).
// Fan-OUT is real data (a parent with several children). A visual fan-IN /
// convergence is a RENDERING affordance ONLY, never a 2-parent data node — which
// is why git-merge stays illustrative (build guardrail 1).
//
// fallback() appends a non-qitem sentinel `fallback-from:<session>` to a chain,
// so the reconstructor must tolerate chain entries that do not resolve to a known
// qitem (skip them; never crash).

export interface StoryQitemInput {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  closureReason?: string | null;
  closureTarget?: string | null;
  priority?: string | null;
  tier?: string | null;
  blockedOn?: string | null;
  tags: string[] | null;
  body: string;
  /** OPR.0.4.1.18 enforced human-readable summary; degrade to first body line when absent. */
  summary?: string | null;
  chainOfRecord: string[] | null;
  handedOffFrom?: string | null;
  handedOffTo?: string | null;
  claimedAt?: string | null;
  expiresAt?: string | null;
  closureRequiredAt?: string | null;
  lastNudgeAttempt?: string | null;
  lastNudgeResult?: string | null;
  lastHeartbeat?: string | null;
  resolution?: string | null;
  targetRepo?: string | null;
}

export interface StoryNode {
  qitemId: string;
  summary: string;
  /** The seat that owns/owned the work (destination). Component may render source->dest. */
  owner: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  closureReason: string | null;
  closureTarget: string | null;
  priority: string | null;
  tier: string | null;
  blockedOn: string | null;
  tags: string[];
  body: string;
  tsCreated: string;
  tsUpdated: string;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  claimedAt: string | null;
  expiresAt: string | null;
  closureRequiredAt: string | null;
  lastNudgeAttempt: string | null;
  lastNudgeResult: string | null;
  lastHeartbeat: string | null;
  resolution: string | null;
  targetRepo: string | null;
  /** Full chain_of_record (may include unresolved / sentinel entries). */
  chain: string[];
  /** Resolved direct parent qitem id, or null for a root. */
  parentId: string | null;
  childIds: string[];
  isRoot: boolean;
  isHumanOrigin: boolean;
  /** Gutter lane index (0 = the mission spine). */
  lane: number;
}

export interface StoryForest {
  /** Ordered most-recent-first (top of the upward-growing graph). */
  nodes: StoryNode[];
  roots: string[];
  laneCount: number;
}

function firstBodyLine(body: string): string {
  const line = (body ?? "").split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ?? "(no summary)";
}

function deriveSummary(item: StoryQitemInput): string {
  const summary = item.summary?.trim();
  return summary && summary.length > 0 ? summary : firstBodyLine(item.body);
}

function isHumanOrigin(item: StoryQitemInput, tags: string[]): boolean {
  if (tags.includes("human-origin")) return true;
  const src = item.sourceSession ?? "";
  // Managed seats are `pod-member@rig`; a bare token (no `@`) is a human origin.
  if (!src.includes("@")) return true;
  return /\b(founder|human|operator)\b/i.test(src);
}

/**
 * Resolve a qitem's direct parent: the LAST chain_of_record entry that resolves
 * to a known qitem (walking past unknown / sentinel entries), falling back to
 * handed_off_from when the chain is absent. Returns null for a root.
 */
function resolveParent(item: StoryQitemInput, known: Set<string>): string | null {
  const chain = item.chainOfRecord ?? [];
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const candidate = chain[i];
    if (candidate && candidate !== item.qitemId && known.has(candidate)) return candidate;
  }
  const handedOffFrom = item.handedOffFrom ?? null;
  if (handedOffFrom && handedOffFrom !== item.qitemId && known.has(handedOffFrom)) {
    return handedOffFrom;
  }
  return null;
}

/**
 * Reconstruct the forest of DAGs from queue items. Pure: no I/O, deterministic.
 */
export function buildStoryForest(items: StoryQitemInput[]): StoryForest {
  if (items.length === 0) return { nodes: [], roots: [], laneCount: 0 };

  const known = new Set(items.map((i) => i.qitemId));

  // Base node objects (lanes filled in below).
  const nodeById = new Map<string, StoryNode>();
  for (const item of items) {
    const tags = item.tags ?? [];
    nodeById.set(item.qitemId, {
      qitemId: item.qitemId,
      summary: deriveSummary(item),
      owner: item.destinationSession,
      sourceSession: item.sourceSession,
      destinationSession: item.destinationSession,
      state: item.state,
      closureReason: item.closureReason ?? null,
      closureTarget: item.closureTarget ?? null,
      priority: item.priority ?? null,
      tier: item.tier ?? null,
      blockedOn: item.blockedOn ?? null,
      tags,
      body: item.body,
      tsCreated: item.tsCreated,
      tsUpdated: item.tsUpdated,
      handedOffTo: item.handedOffTo ?? null,
      handedOffFrom: item.handedOffFrom ?? null,
      claimedAt: item.claimedAt ?? null,
      expiresAt: item.expiresAt ?? null,
      closureRequiredAt: item.closureRequiredAt ?? null,
      lastNudgeAttempt: item.lastNudgeAttempt ?? null,
      lastNudgeResult: item.lastNudgeResult ?? null,
      lastHeartbeat: item.lastHeartbeat ?? null,
      resolution: item.resolution ?? null,
      targetRepo: item.targetRepo ?? null,
      chain: item.chainOfRecord ?? [],
      parentId: resolveParent(item, known),
      childIds: [],
      isRoot: false,
      isHumanOrigin: isHumanOrigin(item, tags),
      lane: 0,
    });
  }

  // Wire children + roots.
  const roots: string[] = [];
  for (const node of nodeById.values()) {
    if (node.parentId && nodeById.has(node.parentId)) {
      nodeById.get(node.parentId)!.childIds.push(node.qitemId);
    } else {
      node.parentId = null;
      node.isRoot = true;
      roots.push(node.qitemId);
    }
  }

  // Lane assignment over chronological order (oldest first = bottom of the graph).
  // First child continues its parent's lane; later children (fan-out) get a fresh
  // lane; a tip with no children frees its lane. A freed lane is reusable only by
  // a STRICTLY-LATER node that is NOT a sibling — so concurrent branches and
  // fan-out siblings stay visually distinct while long missions still compact
  // (git-graph "lanes that close out"), bounding total width.
  const chronological = [...items].sort(
    (a, b) => tsValue(a.tsCreated) - tsValue(b.tsCreated),
  );
  const freed: { lane: number; ts: number; parentId: string | null }[] = [];
  let nextLane = 0;
  let maxLane = -1;
  const placedChildren = new Map<string, number>();

  const allocateLane = (node: StoryNode): number => {
    const ts = tsValue(node.tsCreated);
    let best: { idx: number; lane: number } | null = null;
    for (let i = 0; i < freed.length; i += 1) {
      const f = freed[i];
      if (!f) continue;
      const eligible = f.ts < ts && !(f.parentId !== null && f.parentId === node.parentId);
      if (eligible && (best === null || f.lane < best.lane)) best = { idx: i, lane: f.lane };
    }
    let lane: number;
    if (best) {
      lane = best.lane;
      freed.splice(best.idx, 1);
    } else {
      lane = nextLane++;
    }
    if (lane > maxLane) maxLane = lane;
    return lane;
  };

  for (const item of chronological) {
    const node = nodeById.get(item.qitemId)!;
    let lane: number;
    if (node.parentId && nodeById.has(node.parentId)) {
      const parent = nodeById.get(node.parentId)!;
      const order = placedChildren.get(parent.qitemId) ?? 0;
      placedChildren.set(parent.qitemId, order + 1);
      lane = order === 0 ? parent.lane : allocateLane(node);
    } else {
      lane = allocateLane(node);
    }
    node.lane = lane;
    if (node.childIds.length === 0) {
      // Tip closes out -> its lane can be reused by a strictly-later non-sibling.
      freed.push({ lane, ts: tsValue(node.tsCreated), parentId: node.parentId });
    }
  }

  // Render order: most-recent first (top), so the graph grows upward.
  const nodes = [...nodeById.values()].sort(
    (a, b) => tsValue(b.tsCreated) - tsValue(a.tsCreated),
  );

  return { nodes, roots, laneCount: maxLane + 1 };
}

function tsValue(ts: string): number {
  const v = Date.parse(ts);
  return Number.isNaN(v) ? 0 : v;
}

/**
 * Story-row date format (OPR.0.4.1.19 date-not-time fix).
 *
 * The shipped row date used `formatFriendlyDate`, which collapses same-day
 * timestamps to "Today HH:MM" — during active development every story item is
 * same-day, so the calendar date was hidden (effectively time-only). The founder
 * wants the explicit DATE always. This always renders month + day + time
 * (e.g. "Jun 23 4:50"), never "Today"/"Yesterday", matching the approved mockup.
 */
export function formatStoryDate(value: string | undefined | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
