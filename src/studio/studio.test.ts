import { describe, expect, it } from "vitest";
import {
  FLUX_MODEL,
  MAX_EDIT_IMAGES,
  MAX_EDIT_INSTRUCTION,
  QWEN_EDIT_MODEL,
  addReference,
  afterEdit,
  canSubmit,
  clearedSession,
  editModelFor,
  needsFolderGrant,
  editSources,
  instructionLength,
  isEditableImagePath,
  maxEditImages,
  maxReferences,
  removeReference,
  type HistoryNode,
  type StudioImage,
} from "./studio";

const QWEN_REFS = maxReferences(QWEN_EDIT_MODEL);

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

describe("the edit model and its cap", () => {
  it("follows the tenant: qwen on the community, FLUX on the enterprise", () => {
    expect(editModelFor("nan")).toBe("qwen-image-3.0-pro");
    expect(editModelFor("helmcode")).toBe("flux-3-image-klein");
    expect(FLUX_MODEL).toBe("flux-3-image-klein");
  });

  it("qwen takes three images (base + 2), FLUX only the base, unknown models the strictest", () => {
    expect(MAX_EDIT_IMAGES).toBe(3);
    expect(maxEditImages(QWEN_EDIT_MODEL)).toBe(3);
    expect(maxReferences(QWEN_EDIT_MODEL)).toBe(2);
    expect(maxEditImages(FLUX_MODEL)).toBe(1);
    expect(maxReferences(FLUX_MODEL)).toBe(0);
    expect(maxEditImages("something-new")).toBe(1);
    expect(maxReferences(editModelFor("unknown"))).toBe(0);
  });
});

describe("the reference tray", () => {
  it("holds the base plus at most two references on qwen (three images per edit)", () => {
    expect(QWEN_REFS).toBe(2);
    const base = chat("fox", 2);
    let refs = addReference([], base, staged("a"), QWEN_REFS);
    refs = addReference(refs, base, staged("b"), QWEN_REFS);
    expect(refs.map((r) => r.label)).toEqual(["a.jpg", "b.jpg"]);
    expect(addReference(refs, base, staged("c"), QWEN_REFS)).toEqual(refs);
  });

  it("takes no reference at all on FLUX", () => {
    const base = chat("fox", 2);
    expect(addReference([], base, staged("a"), maxReferences(FLUX_MODEL))).toEqual([]);
  });

  it("ignores duplicates and the base itself", () => {
    const base = chat("fox", 2);
    const refs = addReference([], base, staged("a"), QWEN_REFS);
    expect(addReference(refs, base, staged("a"), QWEN_REFS)).toHaveLength(1);
    expect(addReference(refs, base, base, QWEN_REFS)).toHaveLength(1);
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
    expect(editSources(chat("fox", 2), [staged("a")], QWEN_REFS)).toEqual([
      "/data/images/fox.png",
      "/data/images/staged/a.jpg",
    ]);
  });

  it("a FLUX edit sends the base alone, whatever the tray held", () => {
    const refs = [staged("a"), staged("b")];
    expect(editSources(chat("fox", 2), refs, maxReferences(FLUX_MODEL))).toEqual(["/data/images/fox.png"]);
    // Never more than the cap on qwen either.
    expect(editSources(chat("fox", 2), [...refs, staged("c")], QWEN_REFS)).toHaveLength(3);
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
    expect(editSources(next.history[0].image, next.refs, QWEN_REFS)).toEqual([
      original.path,
      refs[0].path,
      refs[1].path,
    ]);
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

describe("removing the base", () => {
  it("starts a fresh, empty session with no conversation, base, references or history", () => {
    expect(clearedSession()).toEqual({ conversationId: null, base: null, refs: [], history: [] });
  });

  it("returns a new session every time (no shared arrays)", () => {
    const a = clearedSession();
    const b = clearedSession();
    expect(a).not.toBe(b);
    expect(a.refs).not.toBe(b.refs);
    expect(a.history).not.toBe(b.history);
  });
});

describe("errors a folder grant fixes", () => {
  it("only the grant refusal points to Settings", () => {
    expect(needsFolderGrant("source_not_allowed")).toBe(true);
    for (const kind of ["", "unsupported_image", "image_too_large", "protocol", "unauthorized", "server"]) {
      expect(needsFolderGrant(kind)).toBe(false);
    }
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
