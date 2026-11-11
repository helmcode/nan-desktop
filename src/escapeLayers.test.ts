// @vitest-environment jsdom
// Round 14 review (F2): the layer stack behind "Escape closes only the
// innermost open surface". Window listeners fire in registration order, so the
// stack -- not the listener order -- decides who consumes the key.
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { isTopLayer, layerCount, resetForTests, useEscapeLayer } from "./escapeLayers";

function Probe({ active, name }: { active: boolean; name: string }) {
  const id = useEscapeLayer(active);
  return createElement("span", { "data-testid": name, "data-layer": id });
}

function idOf(name: string): number {
  return Number(screen.getByTestId(name).getAttribute("data-layer"));
}

/** Two surfaces, the second one opened on top of the first. */
function Scene({ top }: { top: boolean }) {
  return createElement(
    "div",
    null,
    createElement(Probe, { active: true, name: "below" }),
    createElement(Probe, { active: top, name: "top" }),
  );
}

afterEach(() => {
  cleanup();
  resetForTests();
});

describe("the escape-layer stack (round 14/F2)", () => {
  it("the surface opened last is the top layer", () => {
    render(createElement(Scene, { top: true }));
    const below = idOf("below");
    const top = idOf("top");
    expect(layerCount()).toBe(2);
    expect(isTopLayer(top)).toBe(true);
    expect(isTopLayer(below)).toBe(false);
  });

  it("closing the innermost surface hands Escape back to the one below", () => {
    const { rerender } = render(createElement(Scene, { top: true }));
    const below = idOf("below");
    expect(isTopLayer(below)).toBe(false);

    rerender(createElement(Scene, { top: false }));

    expect(layerCount()).toBe(1);
    expect(isTopLayer(below)).toBe(true);
  });

  it("unmounting a surface drains its layer", () => {
    const view = render(createElement(Scene, { top: true }));
    expect(layerCount()).toBe(2);
    view.unmount();
    expect(layerCount()).toBe(0);
  });

  it("resetForTests forgets every layer, so one case cannot leak into the next", () => {
    render(createElement(Scene, { top: true }));
    const top = idOf("top");
    resetForTests();
    expect(layerCount()).toBe(0);
    expect(isTopLayer(top)).toBe(false);
  });
});
