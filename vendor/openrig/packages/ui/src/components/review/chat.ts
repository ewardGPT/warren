// Living Notes Packet 2 — the CHAT preamble (OPR.0.4.4.20 FR-4 / BR-12).
//
// CHAT is the EXISTING terminal family — the surface's only additions are the
// entry point and this ONE pre-populated text frame. The standing
// record-the-outcome preamble is a PINNED CONTRACT STRING (not per-driver
// improv): it instructs the agent to record the conversation's outcome
// durably on the referenced item, and it ends with the begins-here marker so
// the founder types immediately and his single Enter submits preamble +
// message together (no Enter frame is ever sent by the surface).

export const CHAT_PREAMBLE_SUFFIX = "user message begins here: ";

export interface ChatTarget {
  /** The owning agent's session (the real destination). */
  sessionName: string;
  /** Plain-language reference: slice and/or qitem the chat is about. */
  itemRef: string;
}

/** The pinned standing preamble. One text frame, no Enter (delta-C). */
export function buildChatPreamble(target: ChatTarget): string {
  return (
    `[review ${target.itemRef}] Standing contract: when this conversation reaches an outcome, ` +
    `record it durably against the referenced item (resolve with the decision text, an adjudication ` +
    `proof-drop, or a routed qitem back to delivery) — a conversation is not a resolution. ` +
    CHAT_PREAMBLE_SUFFIX
  );
}
