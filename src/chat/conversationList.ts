// Sidebar list registration for in-flight conversations (round 5).
//
// The core persists a new conversation's title and first user message in
// `chat_send`, and the sidebar used to refresh only when the reply ended: a
// user who switched away mid-reply lost the new chat from the list. The
// shell now registers the conversation the moment it is sent (provisional
// title, same rule as the core) and refreshes once `chat_send` resolves.

import type { ChatMessageRow, ConversationView } from "../types";

/// Mirrors `chat::TITLE_MAX_CHARS` in the Rust core.
export const TITLE_MAX_CHARS = 48;

/// The title the core derives from a conversation's first user message
/// (`chat::title_from_first_user_message`): whitespace collapsed, truncated
/// to [`TITLE_MAX_CHARS`] characters (never splitting one).
export function titleFromFirstMessage(content: string): string {
  const collapsed = content.split(/\s+/).filter(Boolean).join(" ");
  return [...collapsed].slice(0, TITLE_MAX_CHARS).join("");
}

/// `list` with conversation `id` present: an unknown id goes first (it is the
/// most recently updated); a known one leaves the list as-is.
export function withConversation(list: ConversationView[], id: number, title: string): ConversationView[] {
  if (list.some((c) => c.id === id)) return list;
  return [{ id, title, updated_at: "", last_message: null }, ...list];
}

/// The rows to show for a conversation. While its reply is streaming, the
/// core's `in_progress` assistant row (T4b, flagged `partial`) duplicates the
/// live draft the shell renders from stream deltas, so it is hidden; once
/// the stream ends the reloaded rows are complete again.
export function rowsForDisplay(rows: ChatMessageRow[], streaming: boolean): ChatMessageRow[] {
  if (!streaming) return rows;
  return rows.filter((r) => !(r.role === "assistant" && r.partial));
}
