// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { invokedWith, resetTauri } from "../test/tauriMock";
import { I18nProvider } from "../i18n";
import type { Locale } from "../i18n/locale";
import { SaveImageButton } from "./SaveImageButton";
import { Toast, type ToastNotice } from "./Toast";

const IMAGE = "/Users/ana/Library/Application Support/app/images/0b8f.png";

afterEach(cleanup);
beforeEach(() => resetTauri());

function renderButton(onResult = vi.fn(), locale: Locale = "en") {
  render(
    <I18nProvider initial={locale}>
      <SaveImageButton path={IMAGE} onResult={onResult} />
    </I18nProvider>,
  );
  return onResult;
}

describe("SaveImageButton (round 6)", () => {
  it("names the action in both languages", () => {
    renderButton();
    expect(screen.getByRole("button", { name: "Save as…" })).toBeTruthy();
    cleanup();
    renderButton(vi.fn(), "es");
    expect(screen.getByRole("button", { name: "Guardar como…" })).toBeTruthy();
  });

  function button(): HTMLButtonElement {
    return screen.getByRole("button", { name: "Save as…" }) as HTMLButtonElement;
  }

  it("asks the core to save exactly this image and reports the saved path", async () => {
    resetTauri({ image_save_as: () => "/Users/ana/Desktop/zorro.png" });
    const onResult = renderButton();
    fireEvent.click(button());
    await waitFor(() =>
      expect(onResult).toHaveBeenCalledWith({ kind: "saved", path: "/Users/ana/Desktop/zorro.png" }),
    );
    // Only the source crosses IPC: the core opens the native dialog itself.
    expect(invokedWith("image_save_as")).toEqual([{ sourcePath: IMAGE }]);
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("stays silent when the user cancels the dialog", async () => {
    resetTauri({ image_save_as: () => null });
    const onResult = renderButton();
    fireEvent.click(button());
    await waitFor(() => expect(invokedWith("image_save_as")).toHaveLength(1));
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(onResult).not.toHaveBeenCalled();
  });

  it("reports a failure", async () => {
    resetTauri({
      image_save_as: () => {
        throw new Error("cannot write the image");
      },
    });
    const onResult = renderButton();
    fireEvent.click(button());
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ kind: "failed" }));
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("ignores repeated clicks while the dialog is open", async () => {
    let finish: (value: string | null) => void = () => {};
    resetTauri({ image_save_as: () => new Promise<string | null>((resolve) => (finish = resolve)) });
    const onResult = renderButton();
    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    fireEvent.click(button());
    expect(invokedWith("image_save_as")).toHaveLength(1);
    await act(async () => finish("/tmp/a.png"));
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button().disabled).toBe(false));
  });
});

describe("Toast (round 6)", () => {
  const notice: ToastNotice = { id: 1, kind: "success", text: "Image saved to /Users/ana/Desktop/zorro.png" };

  function renderToast(value: ToastNotice | null, onDismiss = vi.fn(), timeoutMs = 5000) {
    render(
      <I18nProvider initial="en">
        <Toast notice={value} onDismiss={onDismiss} timeoutMs={timeoutMs} />
      </I18nProvider>,
    );
    return onDismiss;
  }

  it("announces the notice in a polite live region and can be dismissed", () => {
    const onDismiss = renderToast(notice);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toContain(notice.text);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("closes by itself after the timeout", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = renderToast(notice, vi.fn(), 3000);
      vi.advanceTimersByTime(2999);
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders nothing but the empty region without a notice", () => {
    renderToast(null);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
