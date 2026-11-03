// @vitest-environment jsdom
// Round 7 spec: an image in the chat carries a download icon in its top-right
// corner (shown on hover by CSS) that opens the native Save-as flow; the image
// itself is untouched and its clicks never trigger a save.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { invokedWith, resetTauri } from "../test/tauriMock";
import { I18nProvider } from "../i18n";
import type { Locale } from "../i18n/locale";
import { ChatImage } from "./ChatImage";

const IMAGE = "/Users/ana/Library/Application Support/app/images/0b8f.png";

afterEach(cleanup);
beforeEach(() => resetTauri());

function renderImage(onResult = vi.fn(), locale: Locale = "en", onContainerClick = vi.fn()) {
  render(
    <I18nProvider initial={locale}>
      <div onClick={onContainerClick}>
        <ChatImage path={IMAGE} alt="A red fox" onResult={onResult} />
      </div>
    </I18nProvider>,
  );
  return { onResult, onContainerClick };
}

const download = () => screen.getByRole("button", { name: "Download image" }) as HTMLButtonElement;

describe("ChatImage hover download (round 7)", () => {
  it("renders the image through the asset protocol with the overlay icon on top of it", () => {
    renderImage();
    const img = screen.getByRole("img", { name: "A red fox" });
    expect(img.getAttribute("src")).toBe(`asset://localhost/${IMAGE}`);
    const button = download();
    // Same wrapper as the image: the CSS positions it in the top-right corner
    // and reveals it on hover / keyboard focus.
    expect(button.className).toBe("msg-image-download");
    expect(button.parentElement).toBe(img.parentElement);
    expect(button.parentElement?.className).toBe("msg-image-wrap");
    expect(button.title).toBe("Download image");
  });

  it("names the icon in Spanish", () => {
    renderImage(vi.fn(), "es");
    expect(screen.getByRole("button", { name: "Descargar imagen" })).toBeTruthy();
  });

  it("opens the native Save-as flow for exactly this image and reports the result", async () => {
    resetTauri({ image_save_as: () => "/Users/ana/Desktop/zorro.png" });
    const { onResult, onContainerClick } = renderImage();
    fireEvent.click(download());
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ kind: "saved", path: "/Users/ana/Desktop/zorro.png" }),
    );
    expect(invokedWith("image_save_as")).toEqual([{ sourcePath: IMAGE }]);
    // The click does not bubble to whatever handles clicks on the image area.
    expect(onContainerClick).not.toHaveBeenCalled();
    await waitFor(() => expect(download().disabled).toBe(false));
  });

  it("clicking the image itself keeps its own behaviour and never saves", () => {
    const { onContainerClick } = renderImage();
    fireEvent.click(screen.getByRole("img", { name: "A red fox" }));
    expect(onContainerClick).toHaveBeenCalledTimes(1);
    expect(invokedWith("image_save_as")).toEqual([]);
  });

  it("reports a failure and ignores clicks while the dialog is open", async () => {
    let fail: (e: Error) => void = () => {};
    resetTauri({ image_save_as: () => new Promise((_, reject) => (fail = reject)) });
    const { onResult } = renderImage();
    fireEvent.click(download());
    await waitFor(() => expect(download().disabled).toBe(true));
    fireEvent.click(download());
    expect(invokedWith("image_save_as")).toHaveLength(1);
    fail(new Error("cannot write"));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ kind: "failed" }));
  });
});
