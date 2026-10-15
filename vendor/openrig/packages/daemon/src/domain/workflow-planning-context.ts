import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** Agent planning is current guidance, not a second executable graph or status store. */
export function workflowPlanningContext(contextRefs: string[] | undefined, instanceId: string): string[] {
  const mission = contextRefs?.find(ref => ref.endsWith("/mission.yaml"));
  if (!mission) return [];
  const lines = [
    "Workflow plan: The plan can change. Inspect authored versus running steps with rig workflow revise " + instanceId + "; file edits alone do not adopt a revision.",
    "Workflow plan: Waves guide agent admission/review; only authored executable dependencies schedule steps. Preserve completed judgments and outstanding child custody.",
  ];
  try {
    const document = parse(readFileSync(mission, "utf8"));
    const arrangement = document?.arrangement;
    const line = (label: string, value: unknown) => {
      if (typeof value === "string" && value.trim()) lines.push("Workflow plan: " + label + ": " + value.trim().replace(/\s+/g, " "));
    };
    line("Snapshot guidance from (inspect current source before deciding)", mission);
    line("Planning posture", arrangement?.planning_posture?.rule);
    line("Integration ref", arrangement?.source?.integration_ref);
    line("Integration/merge decision", arrangement?.source?.rule);
    for (const wave of Array.isArray(arrangement?.waves) ? arrangement.waves : []) {
      const id = typeof wave?.id === "string" ? wave.id : "unnamed wave";
      line(id + " admission", wave?.admission);
      line(id + " review", wave?.review);
      line(id + " exit", wave?.exit);
    }
    line("Shared integration exit", arrangement?.integration_exit?.rule);
  } catch (error) {
    lines.push("Workflow plan: Current authored guidance unavailable: " + (error instanceof Error ? error.message : String(error)));
  }
  return lines;
}
