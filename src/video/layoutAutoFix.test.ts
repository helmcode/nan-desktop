// Round 25: the automatic fix after the assistant makes or changes a
// video: checked when the turn completes, at most MAX_AUTO_FIX_ROUNDS
// automatic messages in a row, renewed only by the user writing.
import { describe, expect, it, vi } from "vitest";
import { LayoutAutoFix, MAX_AUTO_FIX_ROUNDS, type AutoFixRequest } from "./layoutAutoFix";
import type { LayoutReport } from "./layoutCheck";

const cut = { scene: "intro", time: 1, kind: "clipped" as const, element: "#intro-title" };
const OK: LayoutReport = { "16:9": [], "9:16": [], "1:1": [] };
const SQUARE_CUT: LayoutReport = { "16:9": [], "9:16": [], "1:1": [cut] };

function setup(reports: LayoutReport[] = [SQUARE_CUT], active = { id: 7 as number | null }) {
  const sent: AutoFixRequest[] = [];
  const check = vi.fn(async () => reports.shift() ?? SQUARE_CUT);
  const fix = new LayoutAutoFix({ check, send: (r) => sent.push(r), isActive: (id) => active.id === id });
  return { fix, sent, check, active };
}

/// One assistant turn that edits the video, then completes.
async function turn(fix: LayoutAutoFix, automatic: boolean, edits = true, reason = "completed") {
  fix.turnStarted(7, automatic);
  if (edits) fix.videoChanged(7, "p1", "Promo");
  await fix.turnEnded(7, reason);
}

describe("LayoutAutoFix", () => {
  it("asks the assistant to fix a format that comes out cut off, naming it", async () => {
    const { fix, sent, check } = setup();
    await turn(fix, false);
    expect(check).toHaveBeenCalledWith("p1");
    expect(sent).toEqual([{ conversationId: 7, projectId: "p1", title: "Promo", broken: ["1:1"], report: SQUARE_CUT }]);
  });

  it("says nothing when every format fits, or when the check could not run", async () => {
    const { fix, sent } = setup([OK, { "16:9": null, "9:16": null, "1:1": null }]);
    await turn(fix, false);
    await turn(fix, false);
    expect(sent).toEqual([]);
  });

  it("does not check a turn that did not touch a video", async () => {
    const { fix, check } = setup();
    await turn(fix, false, false);
    expect(check).not.toHaveBeenCalled();
  });

  it("never loops: at most MAX_AUTO_FIX_ROUNDS automatic messages in a row", async () => {
    const { fix, sent } = setup([SQUARE_CUT, SQUARE_CUT, SQUARE_CUT, SQUARE_CUT]);
    await turn(fix, false);
    for (let i = 0; i < 5; i++) await turn(fix, true);
    expect(MAX_AUTO_FIX_ROUNDS).toBe(2);
    expect(sent).toHaveLength(MAX_AUTO_FIX_ROUNDS);
    expect(fix.roundsOf(7)).toBe(MAX_AUTO_FIX_ROUNDS);
  });

  it("the user writing again renews the allowance", async () => {
    const { fix, sent } = setup([SQUARE_CUT, SQUARE_CUT, SQUARE_CUT, SQUARE_CUT]);
    await turn(fix, false);
    await turn(fix, true);
    await turn(fix, true);
    expect(sent).toHaveLength(2);
    await turn(fix, false);
    expect(sent).toHaveLength(3);
  });

  it("a cut turn keeps the video for the turn that continues it; stop or error forgets it", async () => {
    const { fix, sent, check } = setup();
    await turn(fix, false, true, "stream_cut");
    expect(check).not.toHaveBeenCalled();
    await turn(fix, true, false, "completed");
    expect(sent).toHaveLength(1);
    fix.turnStarted(7, false);
    fix.videoChanged(7, "p1", "Promo");
    fix.forget(7);
    await fix.turnEnded(7, "completed");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("a check overtaken by a new turn is dropped and redone when that turn ends", async () => {
    let release: (r: LayoutReport) => void = () => undefined;
    const sent: AutoFixRequest[] = [];
    const check = vi
      .fn()
      .mockImplementationOnce(() => new Promise<LayoutReport>((r) => (release = r)))
      .mockResolvedValue(SQUARE_CUT);
    const fix = new LayoutAutoFix({ check, send: (r) => sent.push(r), isActive: () => true });
    fix.turnStarted(7, false);
    fix.videoChanged(7, "p1", "Promo");
    const ending = fix.turnEnded(7, "completed");
    // The user writes again while the check runs.
    fix.turnStarted(7, false);
    release(SQUARE_CUT);
    await ending;
    expect(sent).toEqual([]);
    await fix.turnEnded(7, "completed");
    expect(check).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
  });

  it("an overtaken check whose overtaking turn already ended is dropped, never picked up by a later turn", async () => {
    let release: (r: LayoutReport) => void = () => undefined;
    const sent: AutoFixRequest[] = [];
    const check = vi
      .fn()
      .mockImplementationOnce(() => new Promise<LayoutReport>((r) => (release = r)))
      .mockResolvedValue(SQUARE_CUT);
    const fix = new LayoutAutoFix({ check, send: (r) => sent.push(r), isActive: () => true });
    fix.turnStarted(7, false);
    fix.videoChanged(7, "p1", "Promo");
    const ending = fix.turnEnded(7, "completed");
    // The user asks something else; that turn ends before the check does.
    fix.turnStarted(7, false);
    await fix.turnEnded(7, "completed");
    release(SQUARE_CUT);
    await ending;
    // Much later, an unrelated turn completes: nothing about that video.
    fix.turnStarted(7, false);
    await fix.turnEnded(7, "completed");
    expect(check).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  it("once no message can go out, no check is spent", async () => {
    const { fix, sent, check } = setup([SQUARE_CUT, SQUARE_CUT, SQUARE_CUT]);
    await turn(fix, false);
    await turn(fix, true);
    expect(check).toHaveBeenCalledTimes(2);
    await turn(fix, true);
    await turn(fix, true);
    expect(check).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(2);
  });

  it("a check that fails sends nothing and breaks nothing", async () => {
    const sent: AutoFixRequest[] = [];
    const check = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(SQUARE_CUT);
    const fix = new LayoutAutoFix({ check, send: (r) => sent.push(r), isActive: () => true });
    await turn(fix, false);
    expect(sent).toEqual([]);
    await turn(fix, false);
    expect(sent).toHaveLength(1);
  });

  it("several broken videos in one turn: one message each, one round", async () => {
    const { fix, sent } = setup([SQUARE_CUT, { "16:9": [cut], "9:16": [cut], "1:1": [] }]);
    fix.turnStarted(7, false);
    fix.videoChanged(7, "p1", "Promo");
    fix.videoChanged(7, "p2", "Reel");
    await fix.turnEnded(7, "completed");
    expect(sent.map((r) => [r.projectId, r.broken])).toEqual([
      ["p1", ["1:1"]],
      ["p2", ["16:9", "9:16"]],
    ]);
    expect(fix.roundsOf(7)).toBe(1);
  });

  it("off screen: nothing is queued; on return the video is judged as it is now", async () => {
    const active = { id: 1 as number | null };
    const { fix, sent, check } = setup([OK, SQUARE_CUT], active);
    await turn(fix, false);
    // Conversation 7 is not on screen: not even checked yet.
    expect(check).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    // The user comes back and the video passes now (fixed meanwhile): nothing.
    active.id = 7;
    await fix.activated(7);
    expect(check).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    await fix.activated(7);
    expect(check).toHaveBeenCalledTimes(1);
    // Next time it is still broken on return: one message, with the fresh report.
    active.id = 1;
    await turn(fix, false);
    active.id = 7;
    await fix.activated(7);
    expect(sent).toHaveLength(1);
    expect(sent[0].report).toEqual(SQUARE_CUT);
  });

  it("the user leaving while the check runs holds the message for their return", async () => {
    const active = { id: 7 as number | null };
    let release: (r: LayoutReport) => void = () => undefined;
    const sent: AutoFixRequest[] = [];
    const check = vi
      .fn()
      .mockImplementationOnce(() => new Promise<LayoutReport>((r) => (release = r)))
      .mockResolvedValue(SQUARE_CUT);
    const fix = new LayoutAutoFix({ check, send: (r) => sent.push(r), isActive: (id) => active.id === id });
    fix.turnStarted(7, false);
    fix.videoChanged(7, "p1", "Promo");
    const ending = fix.turnEnded(7, "completed");
    active.id = 2;
    release(SQUARE_CUT);
    await ending;
    expect(sent).toEqual([]);
    active.id = 7;
    await fix.activated(7);
    expect(check).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    expect(fix.roundsOf(7)).toBe(1);
  });

  it("conversations are independent", async () => {
    const active = { id: 1 as number | null };
    const { fix, sent } = setup([SQUARE_CUT, SQUARE_CUT], active);
    fix.turnStarted(1, false);
    fix.videoChanged(1, "p1", "A");
    fix.turnStarted(2, false);
    await fix.turnEnded(2, "completed");
    expect(sent).toEqual([]);
    await fix.turnEnded(1, "completed");
    expect(sent.map((r) => r.conversationId)).toEqual([1]);
  });
});
