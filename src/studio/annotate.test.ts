import { describe, expect, it } from "vitest";
import {
  BRUSH_ALPHA,
  BRUSH_SCREEN_PX,
  INITIAL_TOOL_STATE,
  MARK_COLOR,
  RECT_SCREEN_PX,
  annotatedInstruction,
  composeAnnotated,
  hasMarks,
  paintMarks,
  rectFrom,
  reservedForSuffix,
  toImagePoint,
  toolReducer,
  type Marks,
  type PaintContext,
  type ToolAction,
  type ToolState,
} from "./annotate";
import { MAX_EDIT_INSTRUCTION, canSubmit, regionToolsAvailable, sendableReferences, FLUX_MODEL, QWEN_EDIT_MODEL } from "./studio";
import { en } from "../i18n/en";
import { es } from "../i18n/es";

const run = (actions: ToolAction[], from: ToolState = INITIAL_TOOL_STATE): ToolState => actions.reduce(toolReducer, from);
const p = (x: number, y: number) => ({ x, y });

describe("the tool state machine", () => {
  it("starts with no tool and no marks", () => {
    expect(INITIAL_TOOL_STATE.tool).toBeNull();
    expect(hasMarks(INITIAL_TOOL_STATE.marks)).toBe(false);
  });

  it("keeps one tool active at a time; picking it again turns it off", () => {
    expect(run([{ type: "select", tool: "brush" }]).tool).toBe("brush");
    expect(run([{ type: "select", tool: "brush" }, { type: "select", tool: "rect" }]).tool).toBe("rect");
    expect(run([{ type: "select", tool: "rect" }, { type: "select", tool: "rect" }]).tool).toBeNull();
  });

  it("does not draw without a tool", () => {
    const state = run([{ type: "down", point: p(1, 1), scale: 1 }, { type: "move", point: p(9, 9) }, { type: "up" }]);
    expect(state).toEqual(INITIAL_TOOL_STATE);
  });

  it("a brush drag records a stroke sized for the zoom", () => {
    const state = run([
      { type: "select", tool: "brush" },
      { type: "down", point: p(10, 10), scale: 2 },
      { type: "move", point: p(20, 10) },
      { type: "move", point: p(20, 10) },
      { type: "move", point: p(30, 15) },
      { type: "up" },
      // Moves after the release draw nothing.
      { type: "move", point: p(99, 99) },
    ]);
    expect(state.marks.strokes).toEqual([{ points: [p(10, 10), p(20, 10), p(30, 15)], width: BRUSH_SCREEN_PX * 2 }]);
    expect(state.drag).toBeNull();
    expect(hasMarks(state.marks)).toBe(true);
  });

  it("every brush drag adds a stroke", () => {
    const state = run([
      { type: "select", tool: "brush" },
      { type: "down", point: p(1, 1), scale: 1 },
      { type: "up" },
      { type: "down", point: p(5, 5), scale: 1 },
      { type: "move", point: p(6, 6) },
      { type: "up" },
    ]);
    expect(state.marks.strokes.map((s) => s.points.length)).toEqual([1, 2]);
  });

  it("a rectangle drag replaces the previous rectangle, in any direction", () => {
    const first = run([
      { type: "select", tool: "rect" },
      { type: "down", point: p(10, 10), scale: 1 },
      { type: "move", point: p(50, 40) },
      { type: "up" },
    ]);
    expect(first.marks.rect).toEqual({ x: 10, y: 10, w: 40, h: 30, width: RECT_SCREEN_PX });
    const second = run(
      [{ type: "down", point: p(80, 90), scale: 2 }, { type: "move", point: p(60, 70) }, { type: "up" }],
      first,
    );
    expect(second.marks.rect).toEqual({ x: 60, y: 70, w: 20, h: 20, width: RECT_SCREEN_PX * 2 });
  });

  it("a click with the rectangle keeps the current one", () => {
    const drawn = run([
      { type: "select", tool: "rect" },
      { type: "down", point: p(0, 0), scale: 1 },
      { type: "move", point: p(10, 10) },
      { type: "up" },
    ]);
    const clicked = run([{ type: "down", point: p(50, 50), scale: 1 }, { type: "move", point: p(51, 50) }, { type: "up" }], drawn);
    expect(clicked.marks.rect).toEqual(drawn.marks.rect);
  });

  it("brush and rectangle marks live together", () => {
    const state = run([
      { type: "select", tool: "brush" },
      { type: "down", point: p(1, 1), scale: 1 },
      { type: "up" },
      { type: "select", tool: "rect" },
      { type: "down", point: p(0, 0), scale: 1 },
      { type: "move", point: p(10, 10) },
      { type: "up" },
    ]);
    expect(state.marks.strokes).toHaveLength(1);
    expect(state.marks.rect).not.toBeNull();
  });

  it("clear removes the marks and keeps the tool; reset removes everything", () => {
    const drawn = run([{ type: "select", tool: "brush" }, { type: "down", point: p(1, 1), scale: 1 }]);
    const cleared = toolReducer(drawn, { type: "clear" });
    expect(cleared.tool).toBe("brush");
    expect(hasMarks(cleared.marks)).toBe(false);
    expect(cleared.drag).toBeNull();
    expect(toolReducer(drawn, { type: "reset" })).toEqual(INITIAL_TOOL_STATE);
  });

  it("never mutates its input", () => {
    const drawn = run([{ type: "select", tool: "brush" }, { type: "down", point: p(1, 1), scale: 1 }]);
    const snapshot = JSON.stringify(drawn);
    toolReducer(drawn, { type: "move", point: p(2, 2) });
    toolReducer(drawn, { type: "clear" });
    expect(JSON.stringify(drawn)).toBe(snapshot);
  });

  it("rectFrom normalizes the corners", () => {
    expect(rectFrom(p(5, 9), p(1, 2), 3)).toEqual({ x: 1, y: 2, w: 4, h: 7, width: 3 });
  });
});

describe("screen to image coordinates", () => {
  const box = { left: 100, top: 50, width: 200, height: 100 };
  const natural = { width: 1000, height: 500 };

  it("maps through the zoom and reports the scale", () => {
    expect(toImagePoint(p(200, 100), box, natural)).toEqual({ point: p(500, 250), scale: 5 });
  });

  it("clamps to the image", () => {
    expect(toImagePoint(p(0, 0), box, natural)?.point).toEqual(p(0, 0));
    expect(toImagePoint(p(999, 999), box, natural)?.point).toEqual(p(1000, 500));
  });

  it("has no point while the overlay has no size", () => {
    expect(toImagePoint(p(1, 1), { ...box, width: 0 }, natural)).toBeNull();
    expect(toImagePoint(p(1, 1), box, { width: 0, height: 0 })).toBeNull();
  });
});

/// A 2D context that records what was painted, with the state at each call.
function recorder() {
  const calls: { op: string; args: unknown[]; alpha: number; style: unknown; width: number }[] = [];
  const stack: { alpha: number; style: unknown; width: number }[] = [];
  const ctx = {
    globalAlpha: 1,
    strokeStyle: "#000" as PaintContext["strokeStyle"],
    lineWidth: 1,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
  } as PaintContext;
  const record =
    (op: string) =>
    (...args: unknown[]) => {
      calls.push({ op, args, alpha: ctx.globalAlpha, style: ctx.strokeStyle, width: ctx.lineWidth });
    };
  Object.assign(ctx, {
    save: () => stack.push({ alpha: ctx.globalAlpha, style: ctx.strokeStyle, width: ctx.lineWidth }),
    restore: () => {
      const top = stack.pop();
      if (top) {
        ctx.globalAlpha = top.alpha;
        ctx.strokeStyle = top.style as PaintContext["strokeStyle"];
        ctx.lineWidth = top.width;
      }
    },
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    strokeRect: record("strokeRect"),
    drawImage: record("drawImage"),
  });
  return { ctx, calls, ops: () => calls.map((c) => c.op) };
}

describe("painting the marks", () => {
  const marks: Marks = {
    strokes: [
      { points: [p(1, 1), p(5, 5)], width: 24 },
      { points: [p(9, 9)], width: 24 },
      { points: [p(2, 2), p(3, 3)], width: 48 },
    ],
    rect: { x: 10, y: 20, w: 30, h: 40, width: 3 },
  };

  it("paints nothing for no marks", () => {
    const { ctx, calls } = recorder();
    paintMarks(ctx, { strokes: [], rect: null });
    expect(calls).toEqual([]);
  });

  it("brush strokes: one semi-transparent magenta path per width, so overlaps tint once", () => {
    const { ctx, calls } = recorder();
    paintMarks(ctx, { ...marks, rect: null });
    const strokes = calls.filter((c) => c.op === "stroke");
    expect(strokes).toHaveLength(2);
    for (const s of strokes) {
      expect(s.alpha).toBe(BRUSH_ALPHA);
      expect(s.style).toBe(MARK_COLOR);
    }
    expect(strokes.map((s) => s.width)).toEqual([24, 48]);
    expect(BRUSH_ALPHA).toBe(0.4);
    // The first path carries both 24 px strokes, the click as a dot.
    const firstPath = calls.slice(0, calls.findIndex((c) => c.op === "stroke"));
    expect(firstPath.filter((c) => c.op === "moveTo").map((c) => c.args)).toEqual([[1, 1], [9, 9]]);
    expect(firstPath.filter((c) => c.op === "lineTo")).toHaveLength(2);
    // State restored for whatever paints next.
    expect(ctx.globalAlpha).toBe(1);
  });

  it("the rectangle: a 3 px magenta outline at full strength", () => {
    const { ctx, calls } = recorder();
    paintMarks(ctx, { strokes: [], rect: marks.rect });
    expect(calls).toEqual([{ op: "strokeRect", args: [10, 20, 30, 40], alpha: 1, style: MARK_COLOR, width: 3 }]);
  });

  it("the annotated copy is the base at its own size with the marks on top", () => {
    const { ctx, calls, ops } = recorder();
    const base = {} as CanvasImageSource;
    composeAnnotated(ctx, base, { width: 640, height: 480 }, marks);
    expect(calls[0]).toMatchObject({ op: "drawImage", args: [base, 0, 0, 640, 480] });
    expect(ops().filter((op) => op === "drawImage")).toHaveLength(1);
    expect(ops().slice(1)).toContain("stroke");
    expect(ops()[ops().length - 1]).toBe("strokeRect");
  });
});

describe("the annotated instruction", () => {
  const suffix = "Apply the change ONLY inside the area marked in magenta in the second image; do not modify anything outside it.";

  it("puts the user's words first, then the fixed suffix", () => {
    expect(annotatedInstruction("  make it red ", suffix)).toBe(`make it red\n\n${suffix}`);
  });

  it("reserves the suffix in the instruction cap", () => {
    const reserved = reservedForSuffix(suffix);
    const room = MAX_EDIT_INSTRUCTION - reserved;
    const base = { path: "/data/images/a.png", label: "a", messageId: 1, staged: false };
    expect(canSubmit(base, "x".repeat(room), false, reserved)).toBe(true);
    expect(canSubmit(base, "x".repeat(room + 1), false, reserved)).toBe(false);
    expect([...annotatedInstruction("x".repeat(room), suffix)].length).toBe(MAX_EDIT_INSTRUCTION);
  });
});

describe("the region copy in both languages", () => {
  it("carries the fixed suffix, no em dash", () => {
    expect(es.studio.annotationSuffix).toBe(
      "Aplica el cambio SOLO dentro de la zona marcada en magenta de la segunda imagen; no modifiques nada fuera de ella.",
    );
    expect(en.studio.annotationSuffix).toBe(
      "Apply the change ONLY inside the area marked in magenta in the second image; do not modify anything outside it.",
    );
    for (const strings of [en, es]) {
      const s = strings.studio;
      for (const text of [
        s.toolBrush,
        s.toolRegion,
        s.toolBrushHint,
        s.toolRegionHint,
        s.clearMarks,
        s.marksActive,
        s.annotationSuffix,
        s.toolUnavailable("x"),
        s.referenceNotSent("x"),
      ]) {
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toContain(String.fromCharCode(0x2014));
      }
    }
  });
});

describe("what a marked edit can send", () => {
  it("needs a model that takes two images", () => {
    expect(regionToolsAvailable(QWEN_EDIT_MODEL)).toBe(true);
    expect(regionToolsAvailable(FLUX_MODEL)).toBe(false);
  });

  it("the marked copy takes one reference slot", () => {
    expect(sendableReferences(2, false)).toBe(2);
    expect(sendableReferences(2, true)).toBe(1);
    expect(sendableReferences(0, true)).toBe(0);
  });
});
