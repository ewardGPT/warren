// OPR.0.4.1.27 — Option-B level control.
//
// The founder-approved control reframes the 5 feed.subscriptions toggles as ONE
// plain-language level (segmented: "All activity / Highlights / Needs you").
// It is a CONTROL-PRESENTATION over the existing toggle model — NO model change.
//
// action_required is FORCED ON (the floor; see useFeedSubscriptions) and is NOT
// part of any level preset. A level reframes only the 4 toggleable kinds. The
// underlying 5 independent toggles are preserved (advanced view); a toggle combo
// that matches no preset derives "custom".
import type { FeedSubscriptionState } from "../hooks/useFeedSubscriptions.js";

export type FeedLevel = "needs-you" | "highlights" | "all-activity";
export type DerivedLevel = FeedLevel | "custom";

// Ordered from the tightest (action items only) to the broadest (everything).
export const FEED_LEVELS: readonly FeedLevel[] = [
  "needs-you",
  "highlights",
  "all-activity",
] as const;

// The 4 toggleable kinds (action_required is floored ON, never here).
export type LevelToggles = Pick<
  FeedSubscriptionState,
  "approvals" | "shipped" | "progress" | "auditLog"
>;

const PRESETS: Record<FeedLevel, LevelToggles> = {
  // Just what needs you — action items only.
  "needs-you": { approvals: false, shipped: false, progress: false, auditLog: false },
  // Highlights (default) — + approvals + shipped + progress; audit noise hidden.
  "highlights": { approvals: true, shipped: true, progress: true, auditLog: false },
  // All activity — everything, incl. audit-log (observation).
  "all-activity": { approvals: true, shipped: true, progress: true, auditLog: true },
};

/** The toggle-state-set for a named level (action_required excluded — it is floored on). */
export function levelToToggles(level: FeedLevel): LevelToggles {
  return { ...PRESETS[level] };
}

/** Inverse: which named level (if any) the current toggle state matches; else "custom". */
export function deriveLevel(state: FeedSubscriptionState): DerivedLevel {
  for (const level of FEED_LEVELS) {
    const p = PRESETS[level];
    if (
      state.approvals === p.approvals &&
      state.shipped === p.shipped &&
      state.progress === p.progress &&
      state.auditLog === p.auditLog
    ) {
      return level;
    }
  }
  return "custom";
}

/** Human-readable level labels for the Option-B segmented control. */
export const FEED_LEVEL_LABELS: Record<FeedLevel, string> = {
  "all-activity": "All activity",
  "highlights": "Highlights",
  "needs-you": "Needs you",
};
