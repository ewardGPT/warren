import type Database from "better-sqlite3";
import type { WorkflowStepSpec } from "./workflow-types.js";

export interface LifecycleObligation {
  stepId: string;
  required: boolean;
  state: string;
  receiptState: "recorded" | "missing" | "not-required";
  receipt: { evidenceRef: string; actorSession: string; closedAt: string } | null;
}

export function requiredLifecycleSteps(binding: Record<string, unknown> | null): string[] {
  const graph = binding?.graphSource as { requiredSteps?: unknown } | undefined;
  return Array.isArray(graph?.requiredSteps)
    ? graph.requiredSteps.filter((id): id is string => typeof id === "string") : [];
}

/** One projection for workflow show and the execution view. Queue terminal state
 * never stands in for an agent's successful workflow closure and receipt. */
export function lifecycleObligations(
  db: Database.Database, instanceId: string, binding: Record<string, unknown> | null,
  steps: Pick<WorkflowStepSpec, "id">[], frontier: string[],
): LifecycleObligation[] {
  const graph = binding?.graphSource as { requiredSteps?: unknown } | undefined;
  if (!Array.isArray(graph?.requiredSteps)) return [];
  const required = requiredLifecycleSteps(binding);
  const trails = db.prepare(`SELECT step_id, closure_reason, closure_evidence_json, actor_session, closed_at
    FROM workflow_step_trails WHERE instance_id = ? ORDER BY closed_at, trail_id`).all(instanceId) as Array<{
      step_id: string; closure_reason: string; closure_evidence_json: string | null; actor_session: string; closed_at: string;
    }>;
  const packets = db.prepare(`SELECT b.step_id, b.packet_id, q.state FROM workflow_frontier_bindings b
    LEFT JOIN queue_items q ON q.qitem_id = b.packet_id WHERE b.instance_id = ?`).all(instanceId) as Array<{
      step_id: string; packet_id: string; state: string | null;
    }>;
  return [...new Set([...steps.map((step) => step.id), ...required])].map((stepId) => {
    const trail = trails.filter((item) => item.step_id === stepId).at(-1);
    let evidenceRef: unknown;
    try { evidenceRef = JSON.parse(trail?.closure_evidence_json ?? "{}")?.evidence_ref; } catch { /* missing, never accepted */ }
    const closed = trail?.closure_reason === "done" || trail?.closure_reason === "handoff";
    const receipt = closed && typeof evidenceRef === "string" && evidenceRef.trim()
      ? { evidenceRef, actorSession: trail.actor_session, closedAt: trail.closed_at } : null;
    const packet = packets.find((item) => item.step_id === stepId && frontier.includes(item.packet_id));
    const state = !steps.some((step) => step.id === stepId) ? "missing-step"
      : packet ? (packet.state === "blocked" ? "waiting" : "active")
      : closed ? "closed" : trail?.closure_reason === "failed" ? "failed" : "pending";
    return { stepId, required: required.includes(stepId), state,
      receiptState: receipt ? "recorded" : required.includes(stepId) ? "missing" : "not-required", receipt };
  });
}
