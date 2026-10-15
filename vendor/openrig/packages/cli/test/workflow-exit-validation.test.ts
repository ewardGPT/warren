// release-0.3.2 slice 01 BC repair — HG-6 discriminators for the
// workflow project --exit enum. Without runtime validation, the
// TypeScript-only enum allowed `--exit banana` to flow through to
// the daemon transactional-scribe surface.

import { describe, expect, it, vi } from "vitest";
import {
  workflowCommand,
  isProjectExitKind,
  PROJECT_EXIT_KINDS,
  type WorkflowDeps,
} from "../src/commands/workflow.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function captureStderr(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  return { logs, restore: () => { process.stderr.write = original; } };
}

function fakeRunningDeps(post: ReturnType<typeof vi.fn>): WorkflowDeps {
  return {
    lifecycleDeps: {} as LifecycleDeps,
    clientFactory: () => ({
      post,
      get: vi.fn(),
      postText: vi.fn(),
    }) as unknown as ReturnType<WorkflowDeps["clientFactory"]>,
  };
}

describe("isProjectExitKind — pure helper", () => {
  it("accepts every documented exit kind", () => {
    for (const kind of PROJECT_EXIT_KINDS) {
      expect(isProjectExitKind(kind)).toBe(true);
    }
  });
  it("rejects garbage strings (BC-2 root cause)", () => {
    expect(isProjectExitKind("banana")).toBe(false);
    expect(isProjectExitKind("")).toBe(false);
    expect(isProjectExitKind("HANDOFF")).toBe(false); // case-sensitive
  });
  it("rejects non-strings", () => {
    expect(isProjectExitKind(undefined)).toBe(false);
    expect(isProjectExitKind(null)).toBe(false);
    expect(isProjectExitKind(42)).toBe(false);
  });
});

describe("rig workflow project --exit — CLI-side discriminator (BLOCK 2)", () => {
  it("rejects '--exit banana' with --json: exit=1, body.error 3-part, client.post NOT called", async () => {
    const post = vi.fn();
    const deps = fakeRunningDeps(post);
    const out = captureStdout();
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    const root = workflowCommand(deps);
    await root.parseAsync([
      "node", "rig", "project",
      "--instance", "WF1",
      "--current-packet", "q1",
      "--exit", "banana",
      "--actor-session", "x@y",
      "--json",
    ]);
    out.restore();
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    expect(exitCode).toBe(1);
    expect(post).not.toHaveBeenCalled();
    const joined = out.logs.join("\n");
    const parsed = JSON.parse(joined);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.fact).toMatch(/--exit must be one of handoff \| waiting \| done \| failed.*banana/);
    expect(parsed.error.consequence).toMatch(/did not run/);
    expect(parsed.error.action).toMatch(/--exit handoff/);
  });

  it("emits 3-part error to stderr in human mode", async () => {
    const post = vi.fn();
    const deps = fakeRunningDeps(post);
    const err = captureStderr();
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    const root = workflowCommand(deps);
    await root.parseAsync([
      "node", "rig", "project",
      "--instance", "WF1",
      "--current-packet", "q1",
      "--exit", "banana",
      "--actor-session", "x@y",
    ]);
    err.restore();
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    expect(exitCode).toBe(1);
    expect(post).not.toHaveBeenCalled();
    const joined = err.logs.join("");
    expect(joined).toMatch(/Error:.*--exit must be one of/);
    expect(joined).toMatch(/banana/);
    expect(joined).toMatch(/did not run/);
  });

  it("rejects each garbage variant ('', 'HANDOFF', 'shipped') without calling the daemon", async () => {
    for (const bad of ["", "HANDOFF", "shipped"]) {
      const post = vi.fn();
      const deps = fakeRunningDeps(post);
      const out = captureStdout();
      const originalExitCode = process.exitCode;
      process.exitCode = 0;
      const root = workflowCommand(deps);
      await root.parseAsync([
        "node", "rig", "project",
        "--instance", "WF1",
        "--current-packet", "q1",
        "--exit", bad,
        "--actor-session", "x@y",
        "--json",
      ]);
      out.restore();
      const exitCode = process.exitCode;
      process.exitCode = originalExitCode;
      expect(exitCode, `--exit "${bad}" should fail`).toBe(1);
      expect(post, `--exit "${bad}" must not call the daemon`).not.toHaveBeenCalled();
    }
  });

  // Positive-path validation (e.g. --exit handoff forwards correctly)
  // is covered by isProjectExitKind pure-helper above; the live action
  // path is gated by getDaemonStatus and tested at the integration
  // tier, mirroring the slice-01 workflow-ux test pattern.
});
