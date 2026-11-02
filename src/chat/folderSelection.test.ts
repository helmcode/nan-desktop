import { beforeEach, describe, expect, it } from "vitest";
import {
  FOLDER_SELECTION_STORAGE_KEY,
  adoptSelection,
  allFolders,
  isAllSelected,
  loadSelections,
  pruneSelection,
  saveSelections,
  selectionFor,
  toggleFolder,
} from "./folderSelection";
import type { GrantView } from "../types";

function grant(id: string, path: string): GrantView {
  return { id, canonical_path: path, granted_at: "", profile_id: "nan", scope: "folder", mode: "ask" };
}

const FOLDERS = [grant("g1", "/a"), grant("g2", "/b")];

beforeEach(() => window.localStorage.clear());

describe("folder selection", () => {
  it("a conversation with no stored selection has NO folder selected", () => {
    expect(selectionFor({}, 7)).toEqual([]);
    expect(selectionFor({}, -1)).toEqual([]);
  });

  it("toggles, selects all and recognizes all", () => {
    expect(toggleFolder([], "g1")).toEqual(["g1"]);
    expect(toggleFolder(["g1", "g2"], "g1")).toEqual(["g2"]);
    expect(allFolders(FOLDERS)).toEqual(["g1", "g2"]);
    expect(isAllSelected(["g2", "g1"], FOLDERS)).toBe(true);
    expect(isAllSelected(["g1"], FOLDERS)).toBe(false);
    expect(isAllSelected([], [])).toBe(false);
  });

  it("drops grants that no longer exist (never widens)", () => {
    expect(pruneSelection(["g2", "gone", "g1"], FOLDERS)).toEqual(["g1", "g2"]);
  });

  it("moves the blank chat's selection onto the new conversation", () => {
    expect(adoptSelection({ "-1": ["g1"], "3": ["g2"] }, -1, 9)).toEqual({ "3": ["g2"], "9": ["g1"] });
    expect(adoptSelection({ "3": ["g2"] }, -1, 9)).toEqual({ "3": ["g2"] });
  });

  it("remembers real conversations only and survives corrupt storage", () => {
    saveSelections({ "-1": ["g1"], "4": ["g2"], "5": [] });
    expect(loadSelections()).toEqual({ "4": ["g2"], "5": [] });
    window.localStorage.setItem(FOLDER_SELECTION_STORAGE_KEY, "not json");
    expect(loadSelections()).toEqual({});
    window.localStorage.setItem(FOLDER_SELECTION_STORAGE_KEY, JSON.stringify({ "4": ["g1", 3] }));
    expect(loadSelections()).toEqual({ "4": ["g1"] });
  });
});
