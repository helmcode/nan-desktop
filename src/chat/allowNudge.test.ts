import { describe, expect, it } from "vitest";
import {
  NUDGE_THRESHOLD,
  decisionTarget,
  initialNudgeState,
  isBrowserApproval,
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

describe("browser suggestion", () => {
  const BROWSER: NudgeTarget = { kind: "browser" };
  const browser = (granted: boolean, conversationId = 7) => decide(granted, BROWSER, conversationId);

  it("shows one browser suggestion after three browser approvals", () => {
    const two = run([browser(true), browser(true)]);
    expect(two.active).toEqual([]);
    const three = nudgeReducer(two, browser(true));
    expect(three.active).toEqual([{ conversationId: 7, target: BROWSER, anchorIndex: 4, status: "open" }]);
    expect(three.shownBrowser).toEqual([7]);
    expect(three.shown).toEqual([]); // the folder suggestion is still available
    // Once per conversation.
    expect(run([browser(true), browser(true), browser(true)], three).active).toHaveLength(1);
  });

  it("any denial in the conversation resets the browser count", () => {
    const state = run([browser(true), browser(true), decide(false, null), browser(true), browser(true)]);
    expect(state.active).toEqual([]);
    expect(nudgeReducer(state, browser(true)).active).toHaveLength(1);
  });

  it("is independent of the folder suggestion (both can show, each once)", () => {
    const state = run([
      decide(true),
      browser(true),
      decide(true),
      browser(true),
      decide(true), // folder suggestion
      browser(true), // browser suggestion: its count survived
    ]);
    expect(state.active.map((nudge) => nudge.target.kind).sort()).toEqual(["browser", "folder"]);
    expect(state.shown).toEqual([7]);
    expect(state.shownBrowser).toEqual([7]);
    // A remembered browser suggestion does not block the folder one.
    const remembered = run([decide(true), decide(true), decide(true)], initialNudgeState([], [7]));
    expect(remembered.active.map((nudge) => nudge.target.kind)).toEqual(["folder"]);
  });

  it("switching, allowed (with its scope) and dismiss act on the browser card only", () => {
    const both = run([decide(true), decide(true), decide(true), browser(true), browser(true), browser(true)]);
    const switching = nudgeReducer(both, { type: "switching", conversationId: 7, family: "browser" });
    const statuses = (state: NudgeState) =>
      Object.fromEntries(state.active.map((nudge) => [nudge.target.kind, nudge.status]));
    expect(statuses(switching)).toEqual({ folder: "open", browser: "switching" });
    const allowed = nudgeReducer(switching, { type: "allowed", conversationId: 7, family: "browser", scope: "session" });
    expect(allowed.active.find((nudge) => nudge.target.kind === "browser")).toMatchObject({
      status: "allowed",
      scope: "session",
    });
    const dismissed = nudgeReducer(allowed, { type: "dismiss", conversationId: 7, family: "browser" });
    expect(dismissed.active.map((nudge) => nudge.target.kind)).toEqual(["folder"]);
    // Without a family the folder card is the one dismissed (legacy callers).
    expect(nudgeReducer(both, { type: "dismiss", conversationId: 7 }).active.map((n) => n.target.kind)).toEqual([
      "browser",
    ]);
    // Deleting the conversation forgets both.
    const cleared = nudgeReducer(both, { type: "clearConversation", conversationId: 7 });
    expect(cleared.active).toEqual([]);
    expect(cleared.shown).toEqual([]);
    expect(cleared.shownBrowser).toEqual([]);
  });

  it("counts new-site approvals and approvals asked only because the assistant browsed", () => {
    expect(isBrowserApproval("browser_site", undefined)).toBe(true);
    expect(isBrowserApproval("write_file", true)).toBe(true);
    expect(isBrowserApproval("run_command", true)).toBe(true);
    // Sign-in, payment and local network always ask: never counted.
    expect(isBrowserApproval("browser_login", undefined)).toBe(false);
    expect(isBrowserApproval("browser_payment", undefined)).toBe(false);
    expect(isBrowserApproval("browser_local_site", undefined)).toBe(false);
    expect(isBrowserApproval("write_file", undefined)).toBe(false);
  });

  it("decisionTarget routes each answered approval to its suggestion", () => {
    const folders = [grant()];
    const inFolder = "/Users/ana/Proyecto/a.txt";
    expect(decisionTarget("browser_site", undefined, "example.com", folders, null)).toEqual(BROWSER);
    // Asked only after browsing: the browser suggestion, not the folder one
    // (the folder already allows).
    expect(decisionTarget("write_file", true, inFolder, folders, null)).toEqual(BROWSER);
    // Other browser cards count towards nothing (a denial still resets).
    expect(decisionTarget("browser_login", undefined, "bank.example", folders, null)).toBeNull();
    expect(decisionTarget("browser_local_site", undefined, "192.168.1.1", folders, null)).toBeNull();
    // A plain folder approval keeps counting towards its folder.
    expect(decisionTarget("write_file", undefined, inFolder, folders, null)).toEqual(FOLDER);
  });
});
