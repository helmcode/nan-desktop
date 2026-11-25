// Composer queue: the user can keep typing while a reply runs. Sending then
// adds the message to a queue of THAT conversation instead of sending it.
//
// Semantics (see docs/ARCHITECTURE.md, "Composer queue"):
// - When the running turn ends, queued messages are sent in order, one per
//   turn (each waits for the previous reply), for the conversation on
//   screen. A conversation whose turn ended while another one was on screen
//   sends its queue when the user comes back to it.
// - A turn the user stopped (`user_stop`, or the Stop button even if the turn
//   ended on its own meanwhile) holds the queue as "stopped": the user stopped
//   on purpose, so nothing goes out by itself. The queue stays visible with
//   a "Send now" action.
// - A turn that failed holds it as "failed": any `chat://error` (an expired
//   session included) and an `interrupted` turn whose request was rate
//   limited (sending right away would fail the same way). The error stays on
//   screen next to the held queue.
// - Every other end (completed, tool_cap, stream_cut, length, interrupted
//   for another reason) flushes the queue, and a queued message takes
//   precedence over the automatic continuation of a cut reply (the user
//   already said what comes next).
// - Sending another message while the queue is held releases it.
// - A message that fails to go out is put back at the front, held "failed".
// - Editing a queued message takes it out of the queue; sent again, it goes
//   to the end (it is a new message).
// - Deleting a conversation drops its queue.
// - The queue lives in memory for the app session: it survives switching
//   conversations, not restarts, and is gone on sign-out / realm switch
//   (the chat shell is keyed by realm).
//
// Pure functions over an immutable map, so the rules are unit-tested here.

export interface QueuedMessage {
  /** Local id (edit / remove target); never sent anywhere. */
  id: number;
  text: string;
  /** Files attached in the composer, sent with this message. */
  attachments?: readonly PendingAttachment[];
  /** Why the core refused its files (an attach problem reason); shown on
   * the held item until the user edits it. */
  problem?: string;
  /** A video request's hidden context (the automatic check's "fix it"),
   * sent with this message for the model only. */
  videoContext?: VideoAskContext;
  /** Sent without the conversation's active skill (an app-made request). */
  skipSkill?: boolean;
  /** The app's automatic layout fix (video/layoutAutoFix.ts): its turn does
   * not renew the automatic-fix allowance the way a user message does. */
  autoFix?: boolean;
}

import type { PendingAttachment } from "./attachments";
import type { VideoAskContext } from "../video/api";

export interface ConversationQueue {
  items: readonly QueuedMessage[];
  /** Waiting for the user, and why: not sent by itself while set. */
  held: HeldReason | false;
}

export type HeldReason = "stopped" | "failed";

export type Queues = ReadonlyMap<number, ConversationQueue>;

export const EMPTY_QUEUES: Queues = new Map();

const EMPTY: ConversationQueue = { items: [], held: false };

export function queueOf(queues: Queues, conversationId: number): ConversationQueue {
  return queues.get(conversationId) ?? EMPTY;
}

function withQueue(queues: Queues, conversationId: number, queue: ConversationQueue): Queues {
  const next = new Map(queues);
  if (queue.items.length === 0) next.delete(conversationId);
  else next.set(conversationId, queue);
  return next;
}

/** Add a message at the end. Sending again means "go": it releases a held
 * queue. Blank text without attachments is ignored. */
export function enqueue(
  queues: Queues,
  conversationId: number,
  text: string,
  id: number,
  attachments: readonly PendingAttachment[] = [],
  extra: Pick<QueuedMessage, "videoContext" | "skipSkill" | "autoFix"> = {},
): Queues {
  const trimmed = text.trim();
  if (!trimmed && attachments.length === 0) return queues;
  const current = queueOf(queues, conversationId);
  const base: QueuedMessage = attachments.length > 0 ? { id, text: trimmed, attachments } : { id, text: trimmed };
  const message: QueuedMessage = { ...base, ...extra };
  return withQueue(queues, conversationId, { items: [...current.items, message], held: false });
}

/** Drop the head (it is being sent). */
export function takeQueued(queues: Queues, conversationId: number): Queues {
  const current = queueOf(queues, conversationId);
  if (current.items.length === 0) return queues;
  return withQueue(queues, conversationId, { ...current, items: current.items.slice(1) });
}

export function removeQueued(queues: Queues, conversationId: number, id: number): Queues {
  const current = queueOf(queues, conversationId);
  if (!current.items.some((m) => m.id === id)) return queues;
  return withQueue(queues, conversationId, { ...current, items: current.items.filter((m) => m.id !== id) });
}

/** A message that could not be sent goes back to the front, held, so a
 * failing send never loops. */
export function requeueFront(queues: Queues, conversationId: number, message: QueuedMessage): Queues {
  const current = queueOf(queues, conversationId);
  return withQueue(queues, conversationId, { items: [message, ...current.items], held: "failed" });
}

function setHeld(queues: Queues, conversationId: number, held: HeldReason | false): Queues {
  const current = queues.get(conversationId);
  if (!current || current.held === held) return queues;
  return withQueue(queues, conversationId, { ...current, held });
}

export function hold(queues: Queues, conversationId: number, reason: HeldReason): Queues {
  return setHeld(queues, conversationId, reason);
}

export function release(queues: Queues, conversationId: number): Queues {
  return setHeld(queues, conversationId, false);
}

/** Whether (and why) the turn end `reason` holds the queue instead of
 * sending it. */
export function heldAfter(reason: string | null | undefined, errorKind?: string | null): HeldReason | false {
  if (reason === "user_stop") return "stopped";
  if (reason === "interrupted" && errorKind === "rate_limited") return "failed";
  return false;
}

export function dropQueue(queues: Queues, conversationId: number): Queues {
  if (!queues.has(conversationId)) return queues;
  const next = new Map(queues);
  next.delete(conversationId);
  return next;
}

/** The conversation has queued messages that should go out by themselves. */
export function wantsFlush(queues: Queues, conversationId: number): boolean {
  const current = queueOf(queues, conversationId);
  return current.items.length > 0 && !current.held;
}

export function nextToSend(queues: Queues, conversationId: number): QueuedMessage | null {
  return queueOf(queues, conversationId).items[0] ?? null;
}
