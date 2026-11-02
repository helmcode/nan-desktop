// Allow-mode suggestion ("permitir siempre") shown in the chat stream.
//
// When the user keeps approving actions one by one in the same folder, the
// chat suggests switching that folder to allow mode. Rules:
// - every approval the user GRANTS in a conversation counts towards the
//   folder that covers the action (longest matching folder grant; actions
//   under the computer-wide grant count towards "computer_wide");
// - any DENIAL in the conversation resets every count;
// - at NUDGE_THRESHOLD approvals without a denial ONE suggestion is shown,
//   once per conversation (remembered across restarts), and the counts
//   reset;
// - actions outside every grant (the session temp folder) never count.
// The suggestion only calls `tools_grant_set_mode` (the core asks for its
// own native confirmation); a computer-wide grant can never be allow, so
// that variant points to Settings instead.

import type { GrantView } from "../types";
import { isInsideRoots } from "./filePaths";

export const NUDGE_THRESHOLD = 3;
export const NUDGE_SHOWN_STORAGE_KEY = "helmcode.allowNudgeShown.v1";

export type NudgeTarget =
  | { kind: "folder"; grantId: string; path: string }
  | { kind: "computer_wide" };

export type NudgeStatus = "open" | "switching" | "allowed";

export interface Nudge {
  conversationId: number;
  target: NudgeTarget;
  /// Messages before the card when it appeared (renders after them).
  anchorIndex: number;
  status: NudgeStatus;
}

export interface NudgeState {
  /// conversation id -> target key -> approvals in a row.
  counts: Record<number, Record<string, number>>;
  /// Conversations that already showed their one suggestion.
  shown: number[];
  /// Visible suggestions (at most one per conversation).
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
  | { type: "switching"; conversationId: number }
  | { type: "allowed"; conversationId: number }
  | { type: "dismiss"; conversationId: number }
  | { type: "clearConversation"; conversationId: number };

export function targetKey(target: NudgeTarget): string {
  return target.kind === "folder" ? `folder:${target.grantId}` : "computer_wide";
}

export function initialNudgeState(shown: number[] = []): NudgeState {
  return { counts: {}, shown, active: [] };
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
      if (!event.target || state.shown.includes(conversationId)) return state;
      const key = targetKey(event.target);
      const current = state.counts[conversationId] ?? {};
      const count = (current[key] ?? 0) + 1;
      if (count < NUDGE_THRESHOLD) {
        return { ...state, counts: { ...state.counts, [conversationId]: { ...current, [key]: count } } };
      }
      const counts = { ...state.counts };
      delete counts[conversationId];
      return {
        counts,
        shown: [...state.shown, conversationId],
        active: [
          ...state.active.filter((nudge) => nudge.conversationId !== conversationId),
          { conversationId, target: event.target, anchorIndex: event.anchorIndex, status: "open" },
        ],
      };
    }
    case "switching":
    case "allowed": {
      const status: NudgeStatus = event.type;
      return {
        ...state,
        active: state.active.map((nudge) =>
          nudge.conversationId === event.conversationId ? { ...nudge, status } : nudge,
        ),
      };
    }
    case "dismiss":
      return { ...state, active: state.active.filter((nudge) => nudge.conversationId !== event.conversationId) };
    case "clearConversation": {
      const counts = { ...state.counts };
      delete counts[event.conversationId];
      return {
        counts,
        shown: state.shown.filter((id) => id !== event.conversationId),
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

export function loadShownNudges(): number[] {
  try {
    const raw = window.localStorage.getItem(NUDGE_SHOWN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

export function saveShownNudges(shown: number[]): void {
  try {
    window.localStorage.setItem(NUDGE_SHOWN_STORAGE_KEY, JSON.stringify(shown));
  } catch {
    // Unavailable storage: the suggestion may show again next run.
  }
}
