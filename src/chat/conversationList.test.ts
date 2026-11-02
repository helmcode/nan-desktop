import { describe, expect, it } from "vitest";
import type { ChatMessageRow, ConversationView } from "../types";
import { TITLE_MAX_CHARS, rowsForDisplay, titleFromFirstMessage, withConversation } from "./conversationList";

const conv = (id: number, title: string): ConversationView => ({ id, title, updated_at: "", last_message: null });

function row(id: number, role: string, content: string, partial = false): ChatMessageRow {
  return {
    id,
    conversation_id: 9,
    role,
    content,
    model: null,
    created_at: "",
    partial,
    media_path: null,
    sources: [],
  };
}

describe("titleFromFirstMessage (mirrors chat.rs title_from_first_user_message)", () => {
  it("collapses whitespace", () => {
    expect(titleFromFirstMessage("  plan   my\n\ttrip  ")).toBe("plan my trip");
  });

  it("truncates to the core's 48 chars without splitting a character", () => {
    expect(TITLE_MAX_CHARS).toBe(48);
    expect(titleFromFirstMessage("a".repeat(60))).toBe("a".repeat(48));
    const emoji = "😀".repeat(60);
    expect([...titleFromFirstMessage(emoji)].length).toBe(48);
  });
});

describe("withConversation", () => {
  it("puts a conversation the list does not know yet at the top", () => {
    const list = [conv(7, "Report"), conv(8, "Other")];
    const next = withConversation(list, 9, "plan my trip");
    expect(next.map((c) => c.id)).toEqual([9, 7, 8]);
    expect(next[0].title).toBe("plan my trip");
    expect(list.map((c) => c.id)).toEqual([7, 8]); // never mutates
  });

  it("leaves a known conversation untouched (same list identity)", () => {
    const list = [conv(7, "Report"), conv(9, "Real title")];
    expect(withConversation(list, 9, "provisional")).toBe(list);
  });
});

describe("rowsForDisplay", () => {
  const rows = [row(1, "user", "hola"), row(2, "assistant", "half a rep", true)];

  it("hides the in-progress assistant row while the live stream renders it", () => {
    expect(rowsForDisplay(rows, true).map((r) => r.id)).toEqual([1]);
  });

  it("keeps a partial row when nothing is streaming (crash leftover, flagged interrupted)", () => {
    expect(rowsForDisplay(rows, false)).toBe(rows);
  });
});
