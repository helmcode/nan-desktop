// @vitest-environment jsdom
// R20-E in the shell: one update schedule for the whole app. A check on
// startup; coming back to the window after more than 2 hours away checks
// again and the banner shows what it found; switching surfaces (chat ->
// Settings -> chat) never starts a check of its own.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";

const HOUR = 60 * 60 * 1000;

function setup(check: () => unknown): void {
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [],
    messages_list: () => [],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    skills_list: () => [],
    tools_settings_get: () => ({ tools_allow_run_command: true }),
    memory_settings_get: () => ({ mode: "remote" }),
    app_info: () => ({ version: "0.2.8" }),
    update_check: check,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("R20-E: the app's update schedule", () => {
  it("checks once on startup; back after 3 hours in the background, checks again and shows the banner", async () => {
    let answer: unknown = null;
    setup(() => answer);
    render(
      <I18nProvider initial="es">
        <App />
      </I18nProvider>,
    );
    await waitFor(() => expect(invokedWith("update_check")).toHaveLength(1));
    expect(screen.queryByText(/Hay una versión nueva/)).toBeNull();

    const start = Date.now();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    answer = { version: "0.2.9", current_version: "0.2.8" };
    vi.spyOn(Date, "now").mockReturnValue(start + 3 * HOUR);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(invokedWith("update_check")).toHaveLength(2));
    expect(await screen.findByText("Hay una versión nueva: 0.2.9")).toBeTruthy();
  });

  it("a quick look away does not check, and switching to Settings and back never does", async () => {
    setup(() => null);
    render(
      <I18nProvider initial="en">
        <App />
      </I18nProvider>,
    );
    await waitFor(() => expect(invokedWith("update_check")).toHaveLength(1));
    const start = Date.now();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    vi.spyOn(Date, "now").mockReturnValue(start + 20 * 60 * 1000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    await screen.findByRole("navigation", { name: "Settings sections" });
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));
    await act(async () => {});
    expect(invokedWith("update_check")).toHaveLength(1);
  });

  it("a failed check keeps the visible banner (and Update in the menu)", async () => {
    let fail = false;
    setup(() => {
      if (fail) throw new Error("offline");
      return { version: "0.2.9", current_version: "0.2.8" };
    });
    render(
      <I18nProvider initial="en">
        <App />
      </I18nProvider>,
    );
    expect(await screen.findByText("A new version is available: 0.2.9")).toBeTruthy();

    // Back from a 3-hour sleep before the network is up: the check fails.
    const start = Date.now();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    fail = true;
    vi.spyOn(Date, "now").mockReturnValue(start + 3 * HOUR);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(invokedWith("update_check")).toHaveLength(2));
    await act(async () => {});
    expect(screen.getByText("A new version is available: 0.2.9")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(await screen.findByRole("menuitem", { name: "Update" })).toBeTruthy();
  });

  it("online right after a failed check runs a new check", async () => {
    let fail = true;
    setup(() => {
      if (fail) throw new Error("offline");
      return { version: "0.2.9", current_version: "0.2.8" };
    });
    render(
      <I18nProvider initial="en">
        <App />
      </I18nProvider>,
    );
    await waitFor(() => expect(invokedWith("update_check")).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByText(/A new version is available/)).toBeNull();

    // The network comes back a minute later, well inside the 30-minute gap.
    fail = false;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 1000);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(invokedWith("update_check")).toHaveLength(2));
    expect(await screen.findByText("A new version is available: 0.2.9")).toBeTruthy();
  });
});
