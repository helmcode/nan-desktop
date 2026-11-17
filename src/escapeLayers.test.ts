// @vitest-environment jsdom
// Round 14 review (F2): the layer stack behind "Escape closes only the
// innermost open surface". Window listeners fire in registration order, so the
// stack -- not the listener order -- decides who consumes the key.
import { createElement, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { isTopLayer, layerCount, resetForTests, useEscape, useEscapeLayer } from "./escapeLayers";

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

// CI flake (App.skillsTeam, windows runner): a test awaited the team skill
// detail's heading and pressed Escape before React had run the PASSIVE
// effects that registered the detail's layer and listener, so the Settings
// handler behind it left Settings. A surface must own Escape from the very
// commit that shows it: this probe presses Escape in a LAYOUT effect of a
// later sibling, i.e. after the commit but before any passive effect.
function PressEscapeAtCommit({ seen }: { seen: (top: boolean) => void }) {
  useLayoutEffect(() => {
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(event);
    seen(event.defaultPrevented);
  }, [seen]);
  return null;
}

function Surface({ onEscape }: { onEscape: (e: KeyboardEvent) => void }) {
  useEscape(true, onEscape);
  return null;
}

describe("a surface owns Escape from the commit that shows it", () => {
  it("its layer is the top layer before passive effects run", () => {
    let topAtCommit: boolean | null = null;
    function Check() {
      useLayoutEffect(() => {
        topAtCommit = layerCount() === 1;
      }, []);
      return null;
    }
    render(createElement("div", null, createElement(Probe, { active: true, name: "s" }), createElement(Check)));
    expect(topAtCommit).toBe(true);
  });

  it("its handler consumes an Escape pressed right after the commit", () => {
    const onEscape = vi.fn((e: KeyboardEvent) => e.preventDefault());
    const seen = vi.fn();
    render(createElement("div", null, createElement(Surface, { onEscape }), createElement(PressEscapeAtCommit, { seen })));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(true);
  });

  it("ignores other keys, IME compositions and surfaces that are not on top", () => {
    const parent = vi.fn();
    const child = vi.fn();
    function Parent() {
      useEscape(true, parent);
      return createElement(Child);
    }
    function Child() {
      useEscape(true, child);
      return null;
    }
    render(createElement(Parent));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
    expect(parent).not.toHaveBeenCalled();
    expect(child).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    // Effects run child-first, so the parent registers last and is the top
    // layer (the same order the passive effects gave): only it handles Escape.
    expect(parent).toHaveBeenCalledTimes(1);
    expect(child).not.toHaveBeenCalled();
  });

  it("inactive surfaces register nothing and the latest handler is used", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(createElement(Surface, { onEscape: first }));
    view.rerender(createElement(Surface, { onEscape: second }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(layerCount()).toBe(0);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
