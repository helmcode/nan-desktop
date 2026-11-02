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
  id: string;
  conversationId: number;
  action: string;
  target: string;
  destination: string | null;
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

export function approvalsReducer(state: ApprovalCardState[], event: ApprovalEvent): ApprovalCardState[] {
  switch (event.type) {
    case "request": {
      if (state.some((card) => card.id === event.request.id)) return state;
      return [
        ...state,
        {
          id: event.request.id,
          conversationId: event.request.conversation_id,
          action: event.request.action,
          target: event.request.target,
          destination: event.request.destination ?? null,
          anchorIndex: event.anchorIndex,
          status: "pending",
          failed: false,
        },
      ];
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
