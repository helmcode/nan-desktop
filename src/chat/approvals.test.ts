import { describe, expect, it } from "vitest";
import type { ApprovalRequest } from "../core";
import { approvalsReducer, isOpen, placeCards, type ApprovalCardState } from "./approvals";

const req = (id: string, conversation_id = 1): ApprovalRequest => ({
  id,
  conversation_id,
  action: "delete",
  target: "/Users/ana/Proyecto/old.txt",
});

function withCard(id = "a", anchor: number | null = 2): ApprovalCardState[] {
  return approvalsReducer([], { type: "request", request: req(id), anchorIndex: anchor });
}

describe("approvalsReducer (S14)", () => {
  it("adds a pending card anchored at the current message count", () => {
    const [card] = withCard();
    expect(card).toMatchObject({ id: "a", status: "pending", anchorIndex: 2, destination: null, failed: false });
    expect(isOpen(card)).toBe(true);
  });

  it("is idempotent for a repeated request id", () => {
    const state = withCard();
    expect(approvalsReducer(state, { type: "request", request: req("a"), anchorIndex: 9 })).toBe(state);
  });

  it("keeps the move destination", () => {
    const [card] = approvalsReducer([], {
      type: "request",
      request: { ...req("m"), action: "move", destination: "/Users/ana/Proyecto/new.txt" },
      anchorIndex: 0,
    });
    expect(card.destination).toBe("/Users/ana/Proyecto/new.txt");
  });

  it("collapses to an outcome when resolved", () => {
    let state = approvalsReducer(withCard(), { type: "sending", id: "a" });
    expect(state[0].status).toBe("sending");
    expect(isOpen(state[0])).toBe(true);
    state = approvalsReducer(state, { type: "resolved", id: "a", granted: false });
    expect(state[0].status).toBe("denied");
    expect(isOpen(state[0])).toBe(false);
  });

  it("accepts a core-side resolution while still pending (allow-mode or timeout)", () => {
    const state = approvalsReducer(withCard(), { type: "resolved", id: "a", granted: true });
    expect(state[0].status).toBe("granted");
  });

  it("returns to pending with an error flag when the answer fails to send", () => {
    let state = approvalsReducer(withCard(), { type: "sending", id: "a" });
    state = approvalsReducer(state, { type: "failed", id: "a" });
    expect(state[0]).toMatchObject({ status: "pending", failed: true });
  });

  it("ignores resolutions for unknown ids", () => {
    const state = withCard();
    expect(approvalsReducer(state, { type: "resolved", id: "zzz", granted: true })).toEqual(state);
  });

  it("clears a conversation", () => {
    expect(approvalsReducer(withCard(), { type: "clearConversation", conversationId: 1 })).toEqual([]);
  });
});

describe("placeCards", () => {
  it("places cards after their anchor and the rest at the tail", () => {
    let state = withCard("a", 1);
    state = approvalsReducer(state, { type: "request", request: req("b"), anchorIndex: 1 });
    state = approvalsReducer(state, { type: "request", request: req("c"), anchorIndex: null });
    state = approvalsReducer(state, { type: "request", request: req("d"), anchorIndex: 3 });
    state = approvalsReducer(state, { type: "request", request: req("x", 2), anchorIndex: 1 });
    const placed = placeCards(state, 1, 3);
    expect(placed.after.get(1)?.map((c) => c.id)).toEqual(["a", "b"]);
    expect(placed.tail.map((c) => c.id)).toEqual(["c", "d"]);
  });

  it("places nothing without an active conversation", () => {
    const placed = placeCards(withCard(), null, 5);
    expect(placed.after.size).toBe(0);
    expect(placed.tail).toEqual([]);
  });
});
