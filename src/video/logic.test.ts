// R-V1: the editor's pure logic and every export message.
import { afterEach, describe, expect, it, vi } from "vitest";
import { en as enStrings } from "../i18n/en";
import { es } from "../i18n/es";
import { formatDuration } from "./api";
import {
  changeRequest,
  exportCharge,
  exportErrorMessage,
  groupVariables,
  moveScene,
  parseDuration,
  quotaLine,
  rememberRender,
  rememberedRender,
  sceneAt,
  sceneWindows,
  shortDate,
  uploadTooSlow,
} from "./logic";

const SCENES = [
  { id: "intro", title: "Inicio", duration: 3 },
  { id: "body", title: "", duration: 4.5 },
  { id: "cta", title: "Cierre", duration: 2.5 },
];

afterEach(() => vi.restoreAllMocks());

describe("scene timing and order", () => {
  it("lays scenes back to back and finds the one showing", () => {
    expect(sceneWindows(SCENES).map((w) => [w.start, w.end])).toEqual([
      [0, 3],
      [3, 7.5],
      [7.5, 10],
    ]);
    expect(sceneAt(SCENES, 0)).toBe(0);
    expect(sceneAt(SCENES, 3)).toBe(1);
    expect(sceneAt(SCENES, 9.99)).toBe(2);
    expect(sceneAt(SCENES, 50)).toBe(2);
    expect(sceneAt([], 1)).toBe(0);
  });

  it("moves a scene and clamps at the ends", () => {
    expect(moveScene(SCENES, 2, -1).map((s) => s.id)).toEqual(["intro", "cta", "body"]);
    expect(moveScene(SCENES, 0, -1)).toBe(SCENES);
    expect(moveScene(SCENES, 0, 5).map((s) => s.id)).toEqual(["body", "cta", "intro"]);
    expect(SCENES.map((s) => s.id)).toEqual(["intro", "body", "cta"]);
  });

  it("parses typed durations within the limits", () => {
    expect(parseDuration("2,5")).toBe(2.5);
    expect(parseDuration("0")).toBe(0.5);
    expect(parseDuration("999")).toBe(120);
    expect(parseDuration("abc")).toBeNull();
  });
});

describe("Ask for a change in this scene", () => {
  it("shows a plain request and attaches the technical context for the model", () => {
    const video = { id: "0123456789abcdef0123456789abcdef", title: "Promo" };
    expect(changeRequest(es, video, SCENES, 1, 5)).toEqual({
      text: "Escena «Escena 2» (0:03 a 0:07): ",
      context: {
        project_id: video.id,
        title: "Promo",
        scene_id: "body",
        scene_title: "Escena 2",
        from: 3,
        to: 7.5,
        at: 5,
      },
    });
    const en = changeRequest(enStrings, video, SCENES, 0, 9)!;
    expect(en.text).toBe('Scene "Inicio" (0:00 to 0:03): ');
    expect(en.context.at).toBeUndefined();
    expect(en.text).not.toContain(video.id);
    expect(changeRequest(es, video, SCENES, 9, null)).toBeNull();
  });
});

describe("fields grouped by scene", () => {
  it("puts a field in its only scene and shared ones under General", () => {
    const sources = [
      { id: "intro", html: '<h1 data-var-text="headline">x</h1><p style="color:var(--accent)">' },
      { id: "chart", html: '<span data-var-text="bar-1">x</span><div style="width:calc(var(--bar-1-amount) * 1%)">' },
      { id: "cta", html: '<img data-var-src="logo"><p style="color:var(--accent)">' },
    ];
    const vars = ["headline", "bar-1", "bar-1-amount", "accent", "logo", "unused"].map((id) => ({ id }));
    const groups = groupVariables(vars, [
      { id: "intro", title: "Inicio" },
      { id: "chart", title: "Datos" },
      { id: "cta", title: "Cierre" },
    ], sources);
    expect(groups.map((g) => [g.title, g.variables.map((v) => v.id)])).toEqual([
      ["Inicio", ["headline"]],
      ["Datos", ["bar-1", "bar-1-amount"]],
      ["Cierre", ["logo"]],
      [null, ["accent", "unused"]],
    ]);
  });
});

describe("export copy", () => {
  it("states the remaining export time in plain words", () => {
    expect(quotaLine(es, 5040)).toBe("Te quedan 84 min de exportación este mes");
    expect(quotaLine(es, 5099)).toBe("Te quedan 84 min de exportación este mes");
    expect(quotaLine(es, 42)).toBe("Te quedan 42 s de exportación este mes");
    expect(quotaLine(es, 0)).toBe("Te quedan 0 min de exportación este mes");
    expect(quotaLine(enStrings, 7200)).toBe("You have 120 min of export time left this month");
  });

  it("has a clear message for every error the API and the core return", () => {
    const kinds = [
      "subscription_required",
      "too_large",
      "invalid_project",
      "too_many_active",
      "canceled",
      "upload_failed",
      "render_failed",
      "timeout",
      "not_found",
      "no_session",
      "offline",
      "expired",
      "busy",
      "unavailable",
    ];
    const seen = new Set<string>();
    for (const kind of kinds) {
      const message = exportErrorMessage(es, "es", { kind });
      expect(message).not.toBe(es.video.errors.generic);
      seen.add(message);
    }
    expect(seen.size).toBe(kinds.length);
    expect(exportErrorMessage(es, "es", { kind: "weird" })).toBe(es.video.errors.generic);
    expect(exportErrorMessage(es, "es", { kind: "too_large" })).toContain("90 MB");
    expect(exportErrorMessage(es, "es", { kind: "rate_limited", retry_after: 30 })).toContain("30 s");
    expect(exportErrorMessage(es, "es", { kind: "rate_limited", retry_after: 600 })).toContain("en 10 min.");
    expect(exportErrorMessage(es, "es", { kind: "rate_limited", retry_after: 100 })).toContain("en 2 min.");
    expect(exportErrorMessage(es, "es", { kind: "rate_limited" })).toContain("dentro de un rato");
    const quota = exportErrorMessage(es, "es", {
      kind: "quota_exhausted",
      remaining_seconds: 20,
      period_end: "2026-12-01T10:00:00Z",
    });
    expect(quota).toContain("te quedan 20 s");
    expect(quota).toContain("1 de diciembre");
  });

  it("warns when an upload will not fit the 10 minute window", () => {
    expect(uploadTooSlow(10, 100, 60)).toBe(true); // 600 s projected
    expect(uploadTooSlow(50, 100, 60)).toBe(false); // 120 s projected
    expect(uploadTooSlow(1, 100, 3)).toBe(false); // too early to judge
    expect(uploadTooSlow(100, 100, 900)).toBe(false); // already sent
    expect(es.video.errors.no_session).toContain("Vuelve a iniciar sesión");
  });

  it("writes lengths as 15 s / 1 min 30 s and charges whole seconds", () => {
    expect(formatDuration(15)).toBe("15 s");
    expect(formatDuration(90)).toBe("1 min 30 s");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(0)).toBe("0 s");
    expect(exportCharge(29.2)).toBe(30);
  });

  it("formats renewal dates and ignores bad ones", () => {
    expect(shortDate("2026-12-01T10:00:00Z", "en")).toBe("1 December");
    expect(shortDate("nope", "es")).toBeNull();
    expect(shortDate(null, "es")).toBeNull();
  });
});

describe("render ids survive a reopen", () => {
  it("remembers, forgets and refuses malformed ids", () => {
    rememberRender("p1", "r-1_a");
    expect(rememberedRender("p1")).toBe("r-1_a");
    rememberRender("p1", null);
    expect(rememberedRender("p1")).toBeNull();
    localStorage.setItem("video.render.p2", "../x");
    expect(rememberedRender("p2")).toBeNull();
  });

  it("works without storage", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => rememberRender("p3", "r")).not.toThrow();
    expect(rememberedRender("p3")).toBeNull();
  });
});
