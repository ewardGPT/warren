// OPR.0.3.2.20 — string-keyed dismissal for queue-derived attention
// cards. Parallel to useDismissedSeqs (which is event-seq keyed and
// auto-prunes by monotonic min-seq for the activity FIFO). The
// queue-derived synthetic FeedCards don't have unique event seqs
// (the synthetic ActivityEvent.seq = -1), so the existing seq-keyed
// dismissal would collide across all queue-derived cards — dismissing
// one would hide every other queue-derived attention card too.
//
// This hook keys on the stable string FeedCard.id (e.g.,
// `queue-attention-<qitemId>`), prunes by membership in the current
// id set (when the qitem closes the card disappears, the dismissal
// is dropped), and persists in a distinct localStorage namespace
// so event-seq dismissals are untouched.

import { useCallback, useEffect, useMemo, useState } from "react";

export const DISMISSED_CARD_IDS_STORAGE_KEY = "forYou.dismissedCardIds";

function readDismissedFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_CARD_IDS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const strings = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
    return new Set(strings);
  } catch {
    return new Set();
  }
}

function writeDismissedToStorage(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_CARD_IDS_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // localStorage may be unavailable; swallow.
  }
}

export interface UseDismissedCardIdsResult {
  dismissedIds: Set<string>;
  dismiss(id: string): void;
  undismiss(id: string): void;
}

/**
 * @param currentIds The ids of all cards currently in the rendered
 *   set. Used to auto-prune: when a card's id is no longer present
 *   (qitem closed/handed off), the dismissal is dropped so the
 *   localStorage set doesn't grow forever.
 */
export function useDismissedCardIds(currentIds: string[]): UseDismissedCardIdsResult {
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => readDismissedFromStorage());

  const currentSet = useMemo(() => new Set(currentIds), [currentIds]);

  useEffect(() => {
    if (currentSet.size === 0) return;
    let changed = false;
    const next = new Set<string>();
    for (const id of dismissedIds) {
      if (currentSet.has(id)) {
        next.add(id);
      } else {
        changed = true;
      }
    }
    if (changed) {
      setDismissedIds(next);
      writeDismissedToStorage(next);
    }
  }, [currentSet, dismissedIds]);

  const dismiss = useCallback((id: string) => {
    setDismissedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      writeDismissedToStorage(next);
      return next;
    });
  }, []);

  const undismiss = useCallback((id: string) => {
    setDismissedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      writeDismissedToStorage(next);
      return next;
    });
  }, []);

  return { dismissedIds, dismiss, undismiss };
}
