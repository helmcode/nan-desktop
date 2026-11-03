// @vitest-environment jsdom
// Round 7 spec: a newer release shows a non-invasive banner with "Update";
// the app checks on startup and every 6 h, never installs by itself, and the
// close button hides the banner until the next check.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { invokedWith, resetTauri } from "../test/tauriMock";
import { I18nProvider } from "../i18n";
import type { Locale } from "../i18n/locale";
import type { UpdateInfo } from "../core";
import { UPDATE_CHECK_INTERVAL_MS, UpdateBanner } from "./UpdateBanner";

const NEXT: UpdateInfo = { version: "0.3.0", current_version: "0.2.0" };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderBanner(
  props: Partial<Parameters<typeof UpdateBanner>[0]> = {},
  locale: Locale = "en",
) {
  return render(
    <I18nProvider initial={locale}>
      <UpdateBanner {...props} />
    </I18nProvider>,
  );
}

describe("UpdateBanner (round 7)", () => {
  it("checks once on startup and shows the new version with an Update button", async () => {
    const check = vi.fn(async () => NEXT);
    const install = vi.fn(async () => {});
    renderBanner({ check, install });
    expect(await screen.findByText("Helmcode Desktop 0.3.0 is available")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
    expect(check).toHaveBeenCalledTimes(1);
    // Never installs by itself.
    expect(install).not.toHaveBeenCalled();
  });

  it("speaks Spanish", async () => {
    renderBanner({ check: async () => NEXT }, "es");
    expect(await screen.findByText("Helmcode Desktop 0.3.0 disponible")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actualizar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy();
  });

  it("shows nothing when there is no update", async () => {
    const check = vi.fn(async () => null);
    const { container } = renderBanner({ check });
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("stays silent when the check fails (offline, no feed yet)", async () => {
    const check = vi.fn(async () => {
      throw new Error("network");
    });
    const { container } = renderBanner({ check });
    await waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".update-banner")).toBeNull();
  });

  it("Update downloads, installs and relaunches through the core, once", async () => {
    let finish: () => void = () => {};
    const install = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    renderBanner({ check: async () => NEXT, install });
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    const busy = (await screen.findByRole("button", { name: "Updating…" })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(install).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("a failed install says so and lets the user retry", async () => {
    const install = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("bad signature"))
      .mockResolvedValueOnce(undefined);
    renderBanner({ check: async () => NEXT, install });
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    expect(await screen.findByText(/Could not update\. Try again\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
  });

  it("dismiss hides the banner until the next check, which brings it back", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => NEXT);
    const { container } = renderBanner({ check, intervalMs: 1000 });
    await act(async () => {});
    expect(container.querySelector(".update-banner")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(container.querySelector(".update-banner")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(container.querySelector(".update-banner")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".update-banner")).not.toBeNull();
  });

  it("re-checks every 6 hours by default", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => null);
    renderBanner({ check });
    await act(async () => {});
    expect(check).toHaveBeenCalledTimes(1);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    await act(async () => {
      vi.advanceTimersByTime(UPDATE_CHECK_INTERVAL_MS);
    });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("defaults to the core commands update_check and update_install", async () => {
    resetTauri({ update_check: () => NEXT, update_install: () => undefined });
    renderBanner();
    fireEvent.click(await screen.findByRole("button", { name: "Update" }));
    await waitFor(() => expect(invokedWith("update_install")).toHaveLength(1));
    expect(invokedWith("update_check")).toHaveLength(1);
  });
});
