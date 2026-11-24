// R-V1: the player box keeps the video's real ratio. A stage that is
// `width: 100%` + `aspect-ratio` + `max-height` becomes WIDER than the
// ratio once max-height bites (a 9:16 video in the template detail), and
// WebKit (the macOS app) then resolves the player's `height: 100%` from the
// aspect-ratio height instead of the clamped one: the composition is
// centred in a box taller than the stage and its lower half is cropped
// (the brand name and tagline of a vertical template vanish). jsdom has no
// layout, so these tests pin the rules that prevent it; the real-layout
// check of the templates themselves is `node test/template-layout-check.mjs`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/video/video.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/// The declarations of the first rule whose selector is exactly `selector`.
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  expect(match, `rule ${selector}`).not.toBeNull();
  const out: Record<string, string> = {};
  for (const decl of match![2].split(";")) {
    const at = decl.indexOf(":");
    if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim().replace(/\s+/g, " ");
  }
  return out;
}

describe("video stage sizing", () => {
  it("caps the stage width by the same height limit times the ratio", () => {
    const stage = rule(".video-stage");
    const height = /^(\d+(?:\.\d+)?)vh$/.exec(stage["max-height"] ?? "");
    expect(height, "the stage has a vh max-height").not.toBeNull();
    expect(stage["max-width"]).toBe(`calc(${height![1]}vh * var(--video-ratio, 1.78))`);
  });

  it("pins the player to the stage box instead of a percentage height", () => {
    const element = rule(".video-element");
    expect(element.position).toBe("absolute");
    expect(element.inset).toBe("0");
  });

  it("keeps the stage a positioning context with clipped overflow", () => {
    const stage = rule(".video-stage");
    expect(stage.position).toBe("relative");
    expect(stage.overflow).toBe("hidden");
  });
});
