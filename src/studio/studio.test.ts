import { describe, expect, it } from "vitest";
import {
  MAX_EDIT_IMAGES,
  MAX_EDIT_INSTRUCTION,
  MAX_REFERENCES,
  addReference,
  afterEdit,
  canSubmit,
  editSources,
  instructionLength,
  isEditableImagePath,
  removeReference,
  type HistoryNode,
  type StudioImage,
} from "./studio";

const chat = (name: string, messageId: number): StudioImage => ({
  path: `/data/images/${name}.png`,
  label: name,
  messageId,
  staged: false,
});
const staged = (name: string): StudioImage => ({
  path: `/data/images/staged/${name}.jpg`,
  label: `${name}.jpg`,
  messageId: null,
  staged: true,
});

describe("the reference tray", () => {
  it("holds the base plus at most two references (three images per edit)", () => {
    expect(MAX_EDIT_IMAGES).toBe(3);
    expect(MAX_REFERENCES).toBe(2);
    const base = chat("fox", 2);
    let refs = addReference([], base, staged("a"));
    refs = addReference(refs, base, staged("b"));
    expect(refs.map((r) => r.label)).toEqual(["a.jpg", "b.jpg"]);
    expect(addReference(refs, base, staged("c"))).toEqual(refs);
  });

  it("ignores duplicates and the base itself", () => {
    const base = chat("fox", 2);
    const refs = addReference([], base, staged("a"));
    expect(addReference(refs, base, staged("a"))).toHaveLength(1);
    expect(addReference(refs, base, base)).toHaveLength(1);
  });

  it("removes by path and never mutates its input", () => {
    const refs = [staged("a"), staged("b")];
    const next = removeReference(refs, staged("a").path);
    expect(next.map((r) => r.label)).toEqual(["b.jpg"]);
    expect(refs).toHaveLength(2);
  });
});

describe("submitting", () => {
  it("needs a base and a non-blank instruction within the cap, and nothing running", () => {
    const base = chat("fox", 2);
    expect(canSubmit(base, "snow", false)).toBe(true);
    expect(canSubmit(null, "snow", false)).toBe(false);
    expect(canSubmit(base, "   ", false)).toBe(false);
    expect(canSubmit(base, "snow", true)).toBe(false);
    expect(canSubmit(base, "x".repeat(MAX_EDIT_INSTRUCTION), false)).toBe(true);
    expect(canSubmit(base, "x".repeat(MAX_EDIT_INSTRUCTION + 1), false)).toBe(false);
  });

  it("counts code points like the platform", () => {
    expect(instructionLength("🦊🦊")).toBe(2);
    expect(canSubmit(chat("fox", 2), "🦊".repeat(MAX_EDIT_INSTRUCTION), false)).toBe(true);
  });

  it("sends the base first, then the references", () => {
    expect(editSources(chat("fox", 2), [staged("a")])).toEqual(["/data/images/fox.png", "/data/images/staged/a.jpg"]);
  });
});

describe("after an edit", () => {
  it("appends the result as the new base and keeps every staged file reusable", () => {
    const original = staged("orig");
    const history: HistoryNode[] = [{ image: original }];
    const refs = [staged("ref"), chat("fox", 2)];
    const result = chat("result", 9);
    const next = afterEdit(history, refs, result);
    expect(next.base).toBe(result);
    // Staged copies persist for the Studio session: the original node stays
    // a plain, selectable node and the references stay for the next edit.
    expect(next.history).toEqual([{ image: original }, { image: result }]);
    expect(next.refs).toEqual(refs);
    // The previous base can be picked again and sent as a source.
    expect(editSources(next.history[0].image, next.refs)).toEqual([original.path, refs[0].path, refs[1].path]);
  });

  it("never duplicates the result as a reference and never mutates its input", () => {
    const result = chat("result", 9);
    const history: HistoryNode[] = [{ image: chat("fox", 2) }];
    const refs = [result, staged("a")];
    const next = afterEdit(history, refs, result);
    expect(next.refs.map((r) => r.path)).toEqual([staged("a").path]);
    expect(history).toHaveLength(1);
    expect(refs).toHaveLength(2);
  });
});

describe("what the editor can take", () => {
  it("accepts PNG, JPEG and WebP only", () => {
    for (const path of ["/a/b.png", "/a/b.JPG", "/a/b.jpeg", "/a/b.webp"]) expect(isEditableImagePath(path)).toBe(true);
    for (const path of ["/a/b.gif", "/a/b.bmp", "/a/b.avif", "/a/png", "/a/b.png.txt"]) {
      expect(isEditableImagePath(path)).toBe(false);
    }
  });
});
