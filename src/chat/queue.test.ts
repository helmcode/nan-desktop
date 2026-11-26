// Composer queue (spec): while a reply runs, sending adds the message to a
// per-conversation queue. When the turn ends the queue is sent in order, one
// message per turn, unless the user stopped the turn (or the session needs a
// new sign-in): then the queue is held until the user asks to send it.
import { describe, expect, it } from "vitest";
import {
  dropQueue,
  EMPTY_QUEUES,
  enqueue,
  heldAfter,
  hold,
  nextToSend,
  queueOf,
  release,
  removeQueued,
  requeueFront,
  takeQueued,
  wantsFlush,
} from "./queue";

describe("composer queue", () => {
  it("starts empty for every conversation", () => {
    expect(queueOf(EMPTY_QUEUES, 8)).toEqual({ items: [], held: false });
    expect(wantsFlush(EMPTY_QUEUES, 8)).toBe(false);
    expect(nextToSend(EMPTY_QUEUES, 8)).toBeNull();
  });

  it("keeps messages in order, per conversation", () => {
    let q = enqueue(EMPTY_QUEUES, 8, "first", 1);
    q = enqueue(q, 8, "second", 2);
    q = enqueue(q, 5, "elsewhere", 3);
    expect(queueOf(q, 8).items.map((m) => m.text)).toEqual(["first", "second"]);
    expect(queueOf(q, 5).items.map((m) => m.text)).toEqual(["elsewhere"]);
    expect(nextToSend(q, 8)?.text).toBe("first");
  });

  it("ignores blank text and never mutates the previous state", () => {
    const before = enqueue(EMPTY_QUEUES, 8, "hi", 1);
    expect(enqueue(before, 8, "   ", 2)).toBe(before);
    const after = enqueue(before, 8, "  again  ", 3);
    expect(queueOf(before, 8).items).toHaveLength(1);
    expect(queueOf(after, 8).items.map((m) => m.text)).toEqual(["hi", "again"]);
  });

  it("takes the head and forgets an emptied conversation", () => {
    let q = enqueue(EMPTY_QUEUES, 8, "a", 1);
    q = enqueue(q, 8, "b", 2);
    q = takeQueued(q, 8);
    expect(queueOf(q, 8).items.map((m) => m.text)).toEqual(["b"]);
    q = takeQueued(q, 8);
    expect(q.has(8)).toBe(false);
    expect(takeQueued(q, 8)).toBe(q);
  });

  it("removes one message by id", () => {
    let q = enqueue(EMPTY_QUEUES, 8, "a", 1);
    q = enqueue(q, 8, "b", 2);
    q = removeQueued(q, 8, 1);
    expect(queueOf(q, 8).items.map((m) => m.id)).toEqual([2]);
    expect(removeQueued(q, 8, 99)).toBe(q);
    expect(removeQueued(q, 8, 2).has(8)).toBe(false);
  });

  it("holds after a user stop or a busy interruption, and says why", () => {
    expect(heldAfter("user_stop")).toBe("stopped");
    expect(heldAfter("interrupted", "rate_limited")).toBe("failed");
    for (const reason of ["completed", "tool_cap", "stream_cut", "length", "interrupted", "error", undefined]) {
      expect(heldAfter(reason)).toBe(false);
    }
    expect(heldAfter("interrupted", "server")).toBe(false);
  });

  it("does not flush a held queue until it is released, and keeps the reason", () => {
    let q = enqueue(EMPTY_QUEUES, 8, "a", 1);
    q = hold(q, 8, "stopped");
    expect(queueOf(q, 8).held).toBe("stopped");
    q = hold(q, 8, "failed");
    expect(queueOf(q, 8).held).toBe("failed");
    expect(wantsFlush(q, 8)).toBe(false);
    expect(nextToSend(q, 8)?.text).toBe("a");
    q = release(q, 8);
    expect(wantsFlush(q, 8)).toBe(true);
  });

  it("holding or releasing an empty conversation is a no-op", () => {
    expect(hold(EMPTY_QUEUES, 8, "stopped")).toBe(EMPTY_QUEUES);
    expect(release(EMPTY_QUEUES, 8)).toBe(EMPTY_QUEUES);
  });

  it("an automatic message (autoFix) never releases a queue the user held", () => {
    let q = enqueue(EMPTY_QUEUES, 8, "mine", 1);
    q = hold(q, 8, "stopped");
    q = enqueue(q, 8, "fix it", 2, [], { autoFix: true, exportFix: 5 });
    expect(queueOf(q, 8).held).toBe("stopped");
    expect(wantsFlush(q, 8)).toBe(false);
  });

  it("a new message releases a held queue (sending again means go)", () => {
    let q = hold(enqueue(EMPTY_QUEUES, 8, "a", 1), 8, "stopped");
    q = enqueue(q, 8, "b", 2);
    expect(queueOf(q, 8)).toEqual({ items: [{ id: 1, text: "a" }, { id: 2, text: "b" }], held: false });
  });

  it("puts a message that failed to send back at the front, held", () => {
    let q = enqueue(EMPTY_QUEUES, 8, "b", 2);
    q = requeueFront(q, 8, { id: 1, text: "a" });
    expect(queueOf(q, 8)).toEqual({ items: [{ id: 1, text: "a" }, { id: 2, text: "b" }], held: "failed" });
  });

  it("drops a deleted conversation's queue only", () => {
    let q = enqueue(EMPTY_QUEUES, 8, "a", 1);
    q = enqueue(q, 5, "b", 2);
    q = dropQueue(q, 8);
    expect(q.has(8)).toBe(false);
    expect(queueOf(q, 5).items).toHaveLength(1);
    expect(dropQueue(q, 99)).toBe(q);
  });
});

describe("queued attachments", () => {
  const file = {
    id: "img-1",
    kind: "image" as const,
    name: "a.png",
    size: 1,
    previewPath: "/x/a.jpg",
    status: "ready" as const,
  };

  it("a message may be only files, and keeps them through requeue", () => {
    let queues = enqueue(EMPTY_QUEUES, 1, "   ", 1);
    expect(queueOf(queues, 1).items).toHaveLength(0);
    queues = enqueue(queues, 1, "  ", 2, [file]);
    expect(queueOf(queues, 1).items).toEqual([{ id: 2, text: "", attachments: [file] }]);
    const head = queueOf(queues, 1).items[0];
    queues = requeueFront(takeQueued(queues, 1), 1, head);
    expect(queueOf(queues, 1).items[0].attachments).toEqual([file]);
    // A plain message carries no attachments key at all.
    expect(queueOf(enqueue(EMPTY_QUEUES, 1, "hola", 3), 1).items[0]).toEqual({ id: 3, text: "hola" });
  });
});

describe("app-made queued requests", () => {
  it("keep a video request's hidden context and go without the skill", () => {
    const context = { project_id: "0123456789abcdef0123456789abcdef", title: "Promo", problems: ["missing_root"] };
    const queues = enqueue(EMPTY_QUEUES, 7, "Arregla", 1, [], { videoContext: context, skipSkill: true });
    expect(queueOf(queues, 7).items).toEqual([{ id: 1, text: "Arregla", videoContext: context, skipSkill: true }]);
    // A user's message carries neither.
    expect(queueOf(enqueue(EMPTY_QUEUES, 7, "hola", 2), 7).items).toEqual([{ id: 2, text: "hola" }]);
  });
});
