// Per-conversation folder selection (composer picker).
//
// Each conversation picks which of the profile's folder grants it may use:
// none, some or all. A NEW conversation starts with none selected. The
// selection is sent with every `chat_send` (`grantIds`) and the Rust core
// validates that conversation's file actions against those grants only
// (the computer-wide grant, a profile-level mode, is never scoped away).
// With nothing selected the core offers a session temp folder instead and
// the model is told to ask where to save. Selections are remembered per
// conversation in localStorage; the renderer never widens anything: ids of
// grants that no longer exist are dropped before sending.

import type { GrantView } from "../types";

export const FOLDER_SELECTION_STORAGE_KEY = "helmcode.folderSelection.v1";

/// conversation id (as a string) -> selected grant ids.
export type Selections = Record<string, string[]>;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadSelections(): Selections {
  const raw = storage()?.getItem(FOLDER_SELECTION_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Selections = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(value)) out[key] = value.filter((id): id is string => typeof id === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/// Persist real conversations only (the unsaved new chat is in memory).
export function saveSelections(selections: Selections): void {
  const persisted = Object.fromEntries(Object.entries(selections).filter(([key]) => Number(key) >= 0));
  try {
    storage()?.setItem(FOLDER_SELECTION_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Storage full or unavailable: the selection still applies this run.
  }
}

/// The selection of one conversation: none unless the user picked some.
export function selectionFor(selections: Selections, conversationKey: number): string[] {
  return selections[String(conversationKey)] ?? [];
}

/// Only ids of folders that still exist, in folder order.
export function pruneSelection(selected: string[], folders: GrantView[]): string[] {
  return folders.filter((grant) => selected.includes(grant.id)).map((grant) => grant.id);
}

export function toggleFolder(selected: string[], grantId: string): string[] {
  return selected.includes(grantId) ? selected.filter((id) => id !== grantId) : [...selected, grantId];
}

export function allFolders(folders: GrantView[]): string[] {
  return folders.map((grant) => grant.id);
}

export function isAllSelected(selected: string[], folders: GrantView[]): boolean {
  return folders.length > 0 && folders.every((grant) => selected.includes(grant.id));
}

/// Move the unsaved new chat's selection onto the conversation just created.
export function adoptSelection(selections: Selections, fromKey: number, toKey: number): Selections {
  const next = { ...selections };
  const pending = next[String(fromKey)];
  delete next[String(fromKey)];
  if (pending !== undefined) next[String(toKey)] = pending;
  return next;
}
