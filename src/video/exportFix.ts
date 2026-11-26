// Export on demand: a format the user asks for at export time that comes
// out cut off is fixed by the assistant and then downloads by itself.
//
// The assistant builds a video in ONE format (the project's own). Only when
// the user selects another format in the export panel is that format
// checked (layoutCheck.ts). When it would come out cut off, nobody is asked
// to choose: the panel says the format needs adjustments, the assistant is
// fixing it and it will download when ready, and this flow:
//
//   1. hands the assistant ONE fix request for those formats (App.tsx puts
//      it in the send queue of the conversation that made the video, or
//      the one on screen; each request has its own id),
//   2. waits for the turn that request starts ("waiting" until then: it may
//      sit in the queue of a conversation that is not on screen, which the
//      panel names), then for that turn to complete,
//   3. checks the fixed formats again AND the project's own format (a fix
//      must not break the format the user asked for first),
//   4. queues every fixed format that now fits (or could not be checked:
//      a check that cannot run never holds anything back),
//   5. repeats for what is still cut off, at most MAX_EXPORT_FIX_ROUNDS
//      requests in all; then it stops in a final state the panel shows
//      with "Export anyway" / "Fix it in the chat" / "Don't export".
//
// A request that leaves the queue without being sent (the user removed or
// edited it, the conversation was deleted, the queue was held after a Stop
// or a failed send) ends the flow in that final state too: it never waits
// for a turn that will not come.
//
// When a fix breaks the own format, the flow stops sending fixes (it would
// only keep changing the video) and says so; a render of the own format
// that has not started yet is held back (it would zip the broken version),
// one already uploaded is left alone.
//
// The flow outlives the panel (like the export queue), one per project and
// profile, and the panel subscribes with useSyncExternalStore. It also
// tells the panels of that project that a format check is running, so a
// panel opened meanwhile cannot start the same export twice. Plain
// TypeScript with injected effects, tested in exportFix.test.ts.

import type { Aspect } from "./api";
import { exportQueueFor, type Quality } from "./exportQueue";
import { brokenAspects, checkLayout, type LayoutIssue, type LayoutReport } from "./layoutCheck";

/// Most fix requests one export sends.
export const MAX_EXPORT_FIX_ROUNDS = 2;

export interface ExportFixRequest {
  /// Unique in the app session: the queued message carries it, and the turn
  /// it starts is bound by it.
  fixId: number;
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

/// The request was handed over: `withdraw` takes it back if it has not
/// gone out yet (a no-op afterwards); `conversationId` is where it waits
/// (null: it went out right away).
export interface SentFix {
  withdraw: () => void;
  conversationId: number | null;
}

/// Hand the fix request to the assistant; null when it could not be.
export type ExportFixSender = (request: ExportFixRequest) => Promise<SentFix | null>;

/// Why a fix ended without exporting: `rounds` still cut off after the last
/// fix (or the fix broke the own format); `unsent` the request could not
/// reach the assistant; `removed` it left the chat queue unsent; `held` the
/// chat queue was paused (a Stop or a failed send); `stopped` its turn was
/// stopped or failed.
export type StuckReason = "rounds" | "unsent" | "removed" | "held" | "stopped";

export type FixStatus =
  | { kind: "idle" }
  /// The assistant has the request. `started`: its turn is running;
  /// otherwise it waits in `conversationId`'s queue.
  | { kind: "fixing"; aspects: Aspect[]; report: LayoutReport; round: number; fixId: number; started: boolean; conversationId: number | null }
  /// Its turn completed: checking the result.
  | { kind: "checking"; aspects: Aspect[]; round: number }
  /// Final: these formats were not exported.
  | { kind: "stuck"; aspects: Aspect[]; report: LayoutReport; why: StuckReason };

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
  /// Canceled while the assistant was already working on it: it may keep
  /// editing the video in the chat.
  canceledMidTurn: boolean;
  /// The request waits in a conversation that is not on screen: its title
  /// (null when it has none). Undefined: not waiting elsewhere.
  waitingIn?: { title: string | null };
  /// A panel of this project is checking formats for an export.
  gateChecking: boolean;
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

let nextFixId = 1;

export class ExportFixFlow {
  private snapshot: FixSnapshot = {
    status: IDLE,
    own: "16:9",
    quality: "standard",
    fixed: [],
    ownBroken: null,
    ownHeld: false,
    canceledMidTurn: false,
    gateChecking: false,
  };
  private readonly subscribers = new Set<() => void>();
  private title = "";
  /// Bumps on every start / cancel: a check that resolves for an older run
  /// is ignored.
  private run = 0;
  /// The request this flow waits for (0: none). A sender resolving for an
  /// older request is ignored.
  private currentFix = 0;
  private withdraw: (() => void) | null = null;
  private abort: AbortController | null = null;
  private gateChecks = 0;

  constructor(
    readonly key: string,
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
    const next = { ...this.snapshot, ...patch };
    next.waitingIn = waitingIn(next.status);
    this.snapshot = next;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.subscribers) fn();
  }

  /// The conversation on screen (or its titles) changed.
  refresh(): void {
    this.update({});
  }

  // ------------------------------------------------- the export's check --

  /// A panel starts checking formats for this project. False: one already
  /// is (the caller must not start another export).
  beginCheck(): boolean {
    if (this.gateChecks > 0) return false;
    this.gateChecks += 1;
    this.update({ gateChecking: true });
    return true;
  }

  endCheck(): void {
    this.gateChecks = Math.max(0, this.gateChecks - 1);
    this.update({ gateChecking: this.gateChecks > 0 });
  }

  // ------------------------------------------------------------ actions --

  /// The export found these formats cut off: fix them, then export them.
  /// Ignored while a fix is on its way.
  start({ aspects, report, quality, own, title }: { aspects: Aspect[]; report: LayoutReport; quality: Quality; own: Aspect; title: string }): void {
    if (this.active || aspects.length === 0) return;
    this.run += 1;
    this.title = title;
    this.update({ status: IDLE, own, quality, fixed: [], ownBroken: null, ownHeld: false, canceledMidTurn: false });
    void this.sendRound(aspects, report, 1);
  }

  /// A new export starts: the last one's notes go.
  reset(): void {
    if (this.active) return;
    this.update({ status: IDLE, fixed: [], ownBroken: null, ownHeld: false, canceledMidTurn: false });
  }

  /// Stop: nothing more is exported by this flow, and a request that has
  /// not gone out yet is taken back. A turn already running is the user's
  /// to stop in the chat (the panel says so).
  cancel(): void {
    const status = this.snapshot.status;
    const midTurn = (status.kind === "fixing" && status.started) || status.kind === "checking";
    this.stopRun();
    this.update({ status: IDLE, canceledMidTurn: midTurn });
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

  /// The note about a canceled fix, read (a new export clears it too).
  dismissCanceled(): void {
    this.update({ canceledMidTurn: false });
  }

  /// The turn that request `fixId` started is running.
  turnStarted(fixId: number): void {
    const status = this.snapshot.status;
    if (status.kind !== "fixing" || status.fixId !== fixId || status.started) return;
    this.update({ status: { ...status, started: true } });
  }

  /// Request `fixId` left the chat queue without being sent (or came back
  /// to it, held, after its send failed).
  dropped(fixId: number, why: "removed" | "held"): void {
    const status = this.snapshot.status;
    if (status.kind !== "fixing" || status.fixId !== fixId) return;
    this.stopRun();
    this.update({ status: { kind: "stuck", aspects: status.aspects, report: status.report, why } });
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
      this.stopRun();
      this.update({ status: { kind: "stuck", aspects: status.aspects, report: status.report, why: "stopped" } });
    }
  }

  // -------------------------------------------------------------- inner --

  private stopRun(): void {
    this.run += 1;
    this.currentFix = 0;
    this.abort?.abort();
    this.abort = null;
    this.withdraw?.();
    this.withdraw = null;
    unbind(this);
  }

  private async sendRound(aspects: Aspect[], report: LayoutReport, round: number): Promise<void> {
    const fixId = nextFixId++;
    this.currentFix = fixId;
    waiting.set(fixId, this);
    this.update({ status: { kind: "fixing", aspects, report, round, fixId, started: false, conversationId: null } });
    const sender = this.deps.sender();
    let sent: SentFix | null = null;
    try {
      sent = sender
        ? await sender({ fixId, projectId: this.projectId, title: this.title, own: this.snapshot.own, aspects, report, round })
        : null;
    } catch {
      sent = null;
    }
    if (this.currentFix !== fixId) {
      // Canceled (or overtaken) while it was handed over.
      sent?.withdraw();
      return;
    }
    if (!sent) {
      this.stopRun();
      this.update({ status: { kind: "stuck", aspects, report, why: "unsent" } });
      return;
    }
    this.withdraw = sent.withdraw;
    const status = this.snapshot.status;
    if (status.kind === "fixing" && status.fixId === fixId) this.update({ status: { ...status, conversationId: sent.conversationId } });
  }

  private async recheck(aspects: Aspect[], round: number): Promise<void> {
    const run = this.run;
    const own = this.snapshot.own;
    unbind(this);
    this.currentFix = 0;
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
// App.tsx owns the chat: it registers the sender, says which conversation
// is on screen, and reports what happens to each request (by its id): the
// turn it starts, that turn's end, or that it left the queue unsent.

let sender: ExportFixSender | null = null;
/// Requests handed over and not yet answered, by id.
const waiting = new Map<number, ExportFixFlow>();
/// Conversation -> the flow whose fix turn runs there.
const bound = new Map<number, ExportFixFlow>();
let screen: { active: number | null; titleOf: (id: number) => string | null } = { active: null, titleOf: () => null };

function waitingIn(status: FixStatus): { title: string | null } | undefined {
  if (status.kind !== "fixing" || status.started || status.conversationId === null) return undefined;
  if (status.conversationId === screen.active) return undefined;
  return { title: screen.titleOf(status.conversationId) };
}

function unbind(flow: ExportFixFlow): void {
  for (const [id, f] of waiting) if (f === flow) waiting.delete(id);
  for (const [id, f] of bound) if (f === flow) bound.delete(id);
}

/// App: the way fix requests reach the assistant. Returns the unregister.
export function setExportFixSender(fn: ExportFixSender): () => void {
  sender = fn;
  return () => {
    if (sender === fn) sender = null;
  };
}

/// App: the conversation on screen, and how to name the others.
export function setExportFixScreen(active: number | null, titleOf: (id: number) => string | null): void {
  screen = { active, titleOf };
  for (const flow of flows.values()) flow.refresh();
}

/// App: a turn started with fix request `fixId`.
export function exportFixTurnStarted(conversationId: number, fixId: number): void {
  const flow = waiting.get(fixId);
  if (!flow) return;
  // Another export's fix turn cut short here, never continued: that one is
  // over (the assistant moved on), it is not silently dropped.
  const previous = bound.get(conversationId);
  if (previous && previous !== flow) previous.turnEnded("stopped");
  bound.set(conversationId, flow);
  flow.turnStarted(fixId);
}

/// App: a turn ended (`completed`, a cut reason, or `stopped` / `error`).
export function exportFixTurnEnded(conversationId: number, reason: string | undefined): void {
  const flow = bound.get(conversationId);
  if (!flow) return;
  if (reason === "completed" || reason === "stopped" || reason === "error") bound.delete(conversationId);
  flow.turnEnded(reason);
}

/// App: fix request `fixId` left the chat queue without being sent.
export function exportFixDropped(fixId: number, why: "removed" | "held"): void {
  const flow = waiting.get(fixId);
  if (!flow) return;
  waiting.delete(fixId);
  flow.dropped(fixId, why);
}

const flows = new Map<string, ExportFixFlow>();

/// The one fix flow of a project (per profile).
export function exportFixFor(profileId: string, projectId: string): ExportFixFlow {
  const id = `${profileId}:${projectId}`;
  let flow = flows.get(id);
  if (!flow) {
    const queue = () => exportQueueFor(profileId, projectId);
    flow = new ExportFixFlow(id, projectId, {
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
  screen = { active: null, titleOf: () => null };
}
