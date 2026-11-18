// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChipSection } from "./ChipSection";

afterEach(cleanup);

function renderSection() {
  render(
    <ChipSection label="Fuentes" count={2}>
      <li>
        <button type="button">uno</button>
      </li>
      <li>
        <button type="button">dos</button>
      </li>
    </ChipSection>,
  );
}

describe("ChipSection", () => {
  it("starts collapsed, showing only the label and the count", () => {
    renderSection();
    const toggle = screen.getByRole("button", { name: /Fuentes/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("2");
    expect(screen.queryByRole("button", { name: "uno" })).toBeNull();
  });

  it("expands and collapses on click, linking the toggle to the list", () => {
    renderSection();
    const toggle = screen.getByRole("button", { name: /Fuentes/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list");
    expect(toggle.getAttribute("aria-controls")).toBe(list.id);
    expect(screen.getByRole("button", { name: "dos" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
  });
});
