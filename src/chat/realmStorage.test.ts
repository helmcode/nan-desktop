import { beforeEach, describe, expect, it } from "vitest";
import { realmScopedKey } from "./realmStorage";
import { NUDGE_SHOWN_STORAGE_KEY, loadShownNudges, saveShownNudges } from "./allowNudge";

beforeEach(() => {
  window.localStorage.clear();
});

describe("realm-scoped renderer storage (privacy fix)", () => {
  it("scopes a key by the realm hash and keeps the bare key without one", () => {
    expect(realmScopedKey("k.v1", "0a1b")).toBe("k.v1:0a1b");
    expect(realmScopedKey("k.v1", "")).toBe("k.v1");
    expect(realmScopedKey("k.v1", "a")).not.toBe(realmScopedKey("k.v1", "b"));
  });

  it("keeps the shown allow-mode suggestions per realm", () => {
    saveShownNudges([1, 2], "realm-a");
    expect(loadShownNudges("realm-a")).toEqual([1, 2]);
    // B's conversation 1 has never shown a suggestion.
    expect(loadShownNudges("realm-b")).toEqual([]);
    expect(window.localStorage.getItem(NUDGE_SHOWN_STORAGE_KEY)).toBeNull();
  });
});
