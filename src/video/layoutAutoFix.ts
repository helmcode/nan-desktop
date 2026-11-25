// Round 25: videos the assistant makes come out whole in every format.
//
// When a turn in which the assistant created or changed a video ENDS
// (completed), the app runs the layout check (layoutCheck.ts) on that
// video in all three formats. If a format comes out cut off, it sends the
// assistant one automatic "fix it" message with the findings (the same
// path as the editor's fix button: hidden video context, no skill), so the
// fix happens as part of making the video, not when the user exports.
//
// Bounded: at most MAX_AUTO_FIX_ROUNDS automatic messages in a row per
// conversation; only a message the USER sends starts a new allowance. A
// video still broken after that is left to the export gate (ExportPanel),
// which tells the user and offers the same fix by hand. A check that
// cannot run (null) never triggers a message.
//
// Why here and not a core tool the model calls: the check needs real
// layout, which only a webview has; the core has none. A tool would have
// to round-trip to the renderer and wait mid-turn, and the model could
// skip calling it. Checking at the end of the turn costs the model
// nothing, cannot be skipped, and reuses the composer queue (the message
// goes out when that conversation is idle and on screen, like a queued
// message; the user sees it and can remove it).
//
// Off screen: a fix is only queued for the conversation on screen. When the
// turn ends elsewhere, the videos are kept and checked AGAIN when the user
// comes back (`activated`), so nothing stale goes out: a video that was
// fixed or changed meanwhile is judged as it is now.
//
// The message the user sees never quotes the video title (written by the
// model): the title travels only in the hidden, escaped video context.
//
// Plain TypeScript with injected effects, tested in layoutAutoFix.test.ts.

import { ASPECTS, type Aspect } from "./api";
import { brokenAspects, type LayoutReport } from "./layoutCheck";

/// Most automatic fix messages in a row (per conversation).
export const MAX_AUTO_FIX_ROUNDS = 2;

export interface AutoFixRequest {
  conversationId: number;
  projectId: string;
  title: string;
  /// The formats that come out cut off, in the app's order.
  broken: Aspect[];
  report: LayoutReport;
}

export interface AutoFixDeps {
  /// The layout check of a project in every format.
  check: (projectId: string) => Promise<LayoutReport>;
  /// Queue the automatic fix message for that conversation.
  send: (request: AutoFixRequest) => void;
  /// Whether that conversation is the one on screen.
  isActive: (conversationId: number) => boolean;
}

export class LayoutAutoFix {
  /// Videos changed in the running turn: conversation -> project -> title.
  private readonly pending = new Map<number, Map<string, string>>();
  /// Videos whose turn ended while their conversation was off screen.
  private readonly deferred = new Map<number, Map<string, string>>();
  /// Automatic messages sent since the user last wrote.
  private readonly rounds = new Map<number, number>();
  /// Bumps on every new turn: a check that finishes after a new turn
  /// started is stale (that turn may change the video again).
  private readonly generation = new Map<number, number>();
  /// Conversations with a turn running now.
  private readonly running = new Set<number>();

  constructor(private readonly deps: AutoFixDeps) {}

  /// `video://changed`: the assistant created or changed a video.
  videoChanged(conversationId: number, projectId: string, title: string): void {
    add(this.pending, conversationId, projectId, title);
  }

  /// A turn starts. `automatic`: it is one of our fix messages; otherwise
  /// the user wrote, which renews the allowance.
  turnStarted(conversationId: number, automatic: boolean): void {
    this.generation.set(conversationId, (this.generation.get(conversationId) ?? 0) + 1);
    this.running.add(conversationId);
    if (!automatic) this.rounds.delete(conversationId);
  }

  /// The user stopped the turn, it failed, or the chat is gone: nothing
  /// is checked for it.
  forget(conversationId: number): void {
    this.pending.delete(conversationId);
    this.deferred.delete(conversationId);
    this.running.delete(conversationId);
  }

  /// Automatic messages sent since the user last wrote (tests, UI).
  roundsOf(conversationId: number): number {
    return this.rounds.get(conversationId) ?? 0;
  }

  /// `chat://done`. Only a completed turn is checked; a cut one keeps its
  /// videos pending for the turn that continues it.
  async turnEnded(conversationId: number, reason: string | undefined): Promise<void> {
    this.running.delete(conversationId);
    if (reason !== "completed") return;
    const projects = this.pending.get(conversationId);
    if (!projects || projects.size === 0) return;
    this.pending.delete(conversationId);
    await this.review(conversationId, projects);
  }

  /// The conversation came on screen: check the videos held for it, as
  /// they are now.
  async activated(conversationId: number): Promise<void> {
    const projects = this.deferred.get(conversationId);
    if (!projects || projects.size === 0) return;
    this.deferred.delete(conversationId);
    await this.review(conversationId, projects);
  }

  private defer(conversationId: number, entries: Iterable<[string, string]>): void {
    for (const [id, title] of entries) add(this.deferred, conversationId, id, title);
  }

  private async review(conversationId: number, projects: Map<string, string>): Promise<void> {
    // No message could go out anyway: do not spend a check (they share
    // one queue with the export gate). The export gate is the backstop.
    if (this.roundsOf(conversationId) >= MAX_AUTO_FIX_ROUNDS) return;
    if (!this.deps.isActive(conversationId)) {
      this.defer(conversationId, projects);
      return;
    }
    const generation = this.generation.get(conversationId) ?? 0;
    const requests: AutoFixRequest[] = [];
    const entries = [...projects];
    for (let i = 0; i < entries.length; i++) {
      const [projectId, title] = entries[i];
      let report: LayoutReport;
      try {
        report = await this.deps.check(projectId);
      } catch {
        continue;
      }
      if ((this.generation.get(conversationId) ?? 0) !== generation) {
        // A new turn started meanwhile: this verdict may be stale. While
        // that turn still runs, its end checks the videos again; if it has
        // already ended, they are dropped (never left pending for some
        // later, unrelated turn to pick up).
        if (this.running.has(conversationId)) for (const [id, t] of entries.slice(i)) this.videoChanged(conversationId, id, t);
        return;
      }
      const broken = brokenAspects(report, ASPECTS);
      if (broken.length > 0) requests.push({ conversationId, projectId, title, broken, report });
    }
    if (requests.length === 0) return;
    if (!this.deps.isActive(conversationId)) {
      // The user left while it was checked: judged again on return.
      this.defer(conversationId, requests.map((r) => [r.projectId, r.title] as [string, string]));
      return;
    }
    const used = this.roundsOf(conversationId);
    if (used >= MAX_AUTO_FIX_ROUNDS) return;
    this.rounds.set(conversationId, used + 1);
    for (const request of requests) this.deps.send(request);
  }
}

function add(map: Map<number, Map<string, string>>, conversationId: number, projectId: string, title: string): void {
  const projects = map.get(conversationId) ?? new Map<string, string>();
  projects.set(projectId, title);
  map.set(conversationId, projects);
}
