// Image Studio region tools: the brush and the rectangle mark WHERE an edit
// applies. The marks live on an overlay layer above the base image (never
// baked into it); on submit they are composited onto a COPY of the base,
// which is sent as a second image next to the untouched base, with a fixed
// instruction suffix that points the model at the magenta area.
//
// Everything here is pure (or takes its canvas context as an argument) so
// the tool state machine and the compositing are unit-tested apart from the
// component. Coordinates are always in the base image's own pixels.

/// The mark colour (magenta): rare in photos, easy for the model to spot.
export const MARK_COLOR = "#ff00ff";
/// Brush strokes are painted semi-transparent so the user still sees what
/// is underneath; the model reads the tint.
export const BRUSH_ALPHA = 0.4;
/// Brush diameter and rectangle outline, in SCREEN pixels at the time of
/// drawing (converted to image pixels with the current zoom).
export const BRUSH_SCREEN_PX = 24;
export const RECT_SCREEN_PX = 3;
/// A rectangle smaller than this (image pixels, either side) is a click,
/// not a drag: it never replaces the current rectangle.
export const MIN_RECT_PX = 2;

export type Tool = "brush" | "rect";

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  points: Point[];
  /// Line width in image pixels.
  width: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /// Outline width in image pixels.
  width: number;
}

export interface Marks {
  strokes: Stroke[];
  rect: Rect | null;
}

type Drag = { kind: "brush" } | { kind: "rect"; origin: Point; width: number };

export interface ToolState {
  /// The one active tool, or none (the canvas is view-only).
  tool: Tool | null;
  marks: Marks;
  drag: Drag | null;
}

export type ToolAction =
  /// Toolbar button: picking the active tool again turns it off.
  | { type: "select"; tool: Tool }
  /// Pointer down / move / up on the overlay, in image pixels. `scale` is
  /// image pixels per screen pixel (sizes follow the zoom).
  | { type: "down"; point: Point; scale: number }
  | { type: "move"; point: Point }
  | { type: "up" }
  /// "Clear marks": the marks go, the tool stays.
  | { type: "clear" }
  /// The base image changed: everything goes, no tool active.
  | { type: "reset" };

export const EMPTY_MARKS: Marks = { strokes: [], rect: null };
export const INITIAL_TOOL_STATE: ToolState = { tool: null, marks: EMPTY_MARKS, drag: null };

export function hasMarks(marks: Marks): boolean {
  return marks.rect !== null || marks.strokes.length > 0;
}

/// The rectangle spanned by two corners, in any drag direction.
export function rectFrom(a: Point, b: Point, width: number): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y), width };
}

export function toolReducer(state: ToolState, action: ToolAction): ToolState {
  switch (action.type) {
    case "select":
      return { ...state, tool: state.tool === action.tool ? null : action.tool, drag: null };
    case "clear":
      return { ...state, marks: EMPTY_MARKS, drag: null };
    case "reset":
      return INITIAL_TOOL_STATE;
    case "up":
      return state.drag ? { ...state, drag: null } : state;
    case "down": {
      if (state.tool === "brush") {
        const stroke: Stroke = { points: [action.point], width: BRUSH_SCREEN_PX * action.scale };
        return { ...state, marks: { ...state.marks, strokes: [...state.marks.strokes, stroke] }, drag: { kind: "brush" } };
      }
      if (state.tool === "rect") {
        // The current rectangle stays until the drag has a real size.
        return { ...state, drag: { kind: "rect", origin: action.point, width: RECT_SCREEN_PX * action.scale } };
      }
      return state;
    }
    case "move": {
      const drag = state.drag;
      if (!drag) return state;
      if (drag.kind === "brush") {
        const strokes = state.marks.strokes;
        const last = strokes[strokes.length - 1];
        if (!last) return state;
        const tail = last.points[last.points.length - 1];
        if (tail && tail.x === action.point.x && tail.y === action.point.y) return state;
        const grown: Stroke = { ...last, points: [...last.points, action.point] };
        return { ...state, marks: { ...state.marks, strokes: [...strokes.slice(0, -1), grown] } };
      }
      const rect = rectFrom(drag.origin, action.point, drag.width);
      if (rect.w < MIN_RECT_PX || rect.h < MIN_RECT_PX) return state;
      // One rectangle at a time: a new drag replaces the previous one.
      return { ...state, marks: { ...state.marks, rect } };
    }
  }
}

/// A screen point on the overlay element (client coordinates) in image
/// pixels, clamped to the image. Returns the point and the scale (image
/// pixels per screen pixel), or null while the overlay has no size.
export function toImagePoint(
  client: Point,
  box: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
): { point: Point; scale: number } | null {
  if (box.width <= 0 || box.height <= 0 || natural.width <= 0 || natural.height <= 0) return null;
  const scale = natural.width / box.width;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return {
    point: {
      x: clamp((client.x - box.left) * scale, natural.width),
      y: clamp((client.y - box.top) * (natural.height / box.height), natural.height),
    },
    scale,
  };
}

/// The subset of CanvasRenderingContext2D the painting uses (a recording
/// fake in tests, the real 2D context in the app).
export interface PaintContext {
  globalAlpha: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void;
}

/// Paint the marks: brush strokes as ONE path per line width (a single
/// stroke() call fills overlaps once, so the tint stays even), then the
/// rectangle outline at full strength.
export function paintMarks(ctx: PaintContext, marks: Marks): void {
  if (marks.strokes.length > 0) {
    ctx.save();
    ctx.globalAlpha = BRUSH_ALPHA;
    ctx.strokeStyle = MARK_COLOR;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const widths = [...new Set(marks.strokes.map((stroke) => stroke.width))];
    for (const width of widths) {
      ctx.beginPath();
      for (const stroke of marks.strokes) {
        if (stroke.width !== width || stroke.points.length === 0) continue;
        const [first, ...rest] = stroke.points;
        ctx.moveTo(first.x, first.y);
        // A click is a dot: a tiny segment so the round cap shows.
        if (rest.length === 0) ctx.lineTo(first.x + 0.01, first.y);
        for (const point of rest) ctx.lineTo(point.x, point.y);
      }
      ctx.lineWidth = width;
      ctx.stroke();
    }
    ctx.restore();
  }
  if (marks.rect) {
    const { x, y, w, h, width } = marks.rect;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = MARK_COLOR;
    ctx.lineWidth = width;
    ctx.lineJoin = "miter";
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

/// The annotated copy: the base at its own size, then the marks on top.
export function composeAnnotated(
  ctx: PaintContext,
  base: CanvasImageSource,
  size: { width: number; height: number },
  marks: Marks,
): void {
  ctx.drawImage(base, 0, 0, size.width, size.height);
  paintMarks(ctx, marks);
}

/// The instruction sent with an annotated edit: the user's own words first,
/// then the fixed pointer to the marked area.
export function annotatedInstruction(text: string, suffix: string): string {
  return `${text.trim()}\n\n${suffix}`;
}

/// Characters the suffix (and its separator) takes from the instruction cap.
export function reservedForSuffix(suffix: string): number {
  return [...suffix].length + 2;
}

/// Render the annotated copy of `src` (asset URL of the base) as PNG and
/// return its base64 (no data: prefix). The image is loaded with CORS so the
/// canvas stays readable (the asset protocol answers with the window origin).
export async function renderAnnotatedPng(
  src: string,
  size: { width: number; height: number },
  marks: Marks,
): Promise<string> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = src;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("protocol");
  composeAnnotated(ctx, image, size, marks);
  const url = canvas.toDataURL("image/png");
  const comma = url.indexOf(",");
  if (!url.startsWith("data:image/png") || comma < 0) throw new Error("protocol");
  return url.slice(comma + 1);
}
