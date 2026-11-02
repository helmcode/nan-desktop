// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider, type Locale } from "./i18n";
import { LOCALE_STORAGE_KEY } from "./i18n/locale";
import { APPROVAL_REQUEST_EVENT, APPROVAL_RESOLVED_EVENT } from "./core";
import type { ChatMessageRow } from "./types";

const PROFILES = {
  profiles: [
    { id: "nan", name: "NaN", has_key: false, key_mask: null },
    { id: "helmcode", name: "Helmcode", has_key: false, key_mask: null },
  ],
  active_profile: null,
};

const SIGNED_IN = {
  profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
  active_profile: "nan",
};

function row(id: number, role: string, content: string): ChatMessageRow {
  return {
    id,
    conversation_id: 7,
    role,
    content,
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
  };
}

function chatHandlers(messages: ChatMessageRow[]) {
  return {
    profiles_load: () => SIGNED_IN,
    conversation_list: () => [{ id: 7, title: "Report", updated_at: "", last_message: null }],
    messages_list: () => messages,
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [
      {
        id: "g1",
        canonical_path: "/Users/ana/Proyecto",
        granted_at: "",
        profile_id: "nan",
        scope: "folder",
        mode: "ask",
      },
    ],
    tools_approval_respond: () => undefined,
    tts_stop: () => undefined,
  };
}

function renderApp(initial: Locale | null) {
  return render(
    <I18nProvider initial={initial}>
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe("first run (S19)", () => {
  it("asks for the language before the tenant, English preselected", async () => {
    resetTauri({ profiles_load: () => PROFILES });
    renderApp(null);
    expect(screen.getByRole("heading", { name: "Choose your language" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "English" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("Choose how to sign in:")).toBeNull();
  });

  it("continues to the tenant picker in the chosen language and persists it", async () => {
    resetTauri({ profiles_load: () => PROFILES });
    renderApp(null);
    fireEvent.click(screen.getByRole("radio", { name: "Español" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(await screen.findByText("Elige cómo quieres entrar:")).toBeTruthy();
    expect(screen.getByText("Comunidad NaN")).toBeTruthy();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("es");
    expect(document.documentElement.lang).toBe("es");
  });

  it("skips the language screen once a language was chosen", async () => {
    resetTauri({ profiles_load: () => PROFILES });
    renderApp("en");
    expect(await screen.findByText("Choose how to sign in:")).toBeTruthy();
    expect(screen.queryByText("Choose your language")).toBeNull();
    expect(document.title).toBe("Helmcode Desktop");
  });
});

describe("chat shell", () => {
  it("never renders tool-call markup and renders GFM tables (S16)", async () => {
    resetTauri(
      chatHandlers([
        row(1, "user", "Make a table"),
        row(
          2,
          "assistant",
          'Here:\n\n| Name | Qty |\n|---|---|\n| A | 1 |\n\n<｜DSML｜function_calls><｜DSML｜invoke name="fs_write"></｜DSML｜invoke></｜DSML｜function_calls>',
        ),
      ]),
    );
    const { container } = renderApp("en");
    await screen.findByText("Make a table");
    expect(container.querySelector(".md table th")?.textContent).toBe("Name");
    expect(container.textContent).not.toContain("DSML");
    expect(container.textContent).not.toContain("function_calls");
  });

  it("shows an inline approval card and answers through the core (S14)", async () => {
    resetTauri(chatHandlers([row(1, "user", "Delete old.txt")]));
    renderApp("en");
    await screen.findByText("Delete old.txt");
    act(() => {
      emit(APPROVAL_REQUEST_EVENT, {
        id: "pa-1",
        conversation_id: 7,
        action: "delete",
        target: "/Users/ana/Proyecto/old.txt",
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(invokedWith("tools_approval_respond")).toEqual([{ id: "pa-1", granted: true }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
    expect(screen.getByText(/Allowed: Delete a file/)).toBeTruthy();
  });

  it("collapses a card the core resolved by itself", async () => {
    resetTauri(chatHandlers([row(1, "user", "Rename it")]));
    renderApp("en");
    await screen.findByText("Rename it");
    act(() => {
      emit(APPROVAL_REQUEST_EVENT, { id: "pa-2", conversation_id: 7, action: "rename", target: "/a/b.txt" });
    });
    await screen.findByRole("button", { name: "Deny" });
    act(() => {
      emit(APPROVAL_RESOLVED_EVENT, { id: "pa-2", conversation_id: 7, granted: false });
    });
    expect(await screen.findByText(/Denied: Rename a file/)).toBeTruthy();
  });

  it("hides voice controls this round (S24)", async () => {
    resetTauri(chatHandlers([row(1, "user", "hi"), row(2, "assistant", "hello")]));
    renderApp("en");
    await screen.findByText("hello");
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Listen" })).toBeNull();
  });

  it("offers file chips for files inside working folders only (S21)", async () => {
    resetTauri(
      chatHandlers([
        row(1, "user", "make a pdf"),
        row(2, "assistant", "Saved to `/Users/ana/Proyecto/report.pdf`, not /etc/x.pdf"),
      ]),
    );
    renderApp("en");
    expect(await screen.findByRole("button", { name: "Open preview: report.pdf" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open preview: x.pdf" })).toBeNull();
  });

  it("puts settings behind the bottom-left user chip (S20)", async () => {
    resetTauri({
      ...chatHandlers([]),
      tools_settings_get: () => ({ tools_allow_run_command: true }),
      memory_settings_get: () => ({ mode: "remote" }),
      app_info: () => ({ version: "0.2.0" }),
    });
    renderApp("en");
    fireEvent.click(await screen.findByRole("button", { name: /Account menu: NaN Community/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Working folders" }));
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("radiogroup", { name: "Approval mode for Proyecto" })).toBeTruthy();
    expect(screen.getByText("Helmcode Desktop")).toBeTruthy();
  });
});
