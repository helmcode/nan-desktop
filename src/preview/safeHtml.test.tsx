// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());

import { SafeHtml } from "./safeHtml";

afterEach(cleanup);

describe("SafeHtml (S21)", () => {
  it("keeps structure and text", () => {
    const { container } = render(<SafeHtml html="<h1>Title</h1><p>Hello <strong>there</strong></p><table><tr><td>1</td></tr></table>" />);
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.querySelector("strong")?.textContent).toBe("there");
    expect(container.querySelector("td")?.textContent).toBe("1");
  });

  it("drops scripts, images, iframes, styles and event handlers", () => {
    const { container } = render(
      <SafeHtml html={'<p onclick="x()" style="color:red">a</p><script>alert(1)</script><img src="https://evil/x.png"><iframe src="https://evil"></iframe><style>p{}</style>'} />,
    );
    expect(container.querySelector("script, img, iframe, style")).toBeNull();
    const p = container.querySelector("p");
    expect(p?.getAttribute("onclick")).toBeNull();
    expect(p?.getAttribute("style")).toBeNull();
    expect(container.textContent).not.toContain("alert");
  });

  it("routes http links through the preview handler and neutralizes others", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <SafeHtml html={'<a href="https://helmcode.com">site</a><a href="javascript:alert(1)">bad</a>'} onOpenLink={onOpen} />,
    );
    expect(container.querySelector("a")).toBeNull();
    const link = container.querySelector(".safe-link") as HTMLElement;
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("https://helmcode.com");
    expect(container.querySelectorAll(".safe-link")).toHaveLength(1);
  });
});
