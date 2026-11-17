// @vitest-environment jsdom
// Updates never depend on a session: the one update schedule starts with the
// app window, before the sign-in state resolves, so a user whose session
// expired (or who never signed in) still hears about a new version on the
// sign-in screen. The banner there installs through the same flow, a dismiss
// there stays dismissed after signing in (same check), and signing in never
// starts a check of its own.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";

const HOUR = 60 * 60 * 1000;
const NEW_VERSION = { version: "0.2.13", current_version: "0.2.12" };

/** A core with no usable session (`signedIn` flips on approval). */
function signedOutCore({
  check,
  reloginPending = false,
  profilesLoad,
}: {
  check: () => unknown;
  reloginPending?: boolean;
  profilesLoad?: () => unknown;
}) {
  const state = { signedIn: false };
  resetTauri({
    profiles_load:
      profilesLoad ??
      (() =>
        state.signedIn
          ? {
              profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
              active_profile: "nan",
              active_user: { email: "ana@example.com", realm: "realm-a" },
              relogin_pending: false,
            }
          : {
              profiles: [{ id: "nan", name: "NaN", has_key: false, key_mask: null }],
              active_profile: null,
              active_user: null,
              relogin_pending: reloginPending,
            }),
    device_login_start: () => undefined,
    conversation_list: () => [],
    messages_list: () => [],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    skills_list: () => [],
    update_check: check,
    update_install: () => undefined,
  });
  return state;
}

function renderApp(lang: "en" | "es" = "en") {
  return render(
    <I18nProvider initial={lang}>
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("updates before sign-in", () => {
  it("checks on startup with no session and shows the banner over the sign-in screen", async () => {
    signedOutCore({ check: () => NEW_VERSION });
    renderApp();
    expect(await screen.findByText("Choose how to sign in:")).toBeTruthy();
    expect(await screen.findByText("A new version is available: 0.2.13")).toBeTruthy();
    expect(invokedWith("update_check")).toHaveLength(1);
    // Hosted in the pre-login overlay, not inside the (absent) chat shell.
    const banner = screen.getByText("A new version is available: 0.2.13").closest(".update-banner-host");
    expect(banner).toBeTruthy();
  });

  it("an expired session (re-login pending) sees the new version too, in Spanish copy unchanged", async () => {
    signedOutCore({ check: () => NEW_VERSION, reloginPending: true });
    renderApp("es");
    expect(await screen.findByText("Hay una versión nueva: 0.2.13")).toBeTruthy();
  });

  it("Update on the sign-in screen installs without a session", async () => {
    signedOutCore({ check: () => NEW_VERSION });
    renderApp();
    await screen.findByText("A new version is available: 0.2.13");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(invokedWith("update_install")).toHaveLength(1));
  });

  it("the schedule runs while signed out: back after 3 hours checks again", async () => {
    let answer: unknown = null;
    signedOutCore({ check: () => answer });
    renderApp();
    await screen.findByText("Choose how to sign in:");
    await waitFor(() => expect(invokedWith("update_check")).toHaveLength(1));
    expect(screen.queryByText(/A new version is available/)).toBeNull();

    const start = Date.now();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    answer = NEW_VERSION;
    vi.spyOn(Date, "now").mockReturnValue(start + 3 * HOUR);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(invokedWith("update_check")).toHaveLength(2));
    expect(await screen.findByText("A new version is available: 0.2.13")).toBeTruthy();
  });

  it("the check runs even when loading the profiles fails (error screen shows the banner)", async () => {
    signedOutCore({
      check: () => NEW_VERSION,
      profilesLoad: () => {
        throw new Error("core down");
      },
    });
    renderApp();
    expect(await screen.findByText("A new version is available: 0.2.13")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("signing in keeps the same schedule: no extra check, the banner moves into the chat", async () => {
    const state = signedOutCore({ check: () => NEW_VERSION });
    renderApp();
    await screen.findByText("A new version is available: 0.2.13");

    fireEvent.click(await screen.findByRole("button", { name: /NaN/ }));
    await waitFor(() => expect(invokedWith("device_login_start").length).toBeGreaterThan(0));
    state.signedIn = true;
    await act(async () => {
      emit("device://approved", { key_alias: "desktop", profile_id: "nan", fresh_realm: false });
    });
    await screen.findByRole("button", { name: /Account menu/ });
    expect(screen.getByText("A new version is available: 0.2.13")).toBeTruthy();
    expect(document.querySelector(".update-banner-host")).toBeNull();
    expect(invokedWith("update_check")).toHaveLength(1);
  });

  it("a dismiss on the sign-in screen stays dismissed after signing in; the menu still offers Update", async () => {
    const state = signedOutCore({ check: () => NEW_VERSION });
    renderApp();
    await screen.findByText("A new version is available: 0.2.13");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector(".update-banner")).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: /NaN/ }));
    await waitFor(() => expect(invokedWith("device_login_start").length).toBeGreaterThan(0));
    state.signedIn = true;
    await act(async () => {
      emit("device://approved", { key_alias: "desktop", profile_id: "nan", fresh_realm: false });
    });
    fireEvent.click(await screen.findByRole("button", { name: /Account menu/ }));
    expect(await screen.findByRole("menuitem", { name: "Update" })).toBeTruthy();
    // The menu repeats the version; the banner itself stays closed.
    expect(document.querySelector(".update-banner")).toBeNull();
  });
});
