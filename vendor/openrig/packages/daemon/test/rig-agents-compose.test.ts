// OPR.0.4.4.22 — the rig-scope composition root (slice 22 FR-1..FR-4).
// Pure-composer tests: same inputs → byte-identical output; the three NAMED
// ▲ heuristics only; honest unknowns; provenance everywhere.

import { describe, it, expect } from "vitest";
import {
  composeRigAgents,
  deriveAgentScopeExceptions,
  IDLE_WITH_WORK_THRESHOLD_MIN,
  TOO_LONG_IN_STATE_THRESHOLD_MIN,
  type AgentInput,
  type AttentionInput,
  type RigComposeInputs,
} from "../src/domain/review/compose.js";
import type { SettledRow } from "../src/domain/review/types.js";

const NOW = "2026-07-04T18:00:00.000Z";

function agent(overrides: Partial<AgentInput> = {}): AgentInput {
  return {
    agentName: "driver1",
    sessionName: "dev44-driver1@openrig-delivery",
    runtime: "claude-code",
    parkedOn: null,
    idle: false,
    idleSinceIso: null,
    doing: "building the follow-mode half",
    holdsCount: 1,
    lastTransitionIso: "2026-07-04T17:50:00.000Z",
    slices: ["19-signal-layer"],
    ...overrides,
  };
}

function park(overrides: Partial<AttentionInput> = {}): AttentionInput {
  return {
    qitemId: "qitem-1",
    summary: "waiting on your follow-mode call",
    leg: "park-on-human",
    where: "human-review@kernel",
    createdAtIso: "2026-07-04T16:00:00.000Z",
    priority: "urgent",
    tier: "critical",
    evidenceRef: "proof/OPTIONS.md",
    unblocks: "qitem-1",
    destinationSession: "human-review@kernel",
    closureRequiredAtIso: null,
    ...overrides,
  };
}

function inputs(overrides: Partial<RigComposeInputs> = {}): RigComposeInputs {
  return {
    agents: [agent()],
    overdue: [],
    attention: [],
    settled: [],
    handoffsToday: 0,
    overdueCount: 0,
    rosterWindow: "today",
    nowIso: NOW,
    ...overrides,
  };
}

describe("composeRigAgents — FR-1 rows + provenance", () => {
  it("renders one row per agent with the C6 doing line, never ids as primary labels", () => {
    const composed = composeRigAgents(inputs());
    expect(composed.agents.rows).toHaveLength(1);
    expect(composed.agents.rows[0]!.doing).toBe("building the follow-mode half");
    expect(composed.agents.rows[0]!.agentName).toBe("driver1");
  });

  it("idempotent projection: same inputs → byte-identical output", () => {
    const a = composeRigAgents(inputs());
    const b = composeRigAgents(inputs());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("proven-empty roster renders provenance WITH the ruled display window, never a blank region", () => {
    const composed = composeRigAgents(inputs({ agents: [] }));
    expect(composed.agents.rows).toHaveLength(0);
    expect(composed.agents.provenance).toContain("no agents holding or recently holding work");
    expect(composed.agents.provenance).toContain("window: today");
    expect(composed.agents.provenance).toContain("queue+ps");
  });

  it("scope negative: rows carry only the slices the agent holds work on — grouping input is per-agent slices, never rig co-residency", () => {
    const composed = composeRigAgents(inputs({
      agents: [agent(), agent({ sessionName: "dev44-qa1@openrig-delivery", agentName: "qa1", slices: ["20-composer"] })],
    }));
    expect(composed.agents.rows[0]!.slices).toEqual(["19-signal-layer"]);
    expect(composed.agents.rows[1]!.slices).toEqual(["20-composer"]);
  });
});

describe("FR-2 — honest state glyphs", () => {
  it("telemetry-down agent renders unknown; never upgraded to active/idle", () => {
    const composed = composeRigAgents(inputs({ agents: [agent({ idle: null, idleSinceIso: null })] }));
    expect(composed.agents.rows[0]!.stateGlyph).toBe("unknown");
  });

  it("healthy telemetry renders active/idle from the recorded state", () => {
    const composed = composeRigAgents(inputs({
      agents: [agent(), agent({ sessionName: "b@r", idle: true, idleSinceIso: "2026-07-04T17:00:00.000Z", holdsCount: 0 })],
    }));
    expect(composed.agents.rows[0]!.stateGlyph).toBe("active");
    expect(composed.agents.rows[1]!.stateGlyph).toBe("idle");
  });

  it("queue-proven parked work takes row-state precedence over runtime activity", () => {
    const composed = composeRigAgents(inputs({
      agents: [agent({ parkedOn: "human-review@kernel", idle: false, doing: "waiting on your follow-mode call" })],
    }));
    expect(composed.agents.rows[0]!.stateGlyph).toBe("parked");
    expect(composed.agents.rows[0]!.doing).toBe("waiting on your follow-mode call");
  });
});

describe("FR-3 — the three NAMED ▲ heuristics at agent scope", () => {
  it("idle-with-assigned-work past threshold carries evidence + threshold inline", () => {
    const idleSince = "2026-07-04T17:13:00.000Z"; // 47m before NOW
    const composed = composeRigAgents(inputs({
      agents: [agent({ idle: true, idleSinceIso: idleSince, holdsCount: 2 })],
    }));
    const row = composed.agents.rows[0]!;
    expect(row.exception).not.toBeNull();
    expect(row.exception!.kind).toBe("stuck");
    expect(row.exception!.evidence).toBe(`idle 47m >= ${IDLE_WITH_WORK_THRESHOLD_MIN}m default · holds 2`);
  });

  it("unknown is not idle: no ▲ derives from an unknown activity state", () => {
    const composed = composeRigAgents(inputs({
      agents: [agent({ idle: null, idleSinceIso: null, holdsCount: 3, lastTransitionIso: "2026-07-04T17:55:00.000Z" })],
    }));
    expect(composed.agents.rows[0]!.exception).toBeNull();
    expect(composed.needsYou.items.filter((i) => i.source === "derived")).toHaveLength(0);
  });

  it("too-long-in-state fires only with a KNOWN lastTransition past the threshold, evidence inline", () => {
    const old = "2026-07-04T15:00:00.000Z"; // 180m before NOW ≥ 120m default
    const composed = composeRigAgents(inputs({ agents: [agent({ lastTransitionIso: old })] }));
    const row = composed.agents.rows[0]!;
    expect(row.exception).not.toBeNull();
    expect(row.exception!.threshold).toBe(`too-long-in-state >= ${TOO_LONG_IN_STATE_THRESHOLD_MIN}m`);
    expect(row.exception!.evidence).toContain("no transition for 180m");
    // No lastTransition → no ▲ (no evidence, no accusation).
    const unknownTransition = composeRigAgents(inputs({ agents: [agent({ lastTransitionIso: null })] }));
    expect(unknownTransition.agents.rows[0]!.exception).toBeNull();
  });

  it("overdue handoff (past closure_required_at) lands in NEEDS YOU as a derived item", () => {
    const composed = composeRigAgents(inputs({
      overdue: [park({ closureRequiredAtIso: "2026-07-04T17:00:00.000Z" })],
    }));
    const overdue = composed.needsYou.items.find((i) => i.derived?.kind === "overdue");
    expect(overdue).toBeDefined();
    expect(overdue!.derived!.evidence).toContain("closure required at");
  });

  it("one-count identity: a ▲ appears once even when it feeds both the row and NEEDS YOU", () => {
    const idleSince = "2026-07-04T17:13:00.000Z";
    const composed = composeRigAgents(inputs({
      agents: [agent({ idle: true, idleSinceIso: idleSince, holdsCount: 2 })],
    }));
    const identities = composed.needsYou.items.map((i) => i.identity);
    expect(new Set(identities).size).toBe(identities.length);
    const stuck = composed.needsYou.items.filter((i) => i.derived?.kind === "stuck");
    expect(stuck).toHaveLength(1);
  });

  it("slice-only ▲ classes (insufficient-proof / stale-after-change) can NEVER fire at agent scope", () => {
    const items = deriveAgentScopeExceptions([agent()], [], "rig", NOW);
    expect(items.every((i) => i.derived!.kind === "stuck" || i.derived!.kind === "overdue")).toBe(true);
  });
});

describe("FR-4 — coordination health + SETTLED (same computation, two renders)", () => {
  it("health line renders handoffs today + overdue count", () => {
    const composed = composeRigAgents(inputs({ handoffsToday: 4, overdueCount: 1 }));
    expect(composed.agents.coordinationHealth).toBe("4 handoffs today · 1 overdue");
  });

  it("zero handoffs renders '0 handoffs today' WITH provenance — never blank", () => {
    const composed = composeRigAgents(inputs());
    expect(composed.agents.coordinationHealth).toBe("0 handoffs today · 0 overdue");
    expect(composed.settledProvenance).toContain("0 handoffs today");
    expect(composed.settledProvenance).toContain("computed from queue transitions");
  });

  it("SETTLED rows agree with the health count when supplied from the one query", () => {
    const settled: SettledRow[] = [
      { fromSession: "a@r", toSession: "b@r", summary: "shipped the panel", closedAtIso: NOW, qitemId: "qitem-9" },
    ];
    const composed = composeRigAgents(inputs({ settled, handoffsToday: settled.length }));
    expect(composed.settled).toHaveLength(1);
    expect(composed.agents.coordinationHealth).toContain("1 handoffs today");
  });
});

describe("NEEDS YOU at rig scope — parks + one-count with provenance", () => {
  it("an agent-initiated park renders with its C6 summary and provenance names the window", () => {
    const composed = composeRigAgents(inputs({ attention: [park()] }));
    expect(composed.needsYou.items[0]!.summary).toBe("waiting on your follow-mode call");
    expect(composed.needsYou.provenance).toContain("window: today");
  });
});
