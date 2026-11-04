import { describe, expect, it } from "vitest";
import { MAX_EDIT_IMAGES, addSource, canSubmitEdit, parentMessageId, removeSource, type EditSource } from "./editTray";

const chat = (id: number): EditSource => ({ path: `/data/images/${id}.png`, label: `img ${id}`, messageId: id });
const picked = (name: string): EditSource => ({ path: `/data/images/staged/${name}`, label: name, messageId: null });

describe("edit tray", () => {
  it("adds up to three images and never duplicates one", () => {
    let list: EditSource[] = [];
    list = addSource(list, chat(1));
    list = addSource(list, chat(1));
    expect(list).toHaveLength(1);
    list = addSource(list, picked("a.jpg"));
    list = addSource(list, chat(2));
    expect(list).toHaveLength(MAX_EDIT_IMAGES);
    list = addSource(list, chat(3));
    expect(list.map((item) => item.path)).toEqual([chat(1).path, picked("a.jpg").path, chat(2).path]);
  });

  it("removes by path", () => {
    const list = [chat(1), picked("a.jpg")];
    expect(removeSource(list, chat(1).path)).toEqual([picked("a.jpg")]);
    expect(removeSource(list, "/nope")).toEqual(list);
  });

  it("links the edit to the first chat image", () => {
    expect(parentMessageId([])).toBeNull();
    expect(parentMessageId([picked("a.jpg")])).toBeNull();
    expect(parentMessageId([picked("a.jpg"), chat(4), chat(5)])).toBe(4);
  });

  it("submits only with images, a bounded instruction and nothing running", () => {
    expect(canSubmitEdit([], "snow", false)).toBe(false);
    expect(canSubmitEdit([chat(1)], "   ", false)).toBe(false);
    expect(canSubmitEdit([chat(1)], "snow", true)).toBe(false);
    expect(canSubmitEdit([chat(1)], "snow", false)).toBe(true);
    expect(canSubmitEdit([chat(1)], "a".repeat(2000), false)).toBe(true);
    expect(canSubmitEdit([chat(1)], "a".repeat(2001), false)).toBe(false);
    expect(canSubmitEdit([chat(1), chat(2), chat(3), chat(4)], "snow", false)).toBe(false);
  });
});
