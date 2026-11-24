// R-V1 (round 24): the export queue. The user picks one or more formats
// (16:9, 9:16, 1:1) and they render ONE AFTER ANOTHER: never more than one
// render of ours in flight, so the server's limits (2 active renders per
// user, 10 creates per hour) are respected by construction; a 429 anyway
// (another project, another device) waits `Retry-After` and tries again.
//
// One queue per project, shared by every export panel showing it (the
// editor and the side panel) and kept while the panel is closed, so going
// back to the chat never stops an export. Plain TypeScript (no React) so it
// is tested directly (exportQueue.test.ts); the panel subscribes with
// useSyncExternalStore.

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  exportAbort,
  exportCancel,
  exportDownload,
  exportErrorOf,
  exportQuota,
  exportStart,
  exportStatus,
  onDownloadProgress,
  onUploadProgress,
  type Aspect,
  type ExportError,
  type VideoExport,
} from "./api";
import { rememberRender, uploadTooSlow } from "./logic";

/// How often a render's status is asked for.
export const POLL_MS = 2000;
/// How long to wait for a free slot when the server gives no Retry-After.
export const DEFAULT_WAIT_S = 30;
/// How many times one format waits for a free slot before giving up.
export const MAX_WAITS = 10;

/// Refusals that mean "not now": wait and try again.
const WAIT_KINDS = new Set(["too_many_active", "rate_limited", "busy"]);
/// Refusals that apply to every format: the rest of the queue is skipped.
const FATAL_KINDS = new Set(["quota_exhausted", "subscription_required", "no_session", "too_large", "invalid_project"]);

export type Quality = "standard" | "draft";

export type QueuePhase =
  | { kind: "pending" }
  /// The server said "not now" (`reason`: too_many_active, rate_limited,
  /// busy): trying again at `until` (epoch ms).
  | { kind: "waiting"; reason: string; until: number }
  | { kind: "uploading"; pct: number | null; slow: boolean }
  /// `progress` null: queued on the server.
  | { kind: "rendering"; renderId: string; progress: number | null }
  | { kind: "canceling" }
  | { kind: "downloading"; pct: number | null }
  | { kind: "done"; file: VideoExport }
  /// The user canceled it: a neutral note, nothing charged.
  | { kind: "canceled" }
  /// Not exported because an earlier format hit a refusal that applies to all.
  | { kind: "skipped" }
  | { kind: "error"; error: ExportError };

export interface QueueItem {
  key: number;
  aspect: Aspect;
  quality: Quality;
  phase: QueuePhase;
}

const SETTLED = new Set<QueuePhase["kind"]>(["done", "canceled", "skipped", "error"]);

export function isSettled(item: QueueItem): boolean {
  return SETTLED.has(item.phase.kind);
}

/// Per item: what the runner needs besides what is shown.
interface Control {
  cancel: boolean;
  renderId: string | null;
  wake: (() => void) | null;
}

export class ExportQueue {
  private items: QueueItem[] = [];
  private readonly controls = new Map<number, Control>();
  private readonly subscribers = new Set<() => void>();
  private nextKey = 1;
  private running = false;
  private uploadStarted = 0;
  private unlisten: Promise<UnlistenFn>[] = [];

  constructor(
    readonly profileId: string,
    readonly projectId: string,
  ) {}

  // ---------------------------------------------------- store contract --

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  };

  getSnapshot = (): QueueItem[] => this.items;

  /// Whether a format is still on its way (pending, waiting or running).
  get busy(): boolean {
    return this.items.some((item) => !isSettled(item));
  }

  private emit(): void {
    for (const fn of this.subscribers) fn();
  }

  private set(key: number, phase: QueuePhase): void {
    this.items = this.items.map((item) => (item.key === key ? { ...item, phase } : item));
    this.emit();
  }

  private phaseOf(key: number): QueuePhase | null {
    return this.items.find((item) => item.key === key)?.phase ?? null;
  }

  // ------------------------------------------------------------ actions --

  /// Queue these formats (in this order). What the previous batch left
  /// (done, canceled, failed rows) is cleared first.
  enqueue(aspects: Aspect[], quality: Quality): void {
    if (aspects.length === 0) return;
    this.items = [
      ...this.items.filter((item) => !isSettled(item)),
      ...aspects.map((aspect) => {
        const key = this.nextKey++;
        this.controls.set(key, { cancel: false, renderId: null, wake: null });
        return { key, aspect, quality, phase: { kind: "pending" } as QueuePhase };
      }),
    ];
    this.emit();
    void this.run();
  }

  /// Pick up a render remembered from before a reopen (its progress and
  /// download), unless this queue is already working.
  resume(renderId: string, aspect: Aspect): void {
    if (this.busy) return;
    const key = this.nextKey++;
    this.controls.set(key, { cancel: false, renderId, wake: null });
    this.items = [
      ...this.items.filter((item) => !isSettled(item)),
      { key, aspect, quality: "standard", phase: { kind: "rendering", renderId, progress: null } },
    ];
    this.emit();
    void this.run();
  }

  /// Cancel one format. A pending or waiting one just leaves the queue; an
  /// upload is aborted while its body is still going out (once sent the
  /// server may have admitted it: its render is canceled when it comes
  /// back, which refunds); a render is canceled on the server (refunded).
  /// A download is never interrupted (the render is already paid).
  cancel(key: number): void {
    const control = this.controls.get(key);
    const phase = this.phaseOf(key);
    if (!control || !phase || control.cancel) return;
    switch (phase.kind) {
      case "pending":
      case "waiting":
        control.cancel = true;
        this.set(key, { kind: "canceled" });
        control.wake?.();
        return;
      case "uploading":
        control.cancel = true;
        void exportAbort(this.projectId).catch(() => false);
        return;
      case "rendering": {
        control.cancel = true;
        const renderId = phase.renderId;
        this.set(key, { kind: "canceling" });
        control.wake?.();
        exportCancel(this.profileId, renderId)
          .catch(() => undefined)
          .finally(() => {
            rememberRender(this.projectId, null);
            this.set(key, { kind: "canceled" });
          });
        return;
      }
      default:
        return;
    }
  }

  /// "Cancel the rest": the formats that have not started (queued or
  /// waiting for a slot). The one rendering keeps going; it has its own
  /// Cancel.
  cancelRest(): void {
    for (const item of this.items) {
      if (item.phase.kind === "pending" || item.phase.kind === "waiting") this.cancel(item.key);
    }
  }

  /// Everything not finished yet (tests, a profile going away).
  cancelEverything(): void {
    for (const item of this.items) {
      if (!isSettled(item) && item.phase.kind !== "downloading") this.cancel(item.key);
    }
  }

  // ------------------------------------------------------------- runner --

  private listen(): void {
    if (this.unlisten.length > 0) return;
    this.unlisten = [
      onUploadProgress((p) => {
        if (p.project_id !== this.projectId) return;
        const item = this.items.find((i) => i.phase.kind === "uploading");
        if (!item || item.phase.kind !== "uploading") return;
        const elapsed = (Date.now() - this.uploadStarted) / 1000;
        this.set(item.key, {
          kind: "uploading",
          // 100 only once every byte is out (then the upload can no
          // longer be canceled: the server may have admitted it).
          pct: p.total ? (p.sent >= p.total ? 100 : Math.min(99, Math.round((p.sent / p.total) * 100))) : null,
          slow: item.phase.slow || uploadTooSlow(p.sent, p.total, elapsed),
        });
      }),
      onDownloadProgress((p) => {
        if (p.project_id !== this.projectId) return;
        const item = this.items.find((i) => i.phase.kind === "downloading");
        if (!item) return;
        this.set(item.key, { kind: "downloading", pct: p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : null });
      }),
    ];
  }

  private stopListening(): void {
    for (const promise of this.unlisten) void promise.then((fn) => fn()).catch(() => undefined);
    this.unlisten = [];
  }

  /// Wait `ms`, or less if the item is canceled meanwhile.
  private wait(ms: number, control: Control): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        control.wake = null;
        resolve();
      }
      control.wake = done;
    });
  }

  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.listen();
    try {
      for (;;) {
        const next = this.items.find((item) => item.phase.kind === "pending" || (item.phase.kind === "rendering" && !this.started.has(item.key)));
        if (!next) break;
        this.started.add(next.key);
        await this.runItem(next);
      }
    } finally {
      this.running = false;
      this.stopListening();
    }
  }

  private readonly started = new Set<number>();

  private async runItem(item: QueueItem): Promise<void> {
    const key = item.key;
    const control = this.controls.get(key)!;
    if (control.cancel) return;
    let renderId = control.renderId;
    if (!renderId) {
      for (let waits = 0; ; ) {
        if (control.cancel) return;
        this.uploadStarted = Date.now();
        this.set(key, { kind: "uploading", pct: null, slow: false });
        try {
          const started = await exportStart(this.profileId, this.projectId, item.quality, item.aspect);
          renderId = started.render_id;
          break;
        } catch (err) {
          const error = exportErrorOf(err);
          if (control.cancel) {
            // Canceled before the server admitted it (aborted, or refused
            // anyway): nothing was charged, whatever the reply said.
            this.set(key, { kind: "canceled" });
            return;
          }
          if (WAIT_KINDS.has(error.kind) && waits < MAX_WAITS) {
            waits += 1;
            const seconds = error.retry_after && error.retry_after > 0 ? error.retry_after : DEFAULT_WAIT_S;
            this.set(key, { kind: "waiting", reason: error.kind, until: Date.now() + seconds * 1000 });
            await this.wait(seconds * 1000, control);
            continue;
          }
          this.set(key, { kind: "error", error });
          if (FATAL_KINDS.has(error.kind)) this.skipRest();
          return;
        }
      }
      control.renderId = renderId;
      rememberRender(this.projectId, renderId, item.aspect);
      if (control.cancel) {
        // Canceled while the reply was on its way: cancel (and refund) it.
        this.set(key, { kind: "canceling" });
        await exportCancel(this.profileId, renderId).catch(() => undefined);
        rememberRender(this.projectId, null);
        this.set(key, { kind: "canceled" });
        return;
      }
      this.set(key, { kind: "rendering", renderId, progress: null });
    }
    if (!(await this.poll(key, renderId, control))) return;
    this.set(key, { kind: "downloading", pct: null });
    try {
      const file = await exportDownload(this.profileId, this.projectId, renderId, item.aspect);
      rememberRender(this.projectId, null);
      this.set(key, { kind: "done", file });
    } catch (err) {
      rememberRender(this.projectId, null);
      this.set(key, { kind: "error", error: exportErrorOf(err) });
    }
  }

  /// Poll a render until it is ready (true) or settled otherwise (false).
  private async poll(key: number, renderId: string, control: Control): Promise<boolean> {
    for (;;) {
      if (control.cancel) return false;
      let status;
      try {
        status = await exportStatus(this.profileId, renderId);
      } catch (err) {
        if (control.cancel) return false;
        const error = exportErrorOf(err);
        // A dropped connection or a busy server keeps trying.
        if (error.kind === "offline" || error.kind === "unavailable" || error.kind === "busy") {
          await this.wait(POLL_MS * 2, control);
          continue;
        }
        // The enterprise API answers a lost session with 404 too: check
        // the session before saying the export is gone.
        let why = error;
        if (error.kind === "not_found") {
          try {
            await exportQuota(this.profileId);
          } catch (again) {
            const session = exportErrorOf(again);
            if (session.kind === "no_session") why = session;
          }
        }
        if (control.cancel) return false;
        rememberRender(this.projectId, null);
        this.set(key, { kind: "error", error: why });
        return false;
      }
      if (control.cancel) return false;
      if (status.status === "done" && status.ready) return true;
      if (status.status === "failed" || status.status === "canceled") {
        rememberRender(this.projectId, null);
        this.set(key, { kind: "error", error: { kind: status.status === "failed" ? (status.error ?? "render_failed") : "canceled" } });
        return false;
      }
      this.set(key, { kind: "rendering", renderId, progress: status.status === "rendering" ? status.progress : null });
      await this.wait(POLL_MS, control);
    }
  }

  private skipRest(): void {
    this.items = this.items.map((item) => (item.phase.kind === "pending" ? { ...item, phase: { kind: "skipped" } } : item));
    this.emit();
  }
}

const queues = new Map<string, ExportQueue>();

/// The one queue of a project (per profile).
export function exportQueueFor(profileId: string, projectId: string): ExportQueue {
  const id = `${profileId}:${projectId}`;
  let queue = queues.get(id);
  if (!queue) {
    queue = new ExportQueue(profileId, projectId);
    queues.set(id, queue);
  }
  return queue;
}

/// Tests: forget every queue (each test starts from nothing).
export function resetExportQueues(): void {
  for (const queue of queues.values()) queue.cancelEverything();
  queues.clear();
}
