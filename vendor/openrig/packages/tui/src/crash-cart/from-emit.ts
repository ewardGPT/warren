// Crash-cart C3 unit-C — map the parsed `rig crash-cart --json` verdict onto the renderScreen
// daemon-down opts. Refusals and unavailable prerequisites stay visible, without
// turning a failed discovery into permission to restore or mint an identity.
import type { DaemonState, DaemonUnverifiedEvidence } from "./contract.js";
import { buildCrashCartModel, type CrashCartDiscoveryInput, type CrashCartModel } from "./crash-cart-model.js";
import type { RestoreLifecycleVM } from "./restore-lifecycle.js";

/** The `rig crash-cart --json` payload (mirrors the daemon verb's emit — the documented JSON contract). */
export interface CrashCartEmit {
  state: DaemonState;
  evidence?: DaemonUnverifiedEvidence;
  discovery?: CrashCartDiscoveryInput;
  refusal?: string;
}

/** The daemon-down subset of RenderOptions the TUI feeds renderScreen (empty ⇒ normal fleet views). */
export interface CrashCartRenderOpts {
  unavailable?: string;
  unavailableExpanded?: boolean;
  starting?: string;
  daemonState?: DaemonState;
  crashCart?: CrashCartModel;
  daemonEvidence?: DaemonUnverifiedEvidence;
  /** B1 ROUND 2 — the live fleet-restore lifecycle surface (progress while running, rollup + triage
   *  when done). Set by main.ts as the operator-owned lifecycle polls; takes precedence over the
   *  cockpit while present, so the operator sees progress and the triage list rather than a bare refresh. */
  restore?: RestoreLifecycleVM;
  /** B1 ROUND 10 — the ⏎ confirm banner (non-zero-generation restore). Rendered IN the cockpit where the
   *  operator looks; ViewState.notice is NOT rendered in the daemon-down cockpit, so the confirm was
   *  invisible (first ⏎ appeared to do nothing). Present ⇔ pendingRestoreConfirm. */
  confirm?: string;
}

/** A refusal is an unavailable read, never an empty instance. */
export function crashCartRenderOpts(emit: CrashCartEmit): CrashCartRenderOpts {
  if (emit.refusal) return { unavailable: emit.refusal };
  if (emit.state === "down" && emit.discovery) {
    return { daemonState: "down", crashCart: buildCrashCartModel(emit.discovery) };
  }
  if (emit.state === "unverified" && emit.evidence) {
    return { daemonState: "unverified", daemonEvidence: emit.evidence };
  }
  return {};
}

/**
 * Run the public read. Failure is visible and does not authorize recovery effects.
 */
export async function probeCrashCart(runVerb: () => Promise<string>): Promise<CrashCartRenderOpts> {
  try {
    const emit = JSON.parse(await runVerb()) as CrashCartEmit;
    if (!emit || !["up", "down", "unverified"].includes(emit.state)) {
      const error = emit as unknown as { error?: { message?: string } | string };
      const detail = typeof error?.error === "string" ? error.error : error?.error?.message;
      return { unavailable: detail ?? "Crash-cart did not return a daemon verdict." };
    }
    if (emit.state === "down" && !emit.discovery && !emit.refusal) return { unavailable: "Daemon is down; its saved state could not be read." };
    if (emit.state === "unverified" && !emit.evidence) return { unavailable: "Daemon state could not be verified; probe evidence is unavailable." };
    return crashCartRenderOpts(emit);
  } catch (error) {
    return { unavailable: `Startup prerequisite unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
