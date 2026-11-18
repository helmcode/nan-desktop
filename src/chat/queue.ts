// Composer queue: the user can keep typing while a reply runs. Sending then
// adds the message to a queue of THAT conversation instead of sending it.
//
// Semantics (see docs/ARCHITECTURE.md, "Composer queue"):
// - When the running turn ends, queued messages are sent in order, one per
//   turn (each waits for the previous reply), for the conversation on
//   screen. A conversation whose turn ended while another one was on screen
//   sends its queue when the user comes back to it.
// - A turn the user stopped (`user_stop`) holds the queue: the user stopped
//   on purpose, so nothing goes out by itself. The queue stays visible with
//   a "Send now" action. A turn that ended because the session expired holds
//   it too (the send would fail).
// - Every other end (completed, tool_cap, stream_cut, length, interrupted,
//   error) flushes the queue, and a queued message takes precedence over the
//   automatic continuation of a cut reply (the user already said what next).
// - Sending another message while the queue is held releases it.
// - A message that fails to go out is put back at the front, held.
// - The queue lives in memory for the app session: it survives switching
//   conversations, not restarts, and is gone on sign-out / realm switch
//   (the chat shell is keyed by realm).
//
// Pure functions over an immutable map, so the rules are unit-tested here.

export interface QueuedMessage {
  /** Local id (edit / remove target); never sent anywhere. */
  id: number;
  text: string;
}

export interface ConversationQueue {
  items: readonly QueuedMessage[];
  /** Waiting for the user (after a stop): not sent by itself. */
  held: boolean;
}

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
 * queue. Blank text is ignored. */
export function enqueue(queues: Queues, conversationId: number, text: string, id: number): Queues {
  const trimmed = text.trim();
  if (!trimmed) return queues;
  const current = queueOf(queues, conversationId);
  return withQueue(queues, conversationId, { items: [...current.items, { id, text: trimmed }], held: false });
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
  return withQueue(queues, conversationId, { items: [message, ...current.items], held: true });
}

function setHeld(queues: Queues, conversationId: number, held: boolean): Queues {
  const current = queues.get(conversationId);
  if (!current || current.held === held) return queues;
  return withQueue(queues, conversationId, { ...current, held });
}

export function hold(queues: Queues, conversationId: number): Queues {
  return setHeld(queues, conversationId, true);
}

export function release(queues: Queues, conversationId: number): Queues {
  return setHeld(queues, conversationId, false);
}

/** Whether the turn end `reason` holds the queue instead of sending it. */
export function heldAfter(reason: string | null | undefined): boolean {
  return reason === "user_stop";
}

/** The conversation has queued messages that should go out by themselves. */
export function wantsFlush(queues: Queues, conversationId: number): boolean {
  const current = queueOf(queues, conversationId);
  return current.items.length > 0 && !current.held;
}

export function nextToSend(queues: Queues, conversationId: number): QueuedMessage | null {
  return queueOf(queues, conversationId).items[0] ?? null;
}
