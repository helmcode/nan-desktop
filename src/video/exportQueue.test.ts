// @vitest-environment jsdom
// R-V1 round 24: the export queue on its own (no React): one format at a
// time, waiting for a slot, the retry cap, cancels that wake the runner,
// and what "Cancel the rest" leaves alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { invokedWith, resetTauri } from "../test/tauriMock";
import { DEFAULT_WAIT_S, MAX_WAITS, exportQueueFor, resetExportQueues, type QueueItem } from "./exportQueue";
import { PROJECT_ID } from "./fixtures";

const QUEUED = { status: "queued", progress: 0, error: null, ready: false, size_bytes: null, expires_at: null };
const kinds = (items: QueueItem[]) => items.map((item) => item.phase.kind);

beforeEach(() => localStorage.clear());
afterEach(() => {
  resetExportQueues();
  vi.useRealTimers();
});

describe("ExportQueue", () => {
  it("a cancel while waiting for a slot wakes the runner at once and the next format starts", async () => {
    vi.useFakeTimers();
    let calls = 0;
    resetTauri({
      video_export_start: (args) => {
        calls += 1;
        if (args?.aspect === "16:9") throw { kind: "too_many_active", retry_after: 3600 };
        return { render_id: "r-2", charge_seconds: 8 };
      },
      video_export_status: () => QUEUED,
    });
    const queue = exportQueueFor("nan", PROJECT_ID);
    queue.enqueue(["16:9", "9:16"], "standard");
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["waiting", "pending"]));
    const waiting = queue.getSnapshot()[0];
    expect(waiting.phase).toMatchObject({ kind: "waiting", reason: "too_many_active" });
    queue.cancel(waiting.key);
    // No clock advance: the hour-long wait is over because of the cancel.
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["canceled", "rendering"]));
    expect(calls).toBe(2);
    expect(invokedWith("video_export_start").map((a) => a?.aspect)).toEqual(["16:9", "9:16"]);
  });

  it("gives up after MAX_WAITS waits for a slot", async () => {
    vi.useFakeTimers();
    resetTauri({
      video_export_start: () => {
        throw { kind: "rate_limited" };
      },
    });
    const queue = exportQueueFor("nan", PROJECT_ID);
    queue.enqueue(["16:9"], "standard");
    for (let wait = 1; wait <= MAX_WAITS; wait += 1) {
      await vi.waitFor(() => expect(invokedWith("video_export_start").length).toBe(wait));
      await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["waiting"]));
      await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_S * 1000);
    }
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["error"]));
    expect(invokedWith("video_export_start").length).toBe(MAX_WAITS + 1);
    expect(queue.getSnapshot()[0].phase).toEqual({ kind: "error", error: { kind: "rate_limited" } });
  });

  it("a cancel during the upload is a cancel, even if the server answers 429 or 503", async () => {
    let refuse: (err: unknown) => void = () => {};
    resetTauri({
      video_export_start: () => new Promise((_, no) => (refuse = no)),
      video_export_abort: () => false,
    });
    const queue = exportQueueFor("nan", PROJECT_ID);
    queue.enqueue(["16:9"], "standard");
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["uploading"]));
    queue.cancel(queue.getSnapshot()[0].key);
    refuse({ kind: "busy", retry_after: 20 });
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["canceled"]));
    expect(invokedWith("video_export_start").length).toBe(1);
  });

  it("cancels the rest without touching the format that is rendering", async () => {
    resetTauri({
      video_export_start: () => ({ render_id: "r-1", charge_seconds: 8 }),
      video_export_status: () => QUEUED,
      video_export_cancel: () => null,
    });
    const queue = exportQueueFor("nan", PROJECT_ID);
    queue.enqueue(["16:9", "9:16", "1:1"], "draft");
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["rendering", "pending", "pending"]));
    queue.cancelRest();
    expect(kinds(queue.getSnapshot())).toEqual(["rendering", "canceled", "canceled"]);
    expect(invokedWith("video_export_cancel")).toEqual([]);
    expect(queue.busy).toBe(true);
  });

  it("append keeps the batch on screen; a format joining a batch refused for every format is skipped", async () => {
    resetTauri({
      video_export_start: () => {
        throw { kind: "subscription_required" };
      },
    });
    const queue = exportQueueFor("nan", PROJECT_ID);
    queue.enqueue(["16:9"], "draft");
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["error"]));
    queue.enqueue(["9:16"], "draft", true);
    expect(kinds(queue.getSnapshot())).toEqual(["error", "skipped"]);
    expect(invokedWith("video_export_start").length).toBe(1);
    // A new batch (no append) clears the old rows.
    queue.enqueue(["1:1"], "draft");
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["error"]));
    expect(queue.getSnapshot()[0].aspect).toBe("1:1");
  });

  it("cancelNotStarted cancels only that format's queued renders", async () => {
    resetTauri({
      video_export_start: () => ({ render_id: "r-1", charge_seconds: 8 }),
      video_export_status: () => QUEUED,
      video_export_cancel: () => null,
    });
    const queue = exportQueueFor("nan", PROJECT_ID);
    queue.enqueue(["16:9", "9:16", "1:1"], "draft");
    await vi.waitFor(() => expect(kinds(queue.getSnapshot())).toEqual(["rendering", "pending", "pending"]));
    expect(queue.cancelNotStarted("16:9")).toBe(false);
    expect(queue.cancelNotStarted("9:16")).toBe(true);
    expect(kinds(queue.getSnapshot())).toEqual(["rendering", "canceled", "pending"]);
    expect(invokedWith("video_export_cancel")).toEqual([]);
  });

  it("is one queue per project and profile", () => {
    expect(exportQueueFor("nan", PROJECT_ID)).toBe(exportQueueFor("nan", PROJECT_ID));
    expect(exportQueueFor("helmcode", PROJECT_ID)).not.toBe(exportQueueFor("nan", PROJECT_ID));
  });
});
