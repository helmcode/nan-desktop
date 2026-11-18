// Allow-mode suggestion ("permitir siempre") shown in the chat stream.
//
// When the user keeps approving actions one by one in the same folder, the
// chat suggests switching that folder to allow mode. Rules:
// - every approval the user GRANTS in a conversation counts towards the
//   folder that covers the action (longest matching folder grant; actions
//   under the computer-wide grant count towards "computer_wide");
// - any DENIAL in the conversation (folder or browser) clears every count
//   of that conversation, for both families;
// - at NUDGE_THRESHOLD approvals without a denial ONE suggestion is shown,
//   once per conversation (remembered across restarts), and the counts
//   reset;
// - actions outside every grant (the session temp folder) never count.
// The suggestion only calls `tools_grant_set_mode` (the core asks for its
// own native confirmation). The whole-computer variant points to Settings
// instead: switching the whole computer to allow is a decision the user
// makes there, never one click away in the chat.
//
// In-app browser variant ("browser" target, its own family): approvals of
// a new-site card (`browser_site`) and approvals asked only because the
// assistant browsed (`after_browsing`) count towards it; sign-in, payment
// and local-network cards always ask and never count (a denial still
// resets). It offers "always" (`tools_set_browser_mode`) or "only this
// session" (`tools_browser_allow_for_session`), both confirmed natively by
// the core. It is shown once per conversation independently of the folder
// suggestion (separate remembered list).

import type { GrantView } from "../types";
import { isInsideRoots } from "./filePaths";
import { realmScopedKey } from "./realmStorage";

export const NUDGE_THRESHOLD = 3;
export const NUDGE_SHOWN_STORAGE_KEY = "helmcode.allowNudgeShown.v1";
export const BROWSER_NUDGE_SHOWN_STORAGE_KEY = "helmcode.browserNudgeShown.v1";

export type NudgeTarget =
  | { kind: "folder"; grantId: string; path: string }
  | { kind: "computer_wide" }
  | { kind: "browser" };

/// Folder/computer suggestions and the browser suggestion are remembered
/// and shown independently (at most one of each per conversation).
export type NudgeFamily = "grant" | "browser";

export type NudgeStatus = "open" | "switching" | "allowed";

/// What the user chose on a browser suggestion.
export type NudgeScope = "always" | "session";

export interface Nudge {
  conversationId: number;
  target: NudgeTarget;
  /// Messages before the card when it appeared (renders after them).
  anchorIndex: number;
  status: NudgeStatus;
  /// Browser suggestion: what was allowed (set with `allowed`).
  scope?: NudgeScope;
}

export interface NudgeState {
  /// conversation id -> target key -> approvals in a row.
  counts: Record<number, Record<string, number>>;
  /// Conversations that already showed their one folder suggestion.
  shown: number[];
  /// Conversations that already showed their one browser suggestion.
  shownBrowser: number[];
  /// Visible suggestions (at most one per conversation and family).
  active: Nudge[];
}

export type NudgeEvent =
  | {
      type: "decision";
      conversationId: number;
      /// What the action touched; null when no grant covers it.
      target: NudgeTarget | null;
      granted: boolean;
      anchorIndex: number;
    }
  // `family` defaults to "grant" (the folder/computer suggestion).
  | { type: "switching"; conversationId: number; family?: NudgeFamily }
  | { type: "allowed"; conversationId: number; family?: NudgeFamily; scope?: NudgeScope }
  | { type: "dismiss"; conversationId: number; family?: NudgeFamily }
  | { type: "clearConversation"; conversationId: number };

/// Whether an answered approval counts towards the suggestion. A share
/// (share_artifact) never does: it is not a folder action and always asks,
/// so neither its yes nor its no should move the folder counts.
export function countsForNudge(action: string): boolean {
  return action !== "share_artifact";
}

export function targetKey(target: NudgeTarget): string {
  if (target.kind === "folder") return `folder:${target.grantId}`;
  return target.kind;
}

export function nudgeFamily(target: NudgeTarget): NudgeFamily {
  return target.kind === "browser" ? "browser" : "grant";
}

function isOf(nudge: Nudge, conversationId: number, family: NudgeFamily): boolean {
  return nudge.conversationId === conversationId && nudgeFamily(nudge.target) === family;
}

export function initialNudgeState(shown: number[] = [], shownBrowser: number[] = []): NudgeState {
  return { counts: {}, shown, shownBrowser, active: [] };
}

export function nudgeReducer(state: NudgeState, event: NudgeEvent): NudgeState {
  switch (event.type) {
    case "decision": {
      const { conversationId } = event;
      if (!event.granted) {
        if (!state.counts[conversationId]) return state;
        const counts = { ...state.counts };
        delete counts[conversationId];
        return { ...state, counts };
      }
      if (!event.target) return state;
      const family = nudgeFamily(event.target);
      const shownKey = family === "browser" ? "shownBrowser" : "shown";
      if (state[shownKey].includes(conversationId)) return state;
      const key = targetKey(event.target);
      const current = state.counts[conversationId] ?? {};
      const count = (current[key] ?? 0) + 1;
      if (count < NUDGE_THRESHOLD) {
        return { ...state, counts: { ...state.counts, [conversationId]: { ...current, [key]: count } } };
      }
      // Only this family's counts restart; the other keeps counting.
      const rest = Object.fromEntries(
        Object.entries(current).filter(([other]) => (other === "browser") !== (family === "browser")),
      );
      const counts = { ...state.counts, [conversationId]: rest };
      if (Object.keys(rest).length === 0) delete counts[conversationId];
      return {
        ...state,
        counts,
        [shownKey]: [...state[shownKey], conversationId],
        active: [
          ...state.active.filter((nudge) => !isOf(nudge, conversationId, family)),
          { conversationId, target: event.target, anchorIndex: event.anchorIndex, status: "open" },
        ],
      };
    }
    case "switching":
    case "allowed": {
      const status: NudgeStatus = event.type;
      const family = event.family ?? "grant";
      const scope = event.type === "allowed" ? event.scope : undefined;
      return {
        ...state,
        active: state.active.map((nudge) =>
          isOf(nudge, event.conversationId, family) ? { ...nudge, status, ...(scope ? { scope } : {}) } : nudge,
        ),
      };
    }
    case "dismiss": {
      const family = event.family ?? "grant";
      return { ...state, active: state.active.filter((nudge) => !isOf(nudge, event.conversationId, family)) };
    }
    case "clearConversation": {
      const counts = { ...state.counts };
      delete counts[event.conversationId];
      return {
        counts,
        shown: state.shown.filter((id) => id !== event.conversationId),
        shownBrowser: state.shownBrowser.filter((id) => id !== event.conversationId),
        active: state.active.filter((nudge) => nudge.conversationId !== event.conversationId),
      };
    }
    default:
      return state;
  }
}

/// Which grant an approved action counts towards: the longest folder grant
/// containing `path`, else the computer-wide grant when it is on, else
/// null (not counted: e.g. the session temp folder).
export function targetForPath(
  path: string | null,
  folders: GrantView[],
  computerWide: GrantView | null,
): NudgeTarget | null {
  if (!path) return null;
  let best: GrantView | null = null;
  for (const grant of folders) {
    const root = grant.canonical_path;
    if (path === root || isInsideRoots(path, [root])) {
      if (!best || root.length > best.canonical_path.length) best = grant;
    }
  }
  if (best) return { kind: "folder", grantId: best.id, path: best.canonical_path };
  if (computerWide && (path === computerWide.canonical_path || isInsideRoots(path, [computerWide.canonical_path]))) {
    return { kind: "computer_wide" };
  }
  return null;
}

/// Approval card actions that count towards the browser suggestion when
/// granted (a new public site). Sign-in, payment and local-network cards
/// always ask and never count.
const BROWSER_COUNTED_ACTIONS = new Set(["browser_site"]);

/// Whether an answered approval counts towards the browser suggestion:
/// a new-site card, or any card/dialog asked only because the assistant
/// browsed the web in this task.
export function isBrowserApproval(action: string, afterBrowsing: boolean | undefined): boolean {
  return afterBrowsing === true || BROWSER_COUNTED_ACTIONS.has(action);
}

/// What an answered approval counts towards: the browser suggestion for
/// browser approvals, nothing for the other in-app browser cards (sign-in,
/// payment, local network: not folder actions), else the folder covering
/// `path` (see [`targetForPath`]).
export function decisionTarget(
  action: string,
  afterBrowsing: boolean | undefined,
  path: string | null,
  folders: GrantView[],
  computerWide: GrantView | null,
): NudgeTarget | null {
  if (isBrowserApproval(action, afterBrowsing)) return { kind: "browser" };
  if (action.startsWith("browser_")) return null;
  return targetForPath(path, folders, computerWide);
}

/// `realm` scopes the stored ids to the signed-in user (see realmStorage).
export function loadShownNudges(realm = "", key = NUDGE_SHOWN_STORAGE_KEY): number[] {
  try {
    const raw = window.localStorage.getItem(realmScopedKey(key, realm));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

export function saveShownNudges(shown: number[], realm = "", key = NUDGE_SHOWN_STORAGE_KEY): void {
  try {
    window.localStorage.setItem(realmScopedKey(key, realm), JSON.stringify(shown));
  } catch {
    // Unavailable storage: the suggestion may show again next run.
  }
}
