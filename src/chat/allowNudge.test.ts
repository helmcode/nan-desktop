import { describe, expect, it } from "vitest";
import {
  NUDGE_THRESHOLD,
  initialNudgeState,
  nudgeReducer,
  targetForPath,
  type NudgeEvent,
  type NudgeState,
  type NudgeTarget,
} from "./allowNudge";
import type { GrantView } from "../types";

function grant(overrides: Partial<GrantView> = {}): GrantView {
  return {
    id: "g1",
    canonical_path: "/Users/ana/Proyecto",
    granted_at: "",
    profile_id: "nan",
    scope: "folder",
    mode: "ask",
    ...overrides,
  };
}

const FOLDER: NudgeTarget = { kind: "folder", grantId: "g1", path: "/Users/ana/Proyecto" };
const OTHER: NudgeTarget = { kind: "folder", grantId: "g2", path: "/Users/ana/Fotos" };

function decide(granted: boolean, target: NudgeTarget | null = FOLDER, conversationId = 7): NudgeEvent {
  return { type: "decision", conversationId, target, granted, anchorIndex: 4 };
}

function run(events: NudgeEvent[], state: NudgeState = initialNudgeState()): NudgeState {
  return events.reduce(nudgeReducer, state);
}

describe("allow-mode suggestion counter", () => {
  it("shows one suggestion after three approvals in the same folder", () => {
    const two = run([decide(true), decide(true)]);
    expect(two.active).toEqual([]);
    const three = nudgeReducer(two, decide(true));
    expect(NUDGE_THRESHOLD).toBe(3);
    expect(three.active).toEqual([{ conversationId: 7, target: FOLDER, anchorIndex: 4, status: "open" }]);
    expect(three.shown).toEqual([7]);
    expect(three.counts[7]).toBeUndefined();
  });

  it("a denial resets the count", () => {
    const state = run([decide(true), decide(true), decide(false), decide(true), decide(true)]);
    expect(state.active).toEqual([]);
    expect(nudgeReducer(state, decide(true)).active).toHaveLength(1);
  });

  it("counts each folder on its own", () => {
    const state = run([decide(true, FOLDER), decide(true, OTHER), decide(true, FOLDER), decide(true, OTHER)]);
    expect(state.active).toEqual([]);
    expect(nudgeReducer(state, decide(true, OTHER)).active[0].target).toEqual(OTHER);
  });

  it("never counts actions outside every grant (session temp folder)", () => {
    const state = run([decide(true, null), decide(true, null), decide(true, null)]);
    expect(state.active).toEqual([]);
  });

  it("shows only once per conversation, also after a restart", () => {
    const shown = run([decide(true), decide(true), decide(true), { type: "dismiss", conversationId: 7 }]);
    expect(shown.active).toEqual([]);
    expect(run([decide(true), decide(true), decide(true)], shown).active).toEqual([]);
    // Restored from storage: still remembered.
    expect(run([decide(true), decide(true), decide(true)], initialNudgeState([7])).active).toEqual([]);
    // Other conversations are independent.
    expect(run([decide(true, FOLDER, 8), decide(true, FOLDER, 8), decide(true, FOLDER, 8)], shown).active).toHaveLength(1);
  });

  it("tracks the switch to allow and forgets a deleted conversation", () => {
    const open = run([decide(true), decide(true), decide(true)]);
    const switching = nudgeReducer(open, { type: "switching", conversationId: 7 });
    expect(switching.active[0].status).toBe("switching");
    expect(nudgeReducer(switching, { type: "allowed", conversationId: 7 }).active[0].status).toBe("allowed");
    const cleared = nudgeReducer(switching, { type: "clearConversation", conversationId: 7 });
    expect(cleared.active).toEqual([]);
    expect(cleared.shown).toEqual([]);
  });
});

describe("targetForPath", () => {
  const folders = [grant(), grant({ id: "g3", canonical_path: "/Users/ana/Proyecto/sub" })];
  const wide = grant({ id: "cw", canonical_path: "/Users/ana", scope: "computer_wide" });

  it("picks the longest folder that contains the path", () => {
    expect(targetForPath("/Users/ana/Proyecto/a.txt", folders, null)).toEqual(FOLDER);
    expect(targetForPath("/Users/ana/Proyecto/sub/b.txt", folders, null)).toMatchObject({ grantId: "g3" });
    expect(targetForPath("/Users/ana/Proyecto", folders, null)).toEqual(FOLDER);
  });

  it("does not match a sibling that only shares a prefix", () => {
    expect(targetForPath("/Users/ana/Proyecto2/a.txt", folders, null)).toBeNull();
  });

  it("falls back to the computer-wide grant, else nothing", () => {
    expect(targetForPath("/Users/ana/Desktop/a.txt", folders, wide)).toEqual({ kind: "computer_wide" });
    expect(targetForPath("/tmp/helmcode-desktop/x/a.txt", folders, null)).toBeNull();
    expect(targetForPath(null, folders, wide)).toBeNull();
  });
});
