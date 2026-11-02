// S14: state of the inline approval cards shown in the chat stream.
//
// A card is created when the core asks for a decision and is anchored by
// position: it renders after the first `anchorIndex` messages of its
// conversation (the messages present when it arrived), so it stays where it
// happened even after the optimistic rows are replaced by persisted ones.
// Resolved cards collapse to a one-line outcome. The core remains the
// authority; the card only forwards the user's answer.

import type { ApprovalRequest } from "../core";

export type ApprovalStatus = "pending" | "sending" | "granted" | "denied";

export interface ApprovalCardState {
  /// The core's `approval_id`.
  id: string;
  /// Null when the core did not tie the request to a conversation.
  conversationId: number | null;
  action: string;
  /// What the card names: the command line for run_command, else the path,
  /// else the core's summary.
  target: string;
  destination: string | null;
  /// run_command working folder (shown under the command).
  cwd: string | null;
  diffPreview: string | null;
  permanent: boolean;
  /// Messages before the card; null when unknown (renders at the end).
  anchorIndex: number | null;
  status: ApprovalStatus;
  failed: boolean;
}

export type ApprovalEvent =
  | { type: "request"; request: ApprovalRequest; anchorIndex: number | null }
  | { type: "sending"; id: string }
  | { type: "resolved"; id: string; granted: boolean }
  | { type: "failed"; id: string }
  | { type: "clearConversation"; conversationId: number };

/// Card state from the core's `tools://approval-request` payload.
export function cardFromRequest(request: ApprovalRequest, anchorIndex: number | null): ApprovalCardState {
  const isCommand = request.command !== null && request.command !== undefined;
  return {
    id: request.approval_id,
    conversationId: request.conversation_id ?? null,
    action: request.action,
    target: (isCommand ? request.command : request.path) ?? request.summary,
    destination: request.dest_path ?? null,
    cwd: isCommand ? (request.path ?? null) : null,
    diffPreview: request.diff_preview ?? null,
    permanent: request.permanent === true,
    anchorIndex,
    status: "pending",
    failed: false,
  };
}

export function approvalsReducer(state: ApprovalCardState[], event: ApprovalEvent): ApprovalCardState[] {
  switch (event.type) {
    case "request": {
      if (state.some((card) => card.id === event.request.approval_id)) return state;
      return [...state, cardFromRequest(event.request, event.anchorIndex)];
    }
    case "sending":
      return state.map((card) =>
        card.id === event.id && card.status === "pending" ? { ...card, status: "sending", failed: false } : card,
      );
    case "resolved":
      return state.map((card) =>
        card.id === event.id ? { ...card, status: event.granted ? "granted" : "denied", failed: false } : card,
      );
    case "failed":
      return state.map((card) =>
        card.id === event.id && card.status === "sending" ? { ...card, status: "pending", failed: true } : card,
      );
    case "clearConversation":
      return state.filter((card) => card.conversationId !== event.conversationId);
    default:
      return state;
  }
}

export function isOpen(card: ApprovalCardState): boolean {
  return card.status === "pending" || card.status === "sending";
}

export interface PlacedCards {
  /// Cards to render after the first N messages, keyed by N (0 = before all).
  after: Map<number, ApprovalCardState[]>;
  /// Cards with no usable anchor: rendered after the last message.
  tail: ApprovalCardState[];
}

/// Where each card of one conversation goes, preserving arrival order.
export function placeCards(
  cards: ApprovalCardState[],
  conversationId: number | null,
  messageCount: number,
): PlacedCards {
  const placed: PlacedCards = { after: new Map(), tail: [] };
  if (conversationId === null) return placed;
  for (const card of cards) {
    if (card.conversationId !== conversationId) continue;
    if (card.anchorIndex === null || card.anchorIndex >= messageCount) {
      placed.tail.push(card);
      continue;
    }
    const list = placed.after.get(card.anchorIndex) ?? [];
    list.push(card);
    placed.after.set(card.anchorIndex, list);
  }
  return placed;
}
