import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adaptContextUsageEvidence,
  adaptLifecycleReceiptEvidence,
  adaptQueueTransitionEvidence,
  adaptWatchdogHistoryEvidence,
  adaptWorkGraphEvidence,
  boundHealthEvidence,
  deriveHealthSourceFreshness,
  type BoundedHealthEvidence,
  type HealthEvidenceReference,
  type HealthScope,
} from "../src/health-projection-surface.js";
import {
  HealthProjectionService,
  canonicalDetectorJson,
  evaluateHealthDetectors,
  type HealthDetectorObservation,
} from "../src/health-detectors-surface.js";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { UsageSamplesStore } from "../src/domain/usage-samples-store.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

interface ReplayCorpus {
  cases: {
    staleConductor: {
      scope: HealthScope;
      window: { startedAt: string; endedAt: string };
      lineage: string;
      transitionIds: number[];
      autoUnparks: Array<{ transitionId: number; observedAt: string; blockerId: string }>;
      clearingTransition: { transitionId: number; observedAt: string; state: string; closureReason: string };
      watchdog: { jobId: string; registeredAt: string; policy: string; directiveScope: string };
    };
    signedQuiescence: {
      scope: HealthScope;
      window: { startedAt: string; endedAt: string | null };
      authority: { receiptId: string; effectCount: number; stopOnMismatch: boolean };
      protectedSeats: string[];
    };
    scopeAdmissionCandidate: {
      scope: HealthScope;
      technicalReview: { reviewedAt: string; source: { artifact: string } };
      governingAuthorityEvidence: { availability: string; reason: string };
    };
    ordinaryControls: Array<{
      id: string;
      kind: "queue-transition" | "watchdog-history" | "work-graph" | "context-usage";
      events: Array<{
        sourceOrder: number;
        observedAt: string | null;
        state?: string;
        outcome?: string;
        candidate?: string;
        usedPercentage?: number | null;
        fresh?: boolean;
      }>;
    }>;
  };
}

const corpus = JSON.parse(readFileSync(
  new URL("./fixtures/health-projection/release-0.5.9.json", import.meta.url),
  "utf8",
)) as ReplayCorpus;

function boundedSource(input: {
  evidence: readonly HealthEvidenceReference[];
  startedAt: string;
  endedAt: string;
  source?: BoundedHealthEvidence["query"]["source"];
  fresh?: boolean;
  limit?: number;
}): BoundedHealthEvidence {
  const newest = input.evidence
    .map((item) => item.observedAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
  return boundHealthEvidence(input.evidence, {
    source: input.source ?? "mixed",
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    limit: input.limit ?? 200,
    retentionSeconds: 172_800,
  }, deriveHealthSourceFreshness({
    evaluatedAt: input.endedAt,
    newestSourceAt: newest,
    maxAgeSeconds: input.fresh === false ? 1 : 86_400,
    available: newest !== null,
  }));
}

function queueEvidence(input: {
  sourceOrder: number;
  transitionId: number;
  observedAt: string;
  qitemId?: string;
  state?: string;
}): HealthEvidenceReference {
  return adaptQueueTransitionEvidence({
    transitionId: input.transitionId,
    qitemId: input.qitemId ?? "qitem-lineage",
    ts: input.observedAt,
    state: input.state ?? "in-progress",
    actorSession: "orchestrator@rig",
    identityProvenance: "transport:v1",
  }, input.sourceOrder);
}

function staleConductorObservations(): HealthDetectorObservation[] {
  const subject = corpus.cases.staleConductor;
  const evidence = subject.autoUnparks.map((event, sourceOrder) => queueEvidence({
    sourceOrder,
    transitionId: event.transitionId,
    observedAt: event.observedAt,
    qitemId: subject.lineage,
    state: "auto-unparked",
  }));
  evidence.push(queueEvidence({
    sourceOrder: evidence.length,
    transitionId: subject.clearingTransition.transitionId,
    observedAt: subject.clearingTransition.observedAt,
    qitemId: subject.lineage,
    state: subject.clearingTransition.state,
  }));
  const source = boundedSource({
    evidence,
    startedAt: subject.window.startedAt,
    endedAt: subject.window.endedAt,
  });
  const base = {
    scope: subject.scope,
    episodeStartedAt: subject.window.startedAt,
    lastObservedAt: subject.window.endedAt,
    source,
  } as const;
  return [
    {
      ...base,
      kind: "coordination-lineage",
      lineageId: subject.lineage,
      coordinationTransitions: subject.transitionIds.length,
      productStateChanges: null, // The recorded full-day fixture has no product-outcome census.
      boundedAuthority: false,
      reviewReturns: 0,
      candidateChanges: 1,
      newRiskClasses: 0,
    },
    {
      ...base,
      kind: "wake-lineage",
      lineageId: subject.lineage,
      wakeCount: subject.autoUnparks.length,
      rescueWakeCount: 0,
      existingNextAction: true,
    },
    {
      ...base,
      kind: "directive",
      directiveId: subject.watchdog.jobId,
      declaredPhase: "implementation",
      currentPhase: "done",
      declaredRigor: "deep",
      currentRigor: null,
      conflictSourceAddress: `queue-transition:${subject.clearingTransition.transitionId}`,
    },
  ];
}

function simpleSource(
  scope: HealthScope,
  evidence: HealthEvidenceReference,
  startedAt = "2026-09-03T10:00:00Z",
  endedAt = "2026-09-03T11:00:00Z",
): Pick<HealthDetectorObservation, "scope" | "episodeStartedAt" | "lastObservedAt" | "source"> {
  return {
    scope,
    episodeStartedAt: startedAt,
    lastObservedAt: endedAt,
    source: boundedSource({ evidence: [evidence], startedAt, endedAt }),
  };
}

describe("deterministic health detectors", () => {
  it("preserves supported conductor signals without inventing a ceremony denominator", () => {
    const records = evaluateHealthDetectors(staleConductorObservations());
    expect(records.map((record) => record.detector)).toEqual([
      "governance.stale-directive",
      "process.ceremony-amplification",
      "process.redundant-wake-storm",
    ]);
    expect(records.filter((record) => record.detector !== "process.ceremony-amplification").every((record) => record.status === "active")).toBe(true);
    expect(records.find((record) => record.detector === "process.ceremony-amplification")?.status).toBe("indeterminate");
    expect(records.every((record) => record.confidence === "high")).toBe(true);
    expect(records.every((record) => record.window.startedAt === corpus.cases.staleConductor.window.startedAt)).toBe(true);
    expect(records.every((record) => record.evidence.length > 0)).toBe(true);
    expect(records.find((record) => record.detector === "process.ceremony-amplification")?.explanation)
      .toContain("product-outcome census unavailable, so no ratio is computed");
  });

  it("does not mistake signed quiescence breadth for ceremony amplification", () => {
    const subject = corpus.cases.signedQuiescence;
    const endedAt = "2026-09-04T05:20:58Z";
    const receipt = adaptLifecycleReceiptEvidence({
      sourceOrder: 0,
      observedAt: subject.window.startedAt,
      receiptId: subject.authority.receiptId,
      operation: "signed-quiescence",
      outcome: "clear",
    });
    const records = evaluateHealthDetectors([{
      ...simpleSource(subject.scope, receipt, subject.window.startedAt, endedAt),
      kind: "coordination-lineage",
      lineageId: subject.authority.receiptId,
      coordinationTransitions: subject.protectedSeats.length,
      productStateChanges: subject.authority.effectCount,
      boundedAuthority: subject.authority.stopOnMismatch,
      reviewReturns: 0,
      candidateChanges: 1,
      newRiskClasses: 0,
    }]);
    expect(records).toEqual([]);
  });

  it("requires unchanged candidates and no new risk class before calling a review carousel", () => {
    const scope = { type: "slice", projectId: "openrig", missionId: "release-0.5.10", sliceId: "S04" } as const;
    const evidence = queueEvidence({ sourceOrder: 0, transitionId: 1, observedAt: "2026-09-03T10:30:00Z" });
    const base = simpleSource(scope, evidence);
    const observation = {
      ...base,
      kind: "coordination-lineage" as const,
      lineageId: "candidate-a",
      coordinationTransitions: 12,
      productStateChanges: 0,
      boundedAuthority: false,
      reviewReturns: 4,
      candidateChanges: 0,
      newRiskClasses: 0,
    };
    expect(evaluateHealthDetectors([observation]).map((record) => record.detector))
      .toEqual(["process.review-carousel"]);
    expect(evaluateHealthDetectors([{ ...observation, candidateChanges: 1 }])).toEqual([]);
    expect(evaluateHealthDetectors([{ ...observation, newRiskClasses: 1 }])).toEqual([]);
    expect(evaluateHealthDetectors([{ ...observation, reviewReturns: 1 }])).toEqual([]);
  });

  it("subtracts useful rescue wakes and requires an already-recorded next action", () => {
    const scope = { type: "mission", projectId: "openrig", missionId: "release-0.5.10" } as const;
    const evidence = adaptWatchdogHistoryEvidence({
      historyId: "history-a",
      jobId: "job-a",
      evaluatedAt: "2026-09-03T10:30:00Z",
      outcome: "sent",
      deliveryStatus: "delivered",
    }, 0);
    const base = {
      ...simpleSource(scope, evidence),
      kind: "wake-lineage" as const,
      lineageId: "row-a",
      wakeCount: 4,
      rescueWakeCount: 0,
      existingNextAction: true,
    };
    expect(evaluateHealthDetectors([base]).map((record) => record.detector))
      .toEqual(["process.redundant-wake-storm"]);
    expect(evaluateHealthDetectors([{ ...base, rescueWakeCount: 1, wakeCount: 4 }])).toEqual([]);
    expect(evaluateHealthDetectors([{ ...base, existingNextAction: false }])).toEqual([]);
  });

  it("requires a structured phase or rigor conflict for stale directives", () => {
    const scope = { type: "mission", projectId: "openrig", missionId: "release-0.5.10" } as const;
    const evidence = adaptWatchdogHistoryEvidence({
      historyId: "history-a",
      jobId: "job-old",
      evaluatedAt: "2026-09-03T10:30:00Z",
      outcome: "sent",
      deliveryStatus: "delivered",
    }, 0);
    const base = {
      ...simpleSource(scope, evidence),
      kind: "directive" as const,
      directiveId: "job-old",
      declaredPhase: "implementation",
      currentPhase: "delivery",
      declaredRigor: null,
      currentRigor: null,
      conflictSourceAddress: "mission:release-0.5.10#stage",
    };
    expect(evaluateHealthDetectors([base]).map((record) => record.detector))
      .toEqual(["governance.stale-directive"]);
    expect(evaluateHealthDetectors([{ ...base, currentPhase: "implementation" }])).toEqual([]);
    expect(evaluateHealthDetectors([{ ...base, conflictSourceAddress: null }])).toEqual([]);
  });

  it("emits scope-admission drift only when an active mission declares an available rule", () => {
    const subject = corpus.cases.scopeAdmissionCandidate;
    const work = adaptWorkGraphEvidence({
      sourceOrder: 0,
      observedAt: subject.technicalReview.reviewedAt,
      nodeType: "slice",
      nodeId: "OPR.0.5.9.13",
      missionId: "release-0.5.9",
      stage: "wip",
    });
    const base = {
      ...simpleSource(subject.scope, work, "2026-09-04T03:00:00Z", "2026-09-04T04:00:00Z"),
      kind: "scope-admission" as const,
      sliceId: "OPR.0.5.9.13",
      missionActive: true,
      buildable: true,
      requiredAuthority: "founder",
      admissionAuthority: null,
      admissionState: "missing" as const,
      authoritySourceAddress: "mission:release-0.5.9#admission",
    };
    expect(evaluateHealthDetectors([base]).map((record) => record.detector))
      .toEqual(["governance.scope-admission-drift"]);
    expect(evaluateHealthDetectors([{ ...base, requiredAuthority: null }])).toEqual([]);
    expect(evaluateHealthDetectors([{ ...base, admissionState: "unavailable" }])).toEqual([]);
    expect(evaluateHealthDetectors([{ ...base, missionActive: false }])).toEqual([]);
  });

  it("reports fresh pressure, a natural clear, and stale pressure honestly", () => {
    const scope = { type: "seat", rigId: "rig-a", seatId: "seat-a" } as const;
    const freshPressure = adaptContextUsageEvidence("seat-a", {
      availability: "known", reason: null, source: "codex_token_count_jsonl",
      usedPercentage: 96, remainingPercentage: 4, contextWindowSize: 250_000,
      totalInputTokens: 205_000, totalOutputTokens: 5_000, currentUsage: null,
      transcriptPath: null, sessionId: "session-a", sessionName: "seat-a@rig-a",
      sampledAt: "2026-09-03T10:30:00Z", fresh: true,
    }, 0);
    const base = {
      ...simpleSource(scope, freshPressure),
      kind: "context-pressure" as const,
      sourceName: "codex_token_count_jsonl",
      continuity: "resumed",
      warningPercent: 95,
      criticalPercent: 99,
    };
    const active = evaluateHealthDetectors([base]);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ detector: "context.pressure", status: "active", category: "context" });
    expect(active[0]).toMatchObject({ severity: "warning" });
    expect(active[0]?.threshold).toContain("95%");
    expect(active[0]?.threshold).toContain("99%");
    expect(active[0]?.explanation).toContain("96%");
    expect(active[0]?.explanation).toContain("continuity is resumed");

    const criticalEvidence = adaptContextUsageEvidence("seat-a", {
      availability: "known", reason: null, source: "codex_token_count_jsonl",
      usedPercentage: 99, remainingPercentage: 1, contextWindowSize: 250_000,
      totalInputTokens: 240_000, totalOutputTokens: 5_000, currentUsage: null,
      transcriptPath: null, sessionId: "session-a", sessionName: "seat-a@rig-a",
      sampledAt: "2026-09-03T10:40:00Z", fresh: true,
    }, 1);
    const criticalSource = boundedSource({
      evidence: [freshPressure, criticalEvidence],
      startedAt: "2026-09-03T10:00:00Z",
      endedAt: "2026-09-03T11:00:00Z",
    });
    const critical = evaluateHealthDetectors([{
      ...base,
      source: criticalSource,
      lastObservedAt: "2026-09-03T10:40:00Z",
    }])[0]!;
    expect(critical).toMatchObject({ id: active[0]!.id, status: "active", severity: "critical" });

    const clearedEvidence = adaptContextUsageEvidence("seat-a", {
      availability: "known", reason: null, source: "codex_token_count_jsonl",
      usedPercentage: 30, remainingPercentage: 70, contextWindowSize: 250_000,
      totalInputTokens: 70_000, totalOutputTokens: 5_000, currentUsage: null,
      transcriptPath: null, sessionId: "session-a", sessionName: "seat-a@rig-a",
      sampledAt: "2026-09-03T10:50:00Z", fresh: true,
    }, 2);
    const clearSource = boundedSource({
      evidence: [freshPressure, criticalEvidence, clearedEvidence],
      startedAt: "2026-09-03T10:00:00Z",
      endedAt: "2026-09-03T11:00:00Z",
    });
    expect(evaluateHealthDetectors([{ ...base, source: clearSource, lastObservedAt: "2026-09-03T10:50:00Z" }])[0])
      .toMatchObject({ detector: "context.pressure", status: "cleared" });

    const laterPressure = adaptContextUsageEvidence("seat-a", {
      availability: "known", reason: null, source: "codex_token_count_jsonl",
      usedPercentage: 96, remainingPercentage: 4, contextWindowSize: 250_000,
      totalInputTokens: 220_000, totalOutputTokens: 5_000, currentUsage: null,
      transcriptPath: null, sessionId: "session-a", sessionName: "seat-a@rig-a",
      sampledAt: "2026-09-03T10:55:00Z", fresh: true,
    }, 3);
    const restartedSource = boundedSource({
      evidence: [freshPressure, criticalEvidence, clearedEvidence, laterPressure],
      startedAt: "2026-09-03T10:00:00Z",
      endedAt: "2026-09-03T11:00:00Z",
    });
    const restarted = evaluateHealthDetectors([{
      ...base,
      source: restartedSource,
      lastObservedAt: "2026-09-03T10:55:00Z",
    }])[0]!;
    expect(restarted).toMatchObject({ status: "active", startedAt: "2026-09-03T10:55:00Z" });
    expect(restarted).toMatchObject({ severity: "warning" });
    expect(restarted.id).not.toBe(active[0]!.id);

    const staleSource = boundedSource({
      evidence: [freshPressure],
      startedAt: "2026-09-03T10:00:00Z",
      endedAt: "2026-09-03T11:00:00Z",
      fresh: false,
    });
    expect(evaluateHealthDetectors([{ ...base, source: staleSource }])[0])
      .toMatchObject({ detector: "context.pressure", status: "indeterminate" });
  });

  it("keeps the replay's ordinary productive, rescue, stale, and unavailable controls non-active", () => {
    const controls = new Map(corpus.cases.ordinaryControls.map((item) => [item.id, item]));
    const mission = { type: "mission", projectId: "openrig", missionId: "ordinary-controls" } as const;
    const seat = { type: "seat", rigId: "rig-a", seatId: "seat-a" } as const;
    const queue = controls.get("single-proportional-review")!;
    const queueEvidenceItems = queue.events.map((event) => queueEvidence({
      sourceOrder: event.sourceOrder,
      transitionId: event.sourceOrder + 1,
      observedAt: event.observedAt!,
      state: event.state,
    }));
    const queueSource = boundedSource({
      evidence: queueEvidenceItems,
      startedAt: queue.events[0]!.observedAt!,
      endedAt: queue.events.at(-1)!.observedAt!,
    });
    const productive = controls.get("productive-volume")!;
    const productiveEvidence = productive.events.map((event) => adaptWorkGraphEvidence({
      sourceOrder: event.sourceOrder,
      observedAt: event.observedAt!,
      nodeType: "mission",
      nodeId: "ordinary-controls",
      missionId: "ordinary-controls",
      stage: event.candidate!,
    }));
    const productiveSource = boundedSource({
      evidence: productiveEvidence,
      startedAt: productive.events[0]!.observedAt!,
      endedAt: productive.events.at(-1)!.observedAt!,
    });
    const recovery = controls.get("one-recovery-wake")!;
    const wakeEvidence = adaptWatchdogHistoryEvidence({
      historyId: "ordinary-wake",
      jobId: "ordinary-wake",
      evaluatedAt: recovery.events[0]!.observedAt!,
      outcome: "sent",
      deliveryStatus: "delivered",
    }, 0);
    const wakeSource = boundedSource({
      evidence: [wakeEvidence],
      startedAt: recovery.events[0]!.observedAt!,
      endedAt: recovery.events.at(-1)!.observedAt!,
    });
    const stale = controls.get("stale-context")!.events[0]!;
    const staleEvidence = adaptContextUsageEvidence("seat-a", {
      availability: "known", reason: null, source: "codex_token_count_jsonl",
      usedPercentage: stale.usedPercentage!, remainingPercentage: 18, contextWindowSize: 250_000,
      totalInputTokens: null, totalOutputTokens: null, currentUsage: null, transcriptPath: null,
      sessionId: "session-a", sessionName: "seat-a@rig-a", sampledAt: stale.observedAt, fresh: false,
    }, 0);
    const staleSource = boundedSource({
      evidence: [staleEvidence],
      startedAt: "2026-08-01T09:00:00Z",
      endedAt: "2026-08-01T11:00:00Z",
      fresh: false,
    });

    const records = evaluateHealthDetectors([
      {
        kind: "coordination-lineage", scope: mission,
        episodeStartedAt: queue.events[0]!.observedAt!, lastObservedAt: queue.events.at(-1)!.observedAt!,
        source: queueSource, lineageId: "ordinary-review", coordinationTransitions: queue.events.length,
        productStateChanges: 1, boundedAuthority: false, reviewReturns: 1, candidateChanges: 1, newRiskClasses: 0,
      },
      {
        kind: "coordination-lineage", scope: mission,
        episodeStartedAt: productive.events[0]!.observedAt!, lastObservedAt: productive.events.at(-1)!.observedAt!,
        source: productiveSource, lineageId: "productive-volume", coordinationTransitions: productive.events.length,
        productStateChanges: new Set(productive.events.map((event) => event.candidate)).size,
        boundedAuthority: false, reviewReturns: 0, candidateChanges: 2, newRiskClasses: 0,
      },
      {
        kind: "wake-lineage", scope: mission,
        episodeStartedAt: recovery.events[0]!.observedAt!, lastObservedAt: recovery.events.at(-1)!.observedAt!,
        source: wakeSource, lineageId: "ordinary-wake", wakeCount: 1, rescueWakeCount: 1, existingNextAction: true,
      },
      {
        kind: "context-pressure", scope: seat,
        episodeStartedAt: stale.observedAt!, lastObservedAt: stale.observedAt!, source: staleSource,
        sourceName: "codex_token_count_jsonl", continuity: "unavailable",
      },
    ]);
    expect(records.filter((record) => record.status === "active")).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ detector: "context.pressure", status: "indeterminate" });

    const unavailable = controls.get("unavailable-context")!.events[0]!;
    const unavailableEvidence = adaptContextUsageEvidence("seat-a", {
      availability: "unknown", reason: "no_data", source: null,
      usedPercentage: null, remainingPercentage: null, contextWindowSize: null,
      totalInputTokens: null, totalOutputTokens: null, currentUsage: null, transcriptPath: null,
      sessionId: null, sessionName: null, sampledAt: unavailable.observedAt, fresh: false,
    }, 0);
    const unavailableSource = boundedSource({
      evidence: [unavailableEvidence],
      startedAt: "2026-08-01T09:00:00Z",
      endedAt: "2026-08-01T11:00:00Z",
    });
    expect(evaluateHealthDetectors([{
      kind: "context-pressure", scope: seat,
      episodeStartedAt: "2026-08-01T09:00:00Z", lastObservedAt: "2026-08-01T11:00:00Z",
      source: unavailableSource, sourceName: null, continuity: "unavailable",
    }])).toEqual([]);
  });

  it("deduplicates one continuing episode and returns deterministic bytes across input order", () => {
    const observations = staleConductorObservations();
    const refreshed = {
      ...observations[0]!,
      lastObservedAt: "2026-09-04T04:51:31.138Z",
    };
    const first = evaluateHealthDetectors([...observations, refreshed]);
    const second = evaluateHealthDetectors([refreshed, ...observations].reverse());
    expect(first).toHaveLength(3);
    expect(first.map((record) => record.id)).toEqual(second.map((record) => record.id));
    expect(canonicalDetectorJson(first)).toBe(canonicalDetectorJson(second));
  });
});

describe("daemon health projection route", () => {
  it("exposes bounded list/detail reads from live context telemetry and no write verb", async () => {
    const db = createFullTestDb();
    try {
      db.exec(usageSamplesSchema.sql);
      const setup = createTestApp(db);
      const rig = setup.rigRepo.createRig("health-route-rig");
      const node = setup.rigRepo.addNode(rig.id, "worker", { role: "worker" });
      const session = setup.sessionRegistry.registerSession(node.id, "worker@health-route-rig");
      setup.sessionRegistry.updateStatus(session.id, "running");
      const baseMs = Date.now() - 60_000;
      const sampleAt = (offsetSeconds: number) => new Date(baseMs + offsetSeconds * 1000).toISOString();
      db.prepare("UPDATE occupant_tenures SET boot_at = ? WHERE node_id = ?")
        .run(sampleAt(-10), node.id);
      const samples = new UsageSamplesStore(db);
      const writeUsage = (usedPercentage: number, offsetSeconds: number) => {
        const sampledAt = sampleAt(offsetSeconds);
        db.prepare(`INSERT INTO context_usage (
          node_id, session_id, session_name, availability, reason, source,
          used_percentage, remaining_percentage, context_window_size,
          total_input_tokens, total_output_tokens, current_usage,
          transcript_path, sampled_at, updated_at
        ) VALUES (?, ?, ?, 'known', NULL, 'codex_token_count_jsonl', ?, ?, 250000,
          205000, 5000, NULL, NULL, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          used_percentage = excluded.used_percentage,
          remaining_percentage = excluded.remaining_percentage,
          sampled_at = excluded.sampled_at,
          updated_at = excluded.updated_at`)
          .run(node.id, session.id, session.sessionName, usedPercentage, 100 - usedPercentage, sampledAt, sampledAt);
        samples.appendContextSample({
          nodeId: node.id,
          seatSession: session.sessionName,
          source: "codex_token_count_jsonl",
          sampledAt,
          totalInputTokens: 205000,
          totalOutputTokens: 5000,
          usedPercentage,
        }, sampledAt);
      };
      samples.appendContextSample({
        nodeId: node.id,
        seatSession: session.sessionName,
        source: "codex_token_count_jsonl",
        sampledAt: sampleAt(-20),
        totalInputTokens: 200000,
        totalOutputTokens: 5000,
        usedPercentage: 99,
      }, sampleAt(-20));
      writeUsage(96, 0);

      const list = await setup.app.request(`/api/health?scope_type=seat&scope_id=${node.id}&limit=1`);
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        schema: string;
        total: number;
        limit: number;
        truncated: boolean;
        records: Array<{
          id: string;
          detector: string;
          scope: HealthScope;
          status: string;
          severity: string;
          startedAt: string;
        }>;
      };
      expect(body).toMatchObject({
        schema: "openrig.health-list/v0alpha1",
        total: 1,
        limit: 1,
        truncated: false,
      });
      expect(body.records[0]).toMatchObject({
        detector: "context.pressure",
        scope: { type: "seat", seatId: node.id },
        status: "active",
        severity: "warning",
        startedAt: sampleAt(0),
      });

      const first = body.records[0]!;
      writeUsage(97, 10);
      const continuing = (await (await setup.app.request(
        `/api/health?scope_type=seat&scope_id=${node.id}`,
      )).json()) as typeof body;
      expect(continuing.records[0]).toMatchObject({
        id: first.id,
        startedAt: first.startedAt,
        status: "active",
        severity: "warning",
      });

      writeUsage(99, 20);
      const critical = (await (await setup.app.request(
        `/api/health?scope_type=seat&scope_id=${node.id}`,
      )).json()) as typeof body;
      expect(critical.records[0]).toMatchObject({
        id: first.id,
        startedAt: first.startedAt,
        status: "active",
        severity: "critical",
      });

      const detail = await setup.app.request(`/api/health/${first.id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: first.id,
        detector: first.detector,
        scope: first.scope,
      });

      writeUsage(30, 30);
      const currentAfterClear = (await (await setup.app.request(
        `/api/health?scope_type=seat&scope_id=${node.id}`,
      )).json()) as typeof body;
      expect(currentAfterClear).toMatchObject({ total: 0, records: [] });

      const cleared = (await (await setup.app.request(
        `/api/health?scope_type=seat&scope_id=${node.id}&status=cleared`,
      )).json()) as typeof body;
      expect(cleared.records[0]).toMatchObject({ id: first.id, status: "cleared" });
      expect(await (await setup.app.request(`/api/health/${first.id}`)).json())
        .toMatchObject({ id: first.id, status: "cleared" });

      writeUsage(96, 40);
      const restarted = (await (await setup.app.request(
        `/api/health?scope_type=seat&scope_id=${node.id}`,
      )).json()) as typeof body;
      expect(restarted.records[0]).toMatchObject({ status: "active", severity: "warning" });
      expect(restarted.records[0]!.id).not.toBe(first.id);
      expect((await setup.app.request("/api/health/missing")).status).toBe(404);
      expect((await setup.app.request("/api/health", { method: "POST" })).status).toBe(404);
      expect((await setup.app.request("/api/health?limit=0")).status).toBe(400);
      expect((await setup.app.request("/api/health?limit=201")).status).toBe(400);
      expect((await setup.app.request("/api/health?scope_type=seat")).status).toBe(400);
    } finally {
      db.close();
    }
  });

  it("evaluates its source once per list or detail request", () => {
    let reads = 0;
    const service = new HealthProjectionService({
      read: () => {
        reads += 1;
        return staleConductorObservations();
      },
    });
    const listed = service.list({ limit: 2 });
    expect(reads).toBe(1);
    expect(listed.records).toHaveLength(2);
    expect(listed).toMatchObject({ total: 3, limit: 2, truncated: true });
    service.get(listed.records[0]!.id);
    expect(reads).toBe(2);
  });
});
