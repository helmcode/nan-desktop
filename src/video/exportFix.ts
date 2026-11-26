// Export on demand: a format the user asks for at export time that comes
// out cut off is fixed by the assistant and then downloads by itself.
//
// The assistant builds a video in ONE format (the project's own). Only when
// the user selects another format in the export panel is that format
// checked (layoutCheck.ts). When it would come out cut off, nobody is asked
// to choose: the panel says the format needs adjustments, the assistant is
// fixing it and it will download when ready, and this flow:
//
//   1. sends the assistant ONE fix message for those formats (through the
//      composer queue of the conversation on screen, like the generation's
//      automatic fix; the sender lives in App.tsx),
//   2. waits for THAT turn to complete (App reports turn starts and ends;
//      the turn that carries this project's fix is bound to this flow),
//   3. checks the fixed formats again AND the project's own format (a fix
//      must not break the format the user asked for first),
//   4. queues every fixed format that now fits (or could not be checked:
//      a check that cannot run never holds anything back),
//   5. repeats for what is still cut off, at most MAX_EXPORT_FIX_ROUNDS
//      fix messages in all; then it stops in a final state the panel shows
//      with "Export anyway" / "Fix in the chat".
//
// When a fix breaks the own format, the flow stops sending fixes (it would
// only keep changing the video) and says so; a render of the own format
// that has not started yet is held back (it would zip the broken version),
// one already uploaded is left alone.
//
// The flow outlives the panel (like the export queue: the user may go to
// the chat to watch the assistant work), one per project, and the panel
// subscribes with useSyncExternalStore. Plain TypeScript with injected
// effects, tested in exportFix.test.ts.

import type { Aspect } from "./api";
import { exportQueueFor, type Quality } from "./exportQueue";
import { brokenAspects, checkLayout, type LayoutIssue, type LayoutReport } from "./layoutCheck";

/// Most fix messages one export sends.
export const MAX_EXPORT_FIX_ROUNDS = 2;

export interface ExportFixRequest {
  projectId: string;
  /// Model-written: only for the hidden, escaped video context.
  title: string;
  /// The project's own format: the fix must leave it as it is.
  own: Aspect;
  /// The formats to fix, in the app's order.
  aspects: Aspect[];
  report: LayoutReport;
  round: number;
}

/// Hand the fix message to the assistant. Resolves to a function that takes
/// it back if it has not gone out yet (a no-op afterwards), or null when it
/// could not be sent at all.
export type ExportFixSender = (request: ExportFixRequest) => Promise<(() => void) | null>;

export type FixStatus =
  | { kind: "idle" }
  /// The assistant has the request (queued or working on it).
  | { kind: "fixing"; aspects: Aspect[]; report: LayoutReport; round: number }
  /// Its turn completed: checking the result.
  | { kind: "checking"; aspects: Aspect[]; round: number }
  /// Final: these formats were not exported. `rounds`: still cut off after
  /// the last fix (or the fix broke the own format); `unsent`: the request
  /// could not reach the assistant; `stopped`: its turn was stopped or failed.
  | { kind: "stuck"; aspects: Aspect[]; report: LayoutReport; why: "rounds" | "unsent" | "stopped" };

export interface FixSnapshot {
  status: FixStatus;
  own: Aspect;
  quality: Quality;
  /// Formats the assistant fixed and that were queued, this export.
  fixed: Aspect[];
  /// The own format comes out cut off after a fix: what was found.
  ownBroken: LayoutIssue[] | null;
  /// That broken own format's render had not started and was held back.
  ownHeld: boolean;
}

export interface FlowDeps {
  /// Check these formats of the project as it is now.
  check: (aspects: Aspect[], signal: AbortSignal) => Promise<LayoutReport>;
  /// Add formats to the export queue (keeping the rows on screen).
  enqueue: (aspects: Aspect[], quality: Quality) => void;
  /// Cancel this format's renders that have not started. Whether any was.
  cancelNotStarted: (aspect: Aspect) => boolean;
  /// The way to the assistant (null: none, nothing can be fixed).
  sender: () => ExportFixSender | null;
}

const IDLE: FixStatus = { kind: "idle" };

export class ExportFixFlow {
  private snapshot: FixSnapshot = { status: IDLE, own: "16:9", quality: "standard", fixed: [], ownBroken: null, ownHeld: false };
  private readonly subscribers = new Set<() => void>();
  private title = "";
  /// Bumps on every start / cancel: anything that resolves for an older
  /// run is ignored.
  private run = 0;
  private withdraw: (() => void) | null = null;
  private abort: AbortController | null = null;

  constructor(
    readonly projectId: string,
    private readonly deps: FlowDeps,
  ) {}

  // ---------------------------------------------------- store contract --

  subscribe = (fn: () => void): (() => void) => {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  };

  getSnapshot = (): FixSnapshot => this.snapshot;

  /// A fix is on its way (the panel does not start another export).
  get active(): boolean {
    const kind = this.snapshot.status.kind;
    return kind === "fixing" || kind === "checking";
  }

  private update(patch: Partial<FixSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const fn of this.subscribers) fn();
  }

  // ------------------------------------------------------------ actions --

  /// The export found these formats cut off: fix them, then export them.
  /// Ignored while a fix is on its way.
  start({ aspects, report, quality, own, title }: { aspects: Aspect[]; report: LayoutReport; quality: Quality; own: Aspect; title: string }): void {
    if (this.active || aspects.length === 0) return;
    this.run += 1;
    this.title = title;
    this.snapshot = { status: IDLE, own, quality, fixed: [], ownBroken: null, ownHeld: false };
    void this.sendRound(aspects, report, 1);
  }

  /// A new export starts: the last one's notes go.
  reset(): void {
    if (this.active) return;
    this.update({ status: IDLE, fixed: [], ownBroken: null, ownHeld: false });
  }

  /// Stop: nothing more is exported by this flow, and a fix message that
  /// has not gone out yet is taken back. A turn already running is the
  /// user's to stop in the chat.
  cancel(): void {
    this.stopRun();
    this.update({ status: IDLE });
  }

  /// Final state: export what is left as it is.
  exportAnyway(): void {
    const { status, quality } = this.snapshot;
    if (status.kind !== "stuck") return;
    this.stopRun();
    this.deps.enqueue(status.aspects, quality);
    this.update({ status: IDLE });
  }

  /// Final state: the user takes it to the chat (or drops it).
  dismiss(): void {
    if (this.snapshot.status.kind !== "stuck") return;
    this.update({ status: IDLE });
  }

  /// The note about the own format, read.
  dismissOwn(): void {
    this.update({ ownBroken: null, ownHeld: false });
  }

  /// The turn bound to this flow ended. Only a completed turn is checked; a
  /// stopped or failed one ends the flow; a cut one waits for the turn that
  /// continues it.
  turnEnded(reason: string | undefined): void {
    const status = this.snapshot.status;
    if (status.kind !== "fixing") return;
    if (reason === "completed") {
      void this.recheck(status.aspects, status.round);
      return;
    }
    if (reason === "stopped" || reason === "error") {
      unregister(this);
      this.withdraw = null;
      this.update({ status: { kind: "stuck", aspects: status.aspects, report: status.report, why: "stopped" } });
    }
  }

  // -------------------------------------------------------------- inner --

  private stopRun(): void {
    this.run += 1;
    this.abort?.abort();
    this.abort = null;
    this.withdraw?.();
    this.withdraw = null;
    unregister(this);
  }

  private async sendRound(aspects: Aspect[], report: LayoutReport, round: number): Promise<void> {
    const run = this.run;
    this.update({ status: { kind: "fixing", aspects, report, round } });
    const sender = this.deps.sender();
    register(this);
    let withdraw: (() => void) | null = null;
    try {
      withdraw = sender
        ? await sender({ projectId: this.projectId, title: this.title, own: this.snapshot.own, aspects, report, round })
        : null;
    } catch {
      withdraw = null;
    }
    if (run !== this.run) {
      // Canceled while it was handed over.
      withdraw?.();
      return;
    }
    if (!withdraw) {
      unregister(this);
      this.update({ status: { kind: "stuck", aspects, report, why: "unsent" } });
      return;
    }
    this.withdraw = withdraw;
  }

  private async recheck(aspects: Aspect[], round: number): Promise<void> {
    const run = this.run;
    const own = this.snapshot.own;
    unregister(this);
    this.withdraw = null;
    const abort = new AbortController();
    this.abort = abort;
    this.update({ status: { kind: "checking", aspects, round } });
    let report: LayoutReport;
    try {
      report = await this.deps.check([own, ...aspects.filter((a) => a !== own)], abort.signal);
    } catch {
      report = {};
    }
    if (run !== this.run || abort.signal.aborted) return;
    this.abort = null;
    const ownIssues = report[own];
    const ownBroke = !!ownIssues && ownIssues.length > 0;
    if (ownBroke) {
      const held = this.deps.cancelNotStarted(own);
      this.update({ ownBroken: ownIssues, ownHeld: held || this.snapshot.ownHeld });
    }
    const broken = brokenAspects(report, aspects);
    const fits = aspects.filter((aspect) => !broken.includes(aspect));
    if (fits.length > 0) {
      this.deps.enqueue(fits, this.snapshot.quality);
      this.update({ fixed: [...this.snapshot.fixed, ...fits] });
    }
    if (broken.length === 0) {
      this.update({ status: IDLE });
      return;
    }
    if (ownBroke || round >= MAX_EXPORT_FIX_ROUNDS) {
      this.update({ status: { kind: "stuck", aspects: broken, report, why: "rounds" } });
      return;
    }
    await this.sendRound(broken, report, round + 1);
  }
}

// ------------------------------------------------------------ the bridge --
//
// App.tsx owns the chat: it registers the sender and reports the turns. A
// fix message carries its project (`exportFix` on the queued message, the
// project in its video context); the turn that starts with it is bound to
// that project's flow, and that turn's end drives the flow.

let sender: ExportFixSender | null = null;
/// Flows waiting for their fix turn, by project.
const waiting = new Map<string, ExportFixFlow>();
/// Conversation -> the flow whose fix turn runs there.
const bound = new Map<number, ExportFixFlow>();

function register(flow: ExportFixFlow): void {
  waiting.set(flow.projectId, flow);
}

function unregister(flow: ExportFixFlow): void {
  if (waiting.get(flow.projectId) === flow) waiting.delete(flow.projectId);
  for (const [id, f] of bound) if (f === flow) bound.delete(id);
}

/// App: the way fix messages reach the assistant. Returns the unregister.
export function setExportFixSender(fn: ExportFixSender): () => void {
  sender = fn;
  return () => {
    if (sender === fn) sender = null;
  };
}

/// App: a turn started with an export fix message for `projectId`.
export function exportFixTurnStarted(conversationId: number, projectId: string | undefined): void {
  if (!projectId) return;
  const flow = waiting.get(projectId);
  if (flow) bound.set(conversationId, flow);
}

/// App: a turn ended (`completed`, a cut reason, or `stopped` / `error`).
export function exportFixTurnEnded(conversationId: number, reason: string | undefined): void {
  const flow = bound.get(conversationId);
  if (!flow) return;
  if (reason === "completed" || reason === "stopped" || reason === "error") bound.delete(conversationId);
  flow.turnEnded(reason);
}

const flows = new Map<string, ExportFixFlow>();

/// The one fix flow of a project (per profile).
export function exportFixFor(profileId: string, projectId: string): ExportFixFlow {
  const id = `${profileId}:${projectId}`;
  let flow = flows.get(id);
  if (!flow) {
    const queue = () => exportQueueFor(profileId, projectId);
    flow = new ExportFixFlow(projectId, {
      check: (aspects, signal) => checkLayout(profileId, projectId, aspects, { signal }),
      enqueue: (aspects, quality) => queue().enqueue(aspects, quality, true),
      cancelNotStarted: (aspect) => queue().cancelNotStarted(aspect),
      sender: () => sender,
    });
    flows.set(id, flow);
  }
  return flow;
}

/// Tests: forget every flow and the bridge.
export function resetExportFixes(): void {
  for (const flow of flows.values()) flow.cancel();
  flows.clear();
  waiting.clear();
  bound.clear();
  sender = null;
}
