// Export on demand: a selected format that comes out cut off is fixed by
// the assistant, re-checked (with the project's own format) and exported
// by itself, at most MAX_EXPORT_FIX_ROUNDS requests; a check that cannot
// run never holds a format back; a request that never becomes a turn ends
// the wait.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Aspect } from "./api";
import {
  ExportFixFlow,
  MAX_EXPORT_FIX_ROUNDS,
  exportFixDropped,
  exportFixFor,
  exportFixTurnEnded,
  exportFixTurnStarted,
  resetExportFixes,
  setExportFixScreen,
  setExportFixSender,
  type ExportFixRequest,
  type ExportFixSender,
  type FlowDeps,
} from "./exportFix";
import type { LayoutReport } from "./layoutCheck";

const cut = { scene: "intro", time: 1, kind: "clipped" as const, element: "#intro-title" };
const SQUARE_CUT: LayoutReport = { "1:1": [cut] };

function setup(reports: LayoutReport[] = [], sender?: ExportFixSender | null, conversationId: number | null = 7) {
  const sent: ExportFixRequest[] = [];
  const withdrawn: number[] = [];
  const enqueued: { aspects: Aspect[]; quality: string }[] = [];
  const checks: Aspect[][] = [];
  const held: Aspect[] = [];
  const defaultSender: ExportFixSender = async (request) => {
    sent.push(request);
    return { withdraw: () => withdrawn.push(request.fixId), conversationId };
  };
  const deps: FlowDeps = {
    check: vi.fn(async (aspects: Aspect[]) => {
      checks.push(aspects);
      return reports.shift() ?? {};
    }),
    enqueue: (aspects, quality) => enqueued.push({ aspects, quality }),
    cancelNotStarted: (aspect) => {
      held.push(aspect);
      return true;
    },
    sender: () => (sender === undefined ? defaultSender : sender),
  };
  const flow = new ExportFixFlow("nan:p1", "p1", deps);
  return { flow, sent, withdrawn, enqueued, checks, held, deps };
}

const START = { aspects: ["1:1"] as Aspect[], report: SQUARE_CUT, quality: "draft" as const, own: "9:16" as Aspect, title: "Promo" };

/// Let the awaited sender and checks settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

/// The last request's turn runs in conversation 7 and ends with `reason`.
async function fixTurn(sent: ExportFixRequest[], reason = "completed") {
  exportFixTurnStarted(7, sent[sent.length - 1].fixId);
  exportFixTurnEnded(7, reason);
  await settle();
}

afterEach(() => resetExportFixes());

describe("ExportFixFlow", () => {
  it("asks the assistant to fix the cut-off format, keeping the own one, and waits for the turn", async () => {
    const { flow, sent, enqueued, checks } = setup();
    flow.start(START);
    await settle();
    expect(sent).toEqual([{ fixId: expect.any(Number), projectId: "p1", title: "Promo", own: "9:16", aspects: ["1:1"], report: SQUARE_CUT, round: 1 }]);
    expect(flow.getSnapshot().status).toMatchObject({ kind: "fixing", aspects: ["1:1"], round: 1, started: false, conversationId: 7 });
    expect(flow.active).toBe(true);
    // Its turn starts: now the assistant is on it.
    exportFixTurnStarted(7, sent[0].fixId);
    expect(flow.getSnapshot().status).toMatchObject({ kind: "fixing", started: true });
    expect(checks).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("after the fix turn, re-checks the fixed format AND the own one, then exports the fixed one by itself", async () => {
    const { flow, sent, enqueued, checks } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    await settle();
    await fixTurn(sent);
    expect(checks).toEqual([["9:16", "1:1"]]);
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    expect(flow.getSnapshot()).toMatchObject({ status: { kind: "idle" }, fixed: ["1:1"], ownBroken: null });
    expect(flow.active).toBe(false);
  });

  it("a re-check that cannot run never holds the format back", async () => {
    const { flow, sent, enqueued, deps } = setup([{ "9:16": null, "1:1": null }]);
    flow.start(START);
    await settle();
    await fixTurn(sent);
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    (deps.check as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    flow.start(START);
    await settle();
    await fixTurn(sent);
    expect(enqueued).toHaveLength(2);
  });

  it("is bounded: still cut off after MAX_EXPORT_FIX_ROUNDS fixes, it stops in a final state", async () => {
    const { flow, sent, enqueued } = setup([{ "9:16": [], "1:1": [cut] }, { "9:16": [], "1:1": [cut] }]);
    flow.start(START);
    await settle();
    await fixTurn(sent);
    expect(sent).toHaveLength(2);
    expect(sent[1].round).toBe(2);
    expect(sent[1].fixId).not.toBe(sent[0].fixId);
    expect(flow.getSnapshot().status).toMatchObject({ kind: "fixing", round: 2, started: false });
    await fixTurn(sent);
    expect(MAX_EXPORT_FIX_ROUNDS).toBe(2);
    expect(sent).toHaveLength(MAX_EXPORT_FIX_ROUNDS);
    expect(flow.getSnapshot().status).toEqual({ kind: "stuck", aspects: ["1:1"], report: { "9:16": [], "1:1": [cut] }, why: "rounds" });
    expect(enqueued).toEqual([]);
    await fixTurn(sent);
    expect(sent).toHaveLength(2);
    flow.exportAnyway();
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    expect(flow.getSnapshot().status.kind).toBe("idle");
  });

  it("exports what got fixed and keeps fixing only what is still cut off", async () => {
    const { flow, sent, enqueued } = setup([{ "9:16": [], "16:9": [], "1:1": [cut] }]);
    flow.start({ ...START, aspects: ["16:9", "1:1"], report: { "16:9": [cut], "1:1": [cut] } });
    await settle();
    await fixTurn(sent);
    expect(enqueued).toEqual([{ aspects: ["16:9"], quality: "draft" }]);
    expect(sent[1].aspects).toEqual(["1:1"]);
  });

  it("a fix that breaks the own format is surfaced, holds its unstarted render and stops fixing", async () => {
    const { flow, sent, enqueued, held } = setup([{ "9:16": [cut], "1:1": [] }]);
    flow.start(START);
    await settle();
    await fixTurn(sent);
    expect(held).toEqual(["9:16"]);
    expect(flow.getSnapshot()).toMatchObject({ ownBroken: [cut], ownHeld: true, status: { kind: "idle" } });
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    flow.dismissOwn();
    expect(flow.getSnapshot().ownBroken).toBeNull();
    resetExportFixes();
    const second = setup([{ "9:16": [cut], "1:1": [cut] }]);
    second.flow.start(START);
    await settle();
    await fixTurn(second.sent);
    expect(second.sent).toHaveLength(1);
    expect(second.flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "rounds" });
  });

  it("cancel while queued: the request is taken back and the turn's end exports nothing", async () => {
    const { flow, sent, withdrawn, enqueued, checks } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    await settle();
    flow.cancel();
    expect(withdrawn).toEqual([sent[0].fixId]);
    expect(flow.getSnapshot()).toMatchObject({ status: { kind: "idle" }, canceledMidTurn: false });
    await fixTurn(sent);
    expect(checks).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("cancel once the assistant is working says it may keep editing", async () => {
    const { flow, sent } = setup();
    flow.start(START);
    await settle();
    exportFixTurnStarted(7, sent[0].fixId);
    flow.cancel();
    expect(flow.getSnapshot()).toMatchObject({ status: { kind: "idle" }, canceledMidTurn: true });
    flow.reset();
    expect(flow.getSnapshot().canceledMidTurn).toBe(false);
  });

  it("cancel during the re-check aborts it and exports nothing", async () => {
    let release: (r: LayoutReport) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const { flow, sent, enqueued, deps } = setup();
    deps.check = (_aspects, s) => {
      signal = s;
      return new Promise<LayoutReport>((r) => (release = r));
    };
    flow.start(START);
    await settle();
    await fixTurn(sent);
    expect(flow.getSnapshot().status.kind).toBe("checking");
    flow.cancel();
    expect(signal?.aborted).toBe(true);
    release({ "9:16": [], "1:1": [] });
    await settle();
    expect(enqueued).toEqual([]);
  });

  it("a request that cannot reach the assistant ends in a final state", async () => {
    const { flow } = setup([], null);
    flow.start(START);
    await settle();
    expect(flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "unsent" });
    const failing = setup([], async () => null);
    failing.flow.start(START);
    await settle();
    expect(failing.flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "unsent" });
  });

  it("a request that leaves the queue unsent ends the wait (removed, or held after a Stop)", async () => {
    const { flow, sent } = setup();
    flow.start(START);
    await settle();
    exportFixDropped(sent[0].fixId, "removed");
    expect(flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "removed", aspects: ["1:1"] });
    flow.dismiss();
    flow.start(START);
    await settle();
    // A drop of an older request changes nothing.
    exportFixDropped(sent[0].fixId, "held");
    expect(flow.getSnapshot().status.kind).toBe("fixing");
    exportFixDropped(sent[1].fixId, "held");
    expect(flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "held" });
  });

  it("a late sender answer for an overtaken request is taken back, never kept", async () => {
    let answer: (v: { withdraw: () => void; conversationId: number }) => void = () => undefined;
    const late = vi.fn();
    const { flow } = setup([], () => new Promise((r) => (answer = r)));
    flow.start(START);
    flow.cancel();
    answer({ withdraw: late, conversationId: 7 });
    await settle();
    expect(late).toHaveBeenCalledTimes(1);
    expect(flow.getSnapshot().status.kind).toBe("idle");
  });

  it("a stopped or failed fix turn ends in a final state; a cut one waits for its continuation", async () => {
    const { flow, sent, enqueued } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    await settle();
    await fixTurn(sent, "stream_cut");
    expect(flow.getSnapshot().status.kind).toBe("fixing");
    exportFixTurnEnded(7, "completed");
    await settle();
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    flow.start(START);
    await settle();
    await fixTurn(sent, "stopped");
    expect(flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "stopped" });
    flow.dismiss();
    flow.start(START);
    await settle();
    await fixTurn(sent, "error");
    expect(flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "stopped" });
  });

  it("only the turn that carries this request drives it, and another export's turn never steals its binding silently", async () => {
    const a = setup([{ "9:16": [], "1:1": [] }]);
    a.flow.start(START);
    await settle();
    exportFixTurnEnded(3, "completed");
    exportFixTurnStarted(5, 999);
    exportFixTurnEnded(5, "completed");
    await settle();
    expect(a.checks).toEqual([]);
    // A's turn is cut and never continued; B's request starts a turn in the
    // same conversation: A is told it is over, B is bound.
    exportFixTurnStarted(7, a.sent[0].fixId);
    exportFixTurnEnded(7, "stream_cut");
    const b = setup([{ "9:16": [], "1:1": [] }]);
    b.flow.start(START);
    await settle();
    exportFixTurnStarted(7, b.sent[0].fixId);
    expect(a.flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "stopped" });
    exportFixTurnEnded(7, "completed");
    await settle();
    expect(b.enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
  });

  it("names the conversation a request waits in when it is not on screen", async () => {
    setExportFixSender(async () => ({ withdraw: () => undefined, conversationId: 3 }));
    const flow = exportFixFor("nan", "p1");
    setExportFixScreen(7, (id) => (id === 3 ? "Reel de verano" : null));
    flow.start(START);
    await settle();
    expect(flow.getSnapshot().waitingIn).toEqual({ title: "Reel de verano" });
    // The user opens it: no longer "elsewhere".
    setExportFixScreen(3, () => "Reel de verano");
    expect(flow.getSnapshot().waitingIn).toBeUndefined();
  });

  it("one export check per project, whichever panel runs it", () => {
    const { flow } = setup();
    expect(flow.beginCheck()).toBe(true);
    expect(flow.getSnapshot().gateChecking).toBe(true);
    expect(flow.beginCheck()).toBe(false);
    flow.endCheck();
    expect(flow.getSnapshot().gateChecking).toBe(false);
  });

  it("a second start while fixing is ignored; reset clears the last export's notes", async () => {
    const { flow, sent } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    flow.start({ ...START, aspects: ["16:9"] });
    await settle();
    expect(sent).toHaveLength(1);
    await fixTurn(sent);
    expect(flow.getSnapshot().fixed).toEqual(["1:1"]);
    flow.reset();
    expect(flow.getSnapshot().fixed).toEqual([]);
  });
});
