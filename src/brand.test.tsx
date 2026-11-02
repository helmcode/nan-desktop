// Round 5 / TASK 2: the Helmcode symbol renders as a small rounded tile on
// every surface (sidebar, empty state, about, preview link-out), sized by a
// named variant so no surface picks an ad-hoc pixel size, with one shared
// corner-radius ratio (the same rounded treatment as avatars and chips).
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BRAND_MARK_SIZES, BrandMark } from "./brand";

import css from "./App.css?raw";

const sources = import.meta.glob(["./**/*.tsx", "!./**/*.test.tsx", "!./brand.tsx"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The declaration block of the first rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : "";
}

describe("BrandMark", () => {
  it("defaults to the sidebar size, which matches the neighbouring text (18-20px)", () => {
    const { container } = render(<BrandMark />);
    const tile = container.querySelector(".brand-mark");
    expect(tile).not.toBeNull();
    expect(tile?.classList.contains("brand-mark--sm")).toBe(true);
    expect(BRAND_MARK_SIZES.sm).toBeGreaterThanOrEqual(18);
    expect(BRAND_MARK_SIZES.sm).toBeLessThanOrEqual(20);
  });

  it("wraps the official symbol in the tile, aspect-correct (never stretched)", () => {
    const { container } = render(<BrandMark size="lg" />);
    const img = container.querySelector(".brand-mark img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toMatch(/helmcode-symbol-color/);
    // Width is never forced: CSS sets the height and width stays auto.
    expect(img?.hasAttribute("width")).toBe(false);
    expect(ruleBody(".brand-mark img")).toMatch(/width:\s*auto/);
  });

  it("is decorative by default and an image with a name when labelled", () => {
    const decorative = render(<BrandMark />).container.querySelector(".brand-mark");
    expect(decorative?.getAttribute("aria-hidden")).toBe("true");
    expect(decorative?.querySelector("img")?.getAttribute("alt")).toBe("");

    const labelled = render(<BrandMark label="Helmcode" />).container.querySelector(".brand-mark");
    expect(labelled?.getAttribute("role")).toBe("img");
    expect(labelled?.getAttribute("aria-label")).toBe("Helmcode");
    expect(labelled?.hasAttribute("aria-hidden")).toBe(false);
  });

  it("every size variant has a CSS rule with the matching tile size", () => {
    for (const [name, px] of Object.entries(BRAND_MARK_SIZES)) {
      expect(ruleBody(`.brand-mark--${name}`)).toContain(`--brand-mark-size: ${px}px`);
    }
  });

  it("uses one rounded-corner ratio for every size and clips the content", () => {
    const base = ruleBody(".brand-mark");
    expect(base).toMatch(/border-radius:\s*calc\(var\(--brand-mark-size\)\s*\*\s*0\.\d+\)/);
    expect(base).toMatch(/overflow:\s*hidden/);
    expect(base).toMatch(/width:\s*var\(--brand-mark-size\)/);
    expect(base).toMatch(/height:\s*var\(--brand-mark-size\)/);
    // Size variants only set the size: none may override the radius.
    for (const name of Object.keys(BRAND_MARK_SIZES)) {
      expect(ruleBody(`.brand-mark--${name}`)).not.toMatch(/border-radius/);
    }
  });

  it("no surface passes an ad-hoc numeric pixel size", () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /<BrandMark[^>]*size=\{\d+\}/.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("the sidebar uses the small, text-height variant", () => {
    const app = sources["./App.tsx"];
    expect(app).toMatch(/className="sidebar-brand">\s*<BrandMark size="sm" \/>/);
  });
});
