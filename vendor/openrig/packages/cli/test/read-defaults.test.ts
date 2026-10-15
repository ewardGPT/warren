import { afterEach, describe, expect, it, vi } from "vitest";
import { queueCommand, type QueueDeps } from "../src/commands/queue.js";
import { healthCommand, type HealthDeps } from "../src/commands/health.js";

vi.mock("../src/daemon-lifecycle.js", async () => ({
  ...await vi.importActual("../src/daemon-lifecycle.js"),
  getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, port: 7433 })),
  getDaemonUrl: vi.fn(() => "http://fixture"),
}));

const diagnosis = (large: boolean) => {
  const content = large ? "retained authority\n".repeat(10_000) : "small authority";
  const authority = [{ path: "SPEC.md", state: "available", sha256: "bound-hash", content }];
  const finding = { id: "finding-1", status: "indeterminate", detector: "ceremony", summary: "Outcome unknown",
    policyVersion: "policy-1", explanation: "Needs a decision", indeterminateReason: "missing outcome",
    evidence: [{ type: "queue-transition", context: content }],
    ceremony: { basis: "basis-1", stage: "needs-diagnosis", missingFacts: ["outcome"],
      workflowReceipts: [{ candidate: "candidate-sha", evidence: { cutSha: "exact-cut", verdict: "PASS", fullScan: { content } } }] } };
  return {
    row: { qitemId: "q-1", state: "blocked", destinationSession: "owner@rig", blockedOn: "decision-1", summary: "Outcome unknown", body: content },
    packet: { schema: "diagnosis", presentedAt: "2026-09-07T00:00:00Z", instructions: "Read full context", finding, authority },
    finding, authority, receipts: [{ action: "presented", finding, authority }],
    disposition: { verdict: "insufficient evidence", causalStart: null, steering: "Inspect outcome", uncertainty: "missing outcome", evidenceRefs: ["proof.md"] },
    notificationReadiness: { ready: false, reason: "route unavailable" }, humanDelivery: null,
  };
};

async function run(kind: "queue" | "health", args: string[], data: unknown, status = 200) {
  const logs: string[] = [], errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...v) => { logs.push(v.join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...v) => { errors.push(v.join(" ")); });
  const get = vi.fn(async () => ({ status, data }));
  const deps = { lifecycleDeps: {}, clientFactory: () => ({ get, post: get }), resolveIdentity: () => null };
  const command = kind === "queue" ? queueCommand(deps as unknown as QueueDeps) : healthCommand(deps as unknown as HealthDeps);
  command.exitOverride();
  await command.parseAsync(["node", "rig", ...args]);
  return { logs, errors, get };
}
afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

describe("deliberate full reads", () => {
  it.each([false, true])("diagnosis default preserves decisions and names omitted evidence (large=%s)", async (large) => {
    const original = diagnosis(large), before = JSON.stringify(original);
    const { logs } = await run("health", ["diagnosis", "show", "q-1", "--json"], original);
    const value = JSON.parse(logs.join("\n"));
    expect(value.row).toMatchObject({ state: "blocked", destinationSession: "owner@rig", blockedOn: "decision-1" });
    expect(value.disposition).toEqual(original.disposition);
    expect(value.notificationReadiness).toEqual(original.notificationReadiness);
    expect(value.finding.ceremony).toMatchObject({ basis: "basis-1", missingFacts: ["outcome"] });
    expect(value.finding.ceremony.workflowReceipts[0]).toMatchObject({ candidate: "candidate-sha", evidenceIdentity: { cutSha: "exact-cut", verdict: "PASS" } });
    expect(value.finding.ceremony.workflowReceipts[0]).not.toHaveProperty("evidence");
    expect(value.authority).toEqual([{ path: "SPEC.md", state: "available", sha256: "bound-hash" }]);
    expect(value).not.toHaveProperty("receipts");
    expect(value.row).not.toHaveProperty("body");
    expect(value.readView).toMatchObject({ complete: false, fullJsonBytes: Buffer.byteLength(before), fullCommand: "rig health diagnosis show 'q-1' --full --json" });
    expect(value.readView.omittedFields).toContainEqual(expect.objectContaining({ path: "receipts", items: 1 }));
    if (large) expect(Buffer.byteLength(logs[0]!)).toBeLessThan(5_000);
    expect(JSON.stringify(original)).toBe(before);
  });

  it.each([["--full", "--json"], ["--full"]])("explicit diagnosis full is lossless: %s", async (...flags) => {
    const original = diagnosis(true);
    const { logs } = await run("health", ["diagnosis", "show", "q-1", ...flags], original);
    expect(JSON.parse(logs.join("\n"))).toEqual(original);
    if (flags.includes("--json")) expect(logs).toEqual([JSON.stringify(original)]);
  });

  it("diagnosis list keeps its array shape; each occurrence teaches its own expansion", async () => {
    const original = [diagnosis(true)];
    const { logs } = await run("health", ["diagnosis", "list", "--json"], original);
    expect(JSON.parse(logs[0]!)).toHaveLength(1);
    expect(JSON.parse(logs[0]!)[0].readView.fullCommand).toContain("show 'q-1' --full --json");
    const full = await run("health", ["diagnosis", "list", "--full", "--json"], original);
    expect(JSON.parse(full.logs[0]!)).toEqual(original);
  });

  it("parent --json remains a summary unless the occurrence read explicitly selects --full", async () => {
    const original = diagnosis(false);
    const summary = await run("health", ["--json", "diagnosis", "show", "q-1"], original);
    expect(JSON.parse(summary.logs[0]!).readView.complete).toBe(false);
    const full = await run("health", ["--json", "diagnosis", "show", "q-1", "--full"], original);
    expect(full.logs).toEqual([JSON.stringify(original)]);
  });

  it("human diagnosis shows an exact expansion and its cost", async () => {
    const { logs } = await run("health", ["diagnosis", "show", "q-1"], diagnosis(true));
    expect(logs.join("\n")).toContain("rig health diagnosis show 'q-1' --full --json");
    expect(logs.join("\n")).toContain("JSON bytes");
    expect(logs.join("\n")).toContain("blocked");
    expect(logs.join("\n")).toContain("decision-1");
  });

  it("keeps attributed correction and unobserved effect visible without expanding source bodies", async () => {
    const original = { ...diagnosis(true), guidance: "Current correction guidance", assessment: { actor: "owner@rig", at: "2026-09-10T00:00:00Z", transitionId: 42 }, behavioralEffect: "unobserved" };
    const correction = { applicability: "Emergency premise retired; publication still applies", causalJudgment: "Owner assessment of retained trace", action: { state: "taken", summary: "Retired reservation", evidenceRefs: ["action.md"] }, effect: { state: "unobserved", summary: "No natural opportunity", evidenceRefs: [] } };
    const data = { ...original, disposition: { ...original.disposition, correction } };
    const json = JSON.parse((await run("health", ["diagnosis", "show", "q-1", "--json"], data)).logs[0]!);
    expect(json.disposition.correction).toEqual(correction);
    expect(json.assessment).toEqual(original.assessment);
    expect(json.behavioralEffect).toBe("unobserved");
    expect(json).not.toHaveProperty("guidance");
    expect(json.readView.omittedFields).toContainEqual(expect.objectContaining({ path: "guidance" }));
    const text = (await run("health", ["diagnosis", "show", "q-1"], data)).logs.join("\n");
    expect(text).toContain("Action (taken): Retired reservation");
    expect(text).toContain("Later behavioral effect (owner report): unobserved");
    expect(text).toContain("Attributed assessment: owner@rig");
  });

  it.each(["", "😀".repeat(900)])("queue retains existing body semantics and adds exact full discovery", async (body) => {
    const original = { qitemId: "q-1", body, state: "blocked", blockedOn: "decision-1", summary: "Needs a decision" };
    const { logs } = await run("queue", ["show", "q-1", "--json"], original);
    const value = JSON.parse(logs[0]!);
    expect(value.bodyBytes).toBe(Buffer.byteLength(body));
    expect(value.blockedOn).toBe("decision-1");
    expect(value.readView).toMatchObject({ complete: body.length === 0, fullJsonBytes: Buffer.byteLength(JSON.stringify(original)), fullCommand: "rig queue show 'q-1' --full --json" });
    const full = await run("queue", ["show", "q-1", "--full", "--json"], original);
    expect(full.logs).toEqual([JSON.stringify(original)]);
  });

  it("empty lists and errors are never converted into partial successes", async () => {
    expect((await run("health", ["diagnosis", "list", "--json"], [])).logs).toEqual(["[]"]);
    const error = { error: "health_diagnosis_not_found", message: "Unknown occurrence" };
    const response = await run("health", ["diagnosis", "show", "absent", "--json"], error, 400);
    expect(JSON.parse(response.errors[0]!)).toEqual(error);
    expect(response.logs).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("intentional disposition writes keep their full JSON response", async () => {
    // The read defaults must not rewrite another operation's result shape.
    const original = diagnosis(true);
    const { logs } = await run("health", ["diagnosis", "notify", "q-1", "--json"], original);
    expect(logs).toEqual([JSON.stringify(original)]);
  });

  it("queue errors retain their original JSON and failing exit", async () => {
    const response = await run("queue", ["show", "absent", "--json"], { error: "not_found" }, 404);
    expect(JSON.parse(response.logs[0]!)).toEqual({ error: "not_found" });
    expect(process.exitCode).toBe(1);
  });
});
