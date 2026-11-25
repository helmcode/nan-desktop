// Round 25: the renderer's side of the layout check: one hidden, sandboxed
// frame per aspect, only that frame's answer counts, everything is cleaned
// up, and a check that cannot run never claims a problem.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const videoLayoutProbe = vi.fn();
const releaseSitePreview = vi.fn();
vi.mock("./api", () => ({ videoLayoutProbe: (...a: unknown[]) => videoLayoutProbe(...a) }));
vi.mock("../core", () => ({ releaseSitePreview: (...a: unknown[]) => releaseSitePreview(...a) }));

import {
  brokenAspects,
  checkAspect,
  checkLayout,
  layoutProblems,
  parseProbeMessage,
  PROBE_MESSAGE,
  type LayoutIssue,
} from "./layoutCheck";

const info = (aspect: string) => ({
  url: `nan-site://localhost/${aspect.replace(":", "")}`,
  title: "Promo",
  width: aspect === "16:9" ? 1920 : 1080,
  height: aspect === "9:16" ? 1920 : 1080,
  fps: 30,
  duration: 4,
  aspect,
});

const issue = (over: Partial<LayoutIssue> = {}): LayoutIssue => ({
  scene: "intro",
  time: 1.5,
  kind: "clipped",
  element: '#intro-title "Hola"',
  ...over,
});

/// The hidden frame the check is waiting on.
async function frame(): Promise<HTMLIFrameElement> {
  await vi.waitFor(() => expect(document.querySelector(".video-layout-probe iframe")).not.toBeNull());
  return document.querySelector<HTMLIFrameElement>(".video-layout-probe iframe")!;
}

function post(source: Window | null, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

beforeEach(() => {
  videoLayoutProbe.mockImplementation(async (_p: string, _id: string, aspect: string) => info(aspect));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("parseProbeMessage", () => {
  it("keeps well-formed issues and drops junk", () => {
    expect(
      parseProbeMessage({
        type: PROBE_MESSAGE,
        complete: true,
        issues: [issue(), { scene: "x", time: -1, kind: "clipped", element: "a" }, { scene: "x", time: 1, kind: "evil", element: "a" }, "nope", null],
      }),
    ).toEqual([issue()]);
  });

  it("cleans the composition's text (controls, bidi, length)", () => {
    const [found] = parseProbeMessage({
      type: PROBE_MESSAGE,
      complete: true,
      issues: [issue({ element: `#t "a‮b\n  c${"x".repeat(500)}` })],
    })!;
    expect(found.element).not.toMatch(/[‮\n]/);
    expect(found.element.startsWith('#t "a b c')).toBe(true);
    expect(found.element.length).toBe(120);
  });

  it("an error, another message or a cut-short check with no finding is not a report", () => {
    expect(parseProbeMessage({ type: PROBE_MESSAGE, error: "runtime_not_ready" })).toBeNull();
    expect(parseProbeMessage({ type: "composition_loaded", issues: [] })).toBeNull();
    expect(parseProbeMessage({ type: PROBE_MESSAGE, complete: false, issues: [] })).toBeNull();
    expect(parseProbeMessage({ type: PROBE_MESSAGE, complete: false, issues: [issue()] })).toEqual([issue()]);
    expect(parseProbeMessage({ type: PROBE_MESSAGE, complete: true, issues: [] })).toEqual([]);
  });

  it("caps the number of issues", () => {
    const many = Array.from({ length: 100 }, (_, i) => issue({ time: i }));
    expect(parseProbeMessage({ type: PROBE_MESSAGE, complete: true, issues: many })).toHaveLength(40);
  });
});

describe("checkAspect", () => {
  it("loads the probe in a hidden, sandboxed frame sized to the canvas and returns its answer", async () => {
    const result = checkAspect("nan", "p1", "9:16");
    const el = await frame();
    expect(videoLayoutProbe).toHaveBeenCalledWith("nan", "p1", "9:16");
    expect(el.getAttribute("sandbox")).toBe("allow-scripts");
    expect(el.getAttribute("src")).toBe("nan-site://localhost/916");
    expect(el.style.width).toBe("1080px");
    expect(el.style.height).toBe("1920px");
    const box = el.parentElement!;
    expect(box.getAttribute("aria-hidden")).toBe("true");
    expect(box.style.opacity).toBe("0");
    expect(box.style.overflow).toBe("hidden");
    expect(box.style.pointerEvents).toBe("none");
    post(el.contentWindow, { type: PROBE_MESSAGE, complete: true, issues: [issue()] });
    expect(await result).toEqual([issue()]);
    // Gone and released.
    expect(document.querySelector(".video-layout-probe")).toBeNull();
    expect(releaseSitePreview).toHaveBeenCalledWith("nan-site://localhost/916");
  });

  it("ignores messages from any other frame or window", async () => {
    const result = checkAspect("nan", "p1", "1:1");
    const el = await frame();
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    post(other.contentWindow, { type: PROBE_MESSAGE, complete: true, issues: [issue()] });
    post(window, { type: PROBE_MESSAGE, complete: true, issues: [issue()] });
    post(el.contentWindow, { type: "composition_loaded" });
    post(el.contentWindow, { type: PROBE_MESSAGE, complete: true, issues: [] });
    expect(await result).toEqual([]);
  });

  it("a frame that never answers counts as not checked, and is cleaned up", async () => {
    vi.useFakeTimers();
    const result = checkAspect("nan", "p1", "1:1", 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector(".video-layout-probe iframe")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toBeNull();
    expect(document.querySelector(".video-layout-probe")).toBeNull();
    expect(releaseSitePreview).toHaveBeenCalled();
  });

  it("a project the core cannot assemble counts as not checked", async () => {
    videoLayoutProbe.mockRejectedValueOnce({ kind: "invalid" });
    expect(await checkAspect("nan", "p1", "1:1")).toBeNull();
    expect(document.querySelector(".video-layout-probe")).toBeNull();
  });
});

describe("checkLayout", () => {
  it("checks the aspects one after another, never two frames at once", async () => {
    const report = checkLayout("nan", "p1", ["9:16", "1:1"]);
    const first = await frame();
    expect(document.querySelectorAll(".video-layout-probe iframe")).toHaveLength(1);
    expect(first.getAttribute("src")).toBe("nan-site://localhost/916");
    post(first.contentWindow, { type: PROBE_MESSAGE, complete: true, issues: [] });
    await vi.waitFor(() => expect(document.querySelector(".video-layout-probe iframe")?.getAttribute("src")).toBe("nan-site://localhost/11"));
    const second = await frame();
    post(second.contentWindow, { type: PROBE_MESSAGE, complete: true, issues: [issue()] });
    expect(await report).toEqual({ "9:16": [], "1:1": [issue()] });
  });

  it("a second check waits for the first (one in the whole app)", async () => {
    const a = checkLayout("nan", "p1", ["1:1"]);
    const b = checkLayout("nan", "p2", ["1:1"]);
    const first = await frame();
    expect(videoLayoutProbe).toHaveBeenCalledTimes(1);
    post(first.contentWindow, { type: PROBE_MESSAGE, complete: true, issues: [] });
    await a;
    await vi.waitFor(() => expect(videoLayoutProbe).toHaveBeenCalledTimes(2));
    const second = await frame();
    post(second.contentWindow, { type: PROBE_MESSAGE, complete: true, issues: [] });
    expect(await b).toEqual({ "1:1": [] });
  });
});

describe("report helpers", () => {
  const report = {
    "16:9": [],
    "9:16": [issue({ scene: "a" }), issue({ scene: "b" })],
    "1:1": [issue({ kind: "offframe", time: 3 })],
  };

  it("lists the broken aspects in the given order; unknown (null) is not broken", () => {
    expect(brokenAspects(report, ["1:1", "16:9", "9:16"])).toEqual(["1:1", "9:16"]);
    expect(brokenAspects({ "1:1": null }, ["1:1"])).toEqual([]);
  });

  it("names every broken format for the assistant, capped", () => {
    const lines = layoutProblems(report, ["16:9", "9:16", "1:1"]);
    expect(lines).toEqual([
      '9:16 (1080x1920): scene a at 1.5 s: #intro-title "Hola" is cut off at the edge of the frame',
      '1:1 (1080x1080): scene intro at 3 s: #intro-title "Hola" is outside the frame when the scene settles',
      '9:16 (1080x1920): scene b at 1.5 s: #intro-title "Hola" is cut off at the edge of the frame',
    ]);
    const many = { "9:16": Array.from({ length: 30 }, () => issue()), "1:1": Array.from({ length: 30 }, () => issue()) };
    const capped = layoutProblems(many, ["9:16", "1:1"]);
    expect(capped).toHaveLength(12);
    expect(capped.filter((l) => l.startsWith("1:1"))).toHaveLength(6);
  });
});
