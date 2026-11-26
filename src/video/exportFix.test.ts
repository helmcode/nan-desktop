// Export on demand: a selected format that comes out cut off is fixed by
// the assistant, re-checked (with the project's own format) and exported
// by itself, at most MAX_EXPORT_FIX_ROUNDS fix messages; a check that
// cannot run never holds a format back.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Aspect } from "./api";
import {
  ExportFixFlow,
  MAX_EXPORT_FIX_ROUNDS,
  exportFixTurnEnded,
  exportFixTurnStarted,
  resetExportFixes,
  setExportFixSender,
  type ExportFixRequest,
  type ExportFixSender,
  type FlowDeps,
} from "./exportFix";
import type { LayoutReport } from "./layoutCheck";

const cut = { scene: "intro", time: 1, kind: "clipped" as const, element: "#intro-title" };
const SQUARE_CUT: LayoutReport = { "1:1": [cut] };

function setup(reports: LayoutReport[] = [], sender: ExportFixSender | null = undefined as unknown as null) {
  const sent: ExportFixRequest[] = [];
  const withdrawn: number[] = [];
  const enqueued: { aspects: Aspect[]; quality: string }[] = [];
  const checks: Aspect[][] = [];
  const held: Aspect[] = [];
  const defaultSender: ExportFixSender = async (request) => {
    sent.push(request);
    const n = sent.length;
    return () => withdrawn.push(n);
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
  const flow = new ExportFixFlow("p1", deps);
  setExportFixSender(defaultSender);
  return { flow, sent, withdrawn, enqueued, checks, held, deps };
}

const START = { aspects: ["1:1"] as Aspect[], report: SQUARE_CUT, quality: "draft" as const, own: "9:16" as Aspect, title: "Promo" };

/// Let the awaited sender and checks settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

/// The flow's fix turn runs in conversation 7 and ends with `reason`.
async function fixTurn(reason = "completed") {
  exportFixTurnStarted(7, "p1");
  exportFixTurnEnded(7, reason);
  await settle();
}

afterEach(() => resetExportFixes());

describe("ExportFixFlow", () => {
  it("asks the assistant to fix the cut-off format, keeping the own one, and waits", async () => {
    const { flow, sent, enqueued, checks } = setup();
    flow.start(START);
    await settle();
    expect(sent).toEqual([{ projectId: "p1", title: "Promo", own: "9:16", aspects: ["1:1"], report: SQUARE_CUT, round: 1 }]);
    expect(flow.getSnapshot().status).toEqual({ kind: "fixing", aspects: ["1:1"], report: SQUARE_CUT, round: 1 });
    expect(flow.active).toBe(true);
    // Nothing is checked or exported before the fix turn completes.
    expect(checks).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("after the fix turn, re-checks the fixed format AND the own one, then exports the fixed one by itself", async () => {
    const { flow, enqueued, checks } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    await settle();
    await fixTurn();
    expect(checks).toEqual([["9:16", "1:1"]]);
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    expect(flow.getSnapshot()).toMatchObject({ status: { kind: "idle" }, fixed: ["1:1"], ownBroken: null });
    expect(flow.active).toBe(false);
  });

  it("a re-check that cannot run never holds the format back", async () => {
    const { flow, enqueued, deps } = setup([{ "9:16": null, "1:1": null }]);
    flow.start(START);
    await settle();
    await fixTurn();
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    // Nor does a check that throws.
    (deps.check as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    flow.start(START);
    await settle();
    await fixTurn();
    expect(enqueued).toHaveLength(2);
  });

  it("is bounded: still cut off after MAX_EXPORT_FIX_ROUNDS fixes, it stops in a final state", async () => {
    const { flow, sent, enqueued } = setup([{ "9:16": [], "1:1": [cut] }, { "9:16": [], "1:1": [cut] }, { "9:16": [], "1:1": [] }]);
    flow.start(START);
    await settle();
    await fixTurn();
    expect(sent).toHaveLength(2);
    expect(sent[1].round).toBe(2);
    expect(flow.getSnapshot().status).toMatchObject({ kind: "fixing", round: 2 });
    await fixTurn();
    expect(MAX_EXPORT_FIX_ROUNDS).toBe(2);
    expect(sent).toHaveLength(MAX_EXPORT_FIX_ROUNDS);
    expect(flow.getSnapshot().status).toEqual({ kind: "stuck", aspects: ["1:1"], report: { "9:16": [], "1:1": [cut] }, why: "rounds" });
    expect(enqueued).toEqual([]);
    // A later turn changes nothing.
    await fixTurn();
    expect(sent).toHaveLength(2);
    // "Export anyway" exports it as it is.
    flow.exportAnyway();
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    expect(flow.getSnapshot().status.kind).toBe("idle");
  });

  it("exports what got fixed and keeps fixing only what is still cut off", async () => {
    const { flow, sent, enqueued } = setup([{ "9:16": [], "16:9": [], "1:1": [cut] }]);
    flow.start({ ...START, aspects: ["16:9", "1:1"], report: { "16:9": [cut], "1:1": [cut] } });
    await settle();
    await fixTurn();
    expect(enqueued).toEqual([{ aspects: ["16:9"], quality: "draft" }]);
    expect(sent[1].aspects).toEqual(["1:1"]);
  });

  it("a fix that breaks the own format is surfaced, holds its unstarted render and stops fixing", async () => {
    const { flow, sent, enqueued, held } = setup([{ "9:16": [cut], "1:1": [] }]);
    flow.start(START);
    await settle();
    await fixTurn();
    expect(held).toEqual(["9:16"]);
    expect(flow.getSnapshot()).toMatchObject({ ownBroken: [cut], ownHeld: true, status: { kind: "idle" } });
    // The fixed format fits: it still goes.
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    flow.dismissOwn();
    expect(flow.getSnapshot().ownBroken).toBeNull();
    // With formats still cut off, no second fix goes out (it would only keep
    // changing the video): final state.
    const second = setup([{ "9:16": [cut], "1:1": [cut] }]);
    second.flow.start(START);
    await settle();
    await fixTurn();
    expect(second.sent).toHaveLength(1);
    expect(second.flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "rounds" });
    expect(sent).toHaveLength(1);
  });

  it("cancel: the queued message is taken back and the turn's end exports nothing", async () => {
    const { flow, withdrawn, enqueued, checks } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    await settle();
    flow.cancel();
    expect(withdrawn).toEqual([1]);
    expect(flow.getSnapshot().status.kind).toBe("idle");
    await fixTurn();
    expect(checks).toEqual([]);
    expect(enqueued).toEqual([]);
  });

  it("cancel during the re-check aborts it and exports nothing", async () => {
    let release: (r: LayoutReport) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const { flow, enqueued, deps } = setup();
    deps.check = (_aspects, s) => {
      signal = s;
      return new Promise<LayoutReport>((r) => (release = r));
    };
    flow.start(START);
    await settle();
    await fixTurn();
    expect(flow.getSnapshot().status.kind).toBe("checking");
    flow.cancel();
    expect(signal?.aborted).toBe(true);
    release({ "9:16": [], "1:1": [] });
    await settle();
    expect(enqueued).toEqual([]);
  });

  it("a message that cannot reach the assistant ends in a final state", async () => {
    const { flow } = setup([], null);
    flow.start(START);
    await settle();
    expect(flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "unsent" });
    const failing = setup([], async () => null);
    failing.flow.start(START);
    await settle();
    expect(failing.flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "unsent" });
  });

  it("a stopped or failed fix turn ends in a final state; a cut one waits for its continuation", async () => {
    const { flow, enqueued } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    await settle();
    await fixTurn("stream_cut");
    expect(flow.getSnapshot().status.kind).toBe("fixing");
    // The continuation (same conversation) completes it.
    exportFixTurnEnded(7, "completed");
    await settle();
    expect(enqueued).toEqual([{ aspects: ["1:1"], quality: "draft" }]);
    flow.start(START);
    await settle();
    await fixTurn("stopped");
    expect(flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "stopped" });
    flow.dismiss();
    flow.start(START);
    await settle();
    await fixTurn("error");
    expect(flow.getSnapshot().status).toMatchObject({ kind: "stuck", why: "stopped" });
  });

  it("only the turn that carries this project's fix drives it", async () => {
    const { flow, checks } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    await settle();
    // Another conversation's turn, or one for another project, ends.
    exportFixTurnEnded(3, "completed");
    exportFixTurnStarted(5, "other");
    exportFixTurnEnded(5, "completed");
    exportFixTurnStarted(6, undefined);
    exportFixTurnEnded(6, "completed");
    await settle();
    expect(checks).toEqual([]);
    expect(flow.getSnapshot().status.kind).toBe("fixing");
  });

  it("a second start while fixing is ignored; reset clears the last export's notes", async () => {
    const { flow, sent } = setup([{ "9:16": [], "1:1": [] }]);
    flow.start(START);
    flow.start({ ...START, aspects: ["16:9"] });
    await settle();
    expect(sent).toHaveLength(1);
    await fixTurn();
    expect(flow.getSnapshot().fixed).toEqual(["1:1"]);
    flow.reset();
    expect(flow.getSnapshot().fixed).toEqual([]);
  });
});
