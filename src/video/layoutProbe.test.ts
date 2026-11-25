// Round 25: the shared layout probe (src-tauri/src/video/layout_probe.js),
// the one script the app (hidden frame) and CI (template layout check) run.
// jsdom has no layout: element boxes are stubbed, the logic is real.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import probeSource from "../../src-tauri/src/video/layout_probe.js?raw";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
interface Sample {
  scene: string;
  t: number;
  settled: boolean;
}
interface Probe {
  MARGIN: number;
  MAX_SAMPLES: number;
  samplePlan: (scenes: { id: string; start: number; duration: number }[], total: number, max?: number) => Sample[];
  classify: (box: Box, W: number, H: number, margin: number | null, settled: boolean) => string | null;
  hint: (el: Element) => string;
  checkAll: (win: unknown, config: unknown) => Promise<{ issues: Record<string, unknown>[]; complete: boolean }>;
  run: (config: unknown) => void;
}
let probe: Probe;

beforeAll(() => {
  new Function(probeSource)();
  probe = (window as unknown as { __nanLayoutProbe: Probe }).__nanLayoutProbe;
});

afterEach(() => {
  document.body.innerHTML = "";
  delete (window as unknown as Record<string, unknown>).__player;
  delete (window as unknown as Record<string, unknown>).__playerReady;
});

describe("samplePlan", () => {
  it("looks at three moments and the settled end of every scene", () => {
    const plan = probe.samplePlan(
      [
        { id: "intro", start: 0, duration: 2 },
        { id: "outro", start: 2, duration: 4 },
      ],
      6,
    );
    expect(plan).toEqual([
      { scene: "intro", t: 0.5, settled: false },
      { scene: "intro", t: 1, settled: false },
      { scene: "intro", t: 1.5, settled: false },
      { scene: "intro", t: 1.85, settled: true },
      { scene: "outro", t: 3, settled: false },
      { scene: "outro", t: 4, settled: false },
      { scene: "outro", t: 5, settled: false },
      { scene: "outro", t: 5.85, settled: true },
    ]);
  });

  it("stays inside the film and skips empty scenes", () => {
    const plan = probe.samplePlan(
      [
        { id: "a", start: 0, duration: 0.1 },
        { id: "b", start: 0.1, duration: 0 },
      ],
      0.1,
    );
    expect(plan.every((p) => p.t >= 0 && p.t <= 0.05 + 1e-9)).toBe(true);
    expect(plan.some((p) => p.scene === "b")).toBe(false);
  });

  it("samples a long video more sparsely, never past the cap, every settled end first", () => {
    const scenes = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, start: i * 3, duration: 3 }));
    const plan = probe.samplePlan(scenes, 90);
    expect(plan.length).toBeLessThanOrEqual(probe.MAX_SAMPLES);
    expect(plan.filter((p) => p.settled).length).toBe(30);
    const times = plan.map((p) => p.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const many = Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, start: i, duration: 1 }));
    const capped = probe.samplePlan(many, 80);
    expect(capped.length).toBe(probe.MAX_SAMPLES);
    expect(capped.every((p) => p.settled)).toBe(true);
  });
});

describe("classify", () => {
  const W = 1080;
  const H = 1080;
  it("passes what sits inside the safe margin", () => {
    expect(probe.classify({ left: 100, top: 100, right: 980, bottom: 300 }, W, H, null, true)).toBeNull();
  });
  it("flags what touches or crosses an edge while partly in frame (cut off)", () => {
    expect(probe.classify({ left: -200, top: 400, right: 900, bottom: 500 }, W, H, null, false)).toBe("clipped");
    expect(probe.classify({ left: 100, top: 400, right: 1075, bottom: 500 }, W, H, null, false)).toBe("clipped");
    expect(probe.classify({ left: 100, top: 1060, right: 300, bottom: 1200 }, W, H, null, true)).toBe("clipped");
  });
  it("allows an element fully off frame mid-scene (an entrance) but not once the scene settled", () => {
    const outside = { left: 1200, top: 100, right: 1500, bottom: 200 };
    expect(probe.classify(outside, W, H, null, false)).toBeNull();
    expect(probe.classify(outside, W, H, null, true)).toBe("offframe");
  });
  it("ignores empty boxes", () => {
    expect(probe.classify({ left: -10, top: 0, right: -9.5, bottom: 20 }, W, H, null, true)).toBeNull();
  });
});

describe("hint", () => {
  it("names the element and the start of its text", () => {
    document.body.innerHTML = '<h1 id="intro-title">  Hola   mundo </h1><p class="intro-sub x">Sub</p><span></span>';
    expect(probe.hint(document.getElementById("intro-title")!)).toBe('#intro-title "Hola mundo"');
    expect(probe.hint(document.querySelector("p")!)).toBe('.intro-sub "Sub"');
    expect(probe.hint(document.querySelector("span")!)).toBe("span");
  });
});

/// A fake runtime: the title's box depends on the playhead.
function stage(boxAt: (t: number) => Box) {
  document.body.innerHTML =
    '<div id="root"><img id="intro-logo" src="x.png" alt=""><img id="intro-hidden" style="opacity:0" src="y.png" alt=""></div>';
  let now = 0;
  const player = { pause: vi.fn(), seek: vi.fn((t: number) => (now = t)), getDuration: () => 4 };
  const logo = document.getElementById("intro-logo")!;
  logo.getBoundingClientRect = () => ({ ...boxAt(now), x: 0, y: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const hidden = document.getElementById("intro-hidden")!;
  hidden.getBoundingClientRect = () => ({ left: -500, top: 0, right: 10, bottom: 10, x: 0, y: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  const win = {
    __player: player,
    __playerReady: true,
    document,
    innerWidth: 1080,
    innerHeight: 1080,
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
  };
  return { win, player };
}

const SCENES = [
  { id: "intro", start: 0, duration: 2 },
  { id: "outro", start: 2, duration: 2 },
];

describe("checkAll", () => {
  it("reports each broken element once, with its scene, time and kind", async () => {
    // Fine in the intro; the outro pushes it past the right edge.
    const { win, player } = stage((t) =>
      t < 2 ? { left: 100, top: 100, right: 500, bottom: 300 } : { left: 700, top: 100, right: 1400, bottom: 300 },
    );
    const result = await probe.checkAll(win, { scenes: SCENES, total: 4, budgetMs: 5000 });
    expect(result.complete).toBe(true);
    expect(result.issues).toEqual([{ scene: "outro", time: 2.5, kind: "clipped", element: "#intro-logo", box: [700, 100, 1400, 300] }]);
    expect(player.pause).toHaveBeenCalled();
    expect(player.seek.mock.calls.map((c) => c[0])).toEqual([0.5, 1, 1.5, 1.85, 2.5, 3, 3.5, 3.85]);
  });

  it("finds nothing in a layout that fits", async () => {
    const { win } = stage(() => ({ left: 100, top: 100, right: 500, bottom: 300 }));
    expect(await probe.checkAll(win, { scenes: SCENES, total: 4 })).toEqual({ issues: [], complete: true });
  });

  it("gives up when the runtime never gets ready", async () => {
    const { win } = stage(() => ({ left: 0, top: 0, right: 1, bottom: 1 }));
    win.__playerReady = false;
    await expect(probe.checkAll(win, { scenes: SCENES, total: 4, budgetMs: 120 })).rejects.toThrow("runtime_not_ready");
  });

  it("stops at its budget and says the check is incomplete", async () => {
    const { win } = stage(() => ({ left: 100, top: 100, right: 500, bottom: 300 }));
    const realNow = Date.now;
    let calls = 0;
    // Every clock read moves the time on by a second.
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 1000 * calls++);
    const result = await probe.checkAll(win, { scenes: SCENES, total: 4, budgetMs: 4500 });
    vi.restoreAllMocks();
    expect(result.complete).toBe(false);
  });
});

describe("run", () => {
  it("posts the findings to the parent frame", async () => {
    const { player } = stage(() => ({ left: 700, top: 100, right: 1400, bottom: 300 }));
    Object.assign(window, { __player: player, __playerReady: true });
    const got = new Promise<unknown>((resolve) => window.addEventListener("message", (e) => resolve(e.data), { once: true }));
    probe.run({ scenes: [{ id: "intro", start: 0, duration: 4 }], total: 4, budgetMs: 5000 });
    const data = (await got) as { type: string; issues: unknown[]; complete: boolean };
    expect(data.type).toBe("nan-layout-probe");
    expect(data.complete).toBe(true);
    // jsdom's window is 1024x768: the logo crosses its right edge.
    expect(data.issues.length).toBe(1);
  });

  it("posts an error instead of throwing", async () => {
    const got = new Promise<unknown>((resolve) => window.addEventListener("message", (e) => resolve(e.data), { once: true }));
    Object.assign(window, { __playerReady: false });
    probe.run({ scenes: [], total: 1, budgetMs: 60 });
    expect(await got).toEqual({ type: "nan-layout-probe", error: "runtime_not_ready" });
  });
});
