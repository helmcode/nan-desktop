// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider, type Locale } from "./i18n";
import { LOCALE_STORAGE_KEY } from "./i18n/locale";
import { APPROVAL_REQUEST_EVENT, APPROVAL_RESOLVED_EVENT, type ApprovalRequest } from "./core";
import type { ChatMessageRow } from "./types";
import { FOLDER_SELECTION_STORAGE_KEY } from "./chat/folderSelection";
import { NUDGE_SHOWN_STORAGE_KEY } from "./chat/allowNudge";

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

/// The exact `tools://approval-request` payload the core emits.
function approvalPayload(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approval_id: "pa-0",
    conversation_id: 7,
    action: "delete_path",
    title: "Borrar",
    text: "¿Borrar old.txt?",
    summary: "delete_path /Users/ana/Proyecto/old.txt (to trash)",
    path: "/Users/ana/Proyecto/old.txt",
    dest_path: null,
    command: null,
    diff_preview: null,
    permanent: false,
    expires_in_secs: 300,
    ...overrides,
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
      emit(APPROVAL_REQUEST_EVENT, approvalPayload({ approval_id: "pa-1" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    // Tauri command args are camelCase: Rust `approval_id` is `approvalId`.
    await waitFor(() =>
      expect(invokedWith("tools_approval_respond")).toEqual([{ approvalId: "pa-1", granted: true }]),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
    expect(screen.getByText(/Allowed: Delete a file/)).toBeTruthy();
  });

  it("collapses a card the core resolved by itself", async () => {
    resetTauri(chatHandlers([row(1, "user", "Rename it")]));
    renderApp("en");
    await screen.findByText("Rename it");
    act(() => {
      emit(
        APPROVAL_REQUEST_EVENT,
        approvalPayload({ approval_id: "pa-2", action: "move_path", path: "/a/b.txt", dest_path: "/a/c.txt" }),
      );
    });
    await screen.findByRole("button", { name: "Deny" });
    act(() => {
      emit(APPROVAL_RESOLVED_EVENT, { approval_id: "pa-2", granted: false });
    });
    expect(await screen.findByText(/Denied: Move a file/)).toBeTruthy();
  });

  it("shows a request without a conversation in the open conversation", async () => {
    resetTauri(chatHandlers([row(1, "user", "List it")]));
    renderApp("en");
    await screen.findByText("List it");
    act(() => {
      emit(APPROVAL_REQUEST_EVENT, approvalPayload({ approval_id: "pa-3", conversation_id: null, action: "list_files" }));
    });
    expect(await screen.findByText("List a folder")).toBeTruthy();
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

  it("shows every file a reply produced as a chip, even when the text never names it (round 3)", async () => {
    resetTauri(
      chatHandlers([
        row(1, "user", "hazme una web"),
        {
          ...row(2, "assistant", "Done."),
          artifacts: [{ path: "/Users/ana/Downloads/informe-bbva/index.html", kind: "file" }],
        },
      ]),
    );
    renderApp("en");
    expect(await screen.findByRole("button", { name: "Open preview: index.html" })).toBeTruthy();
  });

  it("renders an image the assistant generated inline (round 3)", async () => {
    resetTauri(
      chatHandlers([
        row(1, "user", "draw a cat"),
        { ...row(2, "assistant", "Here it is."), artifacts: [{ path: "/data/images/cat.png", kind: "image" }] },
      ]),
    );
    renderApp("en");
    const image = await screen.findByRole("img", { name: "Image created by the assistant" });
    expect(image.getAttribute("src")).toBe("asset://localhost//data/images/cat.png");
    expect(screen.queryByRole("button", { name: "Open preview: cat.png" })).toBeNull();
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

describe("Settings as a surface (round 14, S2)", () => {
  const settingsHandlers = {
    tools_settings_get: () => ({ tools_allow_run_command: true }),
    memory_settings_get: () => ({ mode: "remote" }),
    app_info: () => ({ version: "0.2.2" }),
  };

  async function openSettings(menuItem = "Settings"): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole("button", { name: /Account menu/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: menuItem }));
    return screen.findByRole("navigation", { name: "Settings sections" });
  }

  it("swaps the chat history for the section list and opens the Account section", async () => {
    resetTauri({ ...chatHandlers([row(1, "user", "Keep this chat")]), ...settingsHandlers });
    const { container } = renderApp("en");
    await screen.findByText("Keep this chat");

    const nav = await openSettings();
    expect(within(nav).getAllByRole("button").map((item) => item.textContent)).toEqual([
      "Account",
      "Working folders",
      "Memory",
      "Language",
      "Skills",
    ]);
    const current = () => container.querySelector('.settings-surface')?.getAttribute("data-section");
    expect(within(nav).getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBe("page");
    expect(current()).toBe("account");
    // The conversations sidebar is replaced while Settings is open.
    expect(screen.queryByRole("navigation", { name: "History" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Image Studio" })).toBeNull();
    // Account is what About / sign out showed before the restructure.
    expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("moves between sections from the section list, keyboard included", async () => {
    resetTauri({ ...chatHandlers([row(1, "user", "Keep this chat")]), ...settingsHandlers });
    const { container } = renderApp("en");
    await screen.findByText("Keep this chat");

    const nav = await openSettings("Working folders");
    const current = () => container.querySelector('.settings-surface')?.getAttribute("data-section");
    expect(current()).toBe("folders");
    const folders = within(nav).getByRole("button", { name: "Working folders" });
    expect(folders.getAttribute("aria-current")).toBe("page");
    // The keyboard lands in the section list, on the open section.
    await waitFor(() => expect(document.activeElement).toBe(folders));

    const memory = within(nav).getByRole("button", { name: "Memory" });
    fireEvent.click(memory);
    expect(current()).toBe("memory");
    expect(memory.getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBeNull();
  });

  it("leaving Settings restores the open conversation and the composer, and gives focus back to the chat", async () => {
    resetTauri({
      ...chatHandlers([]),
      conversation_list: () => [
        { id: 7, title: "Report", updated_at: "", last_message: null },
        { id: 9, title: "Notes", updated_at: "", last_message: null },
      ],
      messages_list: (args) =>
        args?.conversationId === 9 ? [row(2, "user", "Notes keep")] : [row(1, "user", "Report keep")],
      ...settingsHandlers,
    });
    renderApp("en");
    // The boot opens the first chat; the user switches to the other one.
    await screen.findByText("Report keep");
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));
    await screen.findByText("Notes keep");
    const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "half written reply" } });

    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Back to chat" }));

    expect(await screen.findByText("Notes keep")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notes" }).getAttribute("aria-current")).toBe("page");
    const back = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
    expect(back.value).toBe("half written reply");
    await waitFor(() => expect(document.activeElement).toBe(back));
    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "History" })).toBeTruthy();
  });

  it("the left rail no longer offers Skills (it lives in Settings)", async () => {
    resetTauri(chatHandlers([row(1, "user", "hi")]));
    renderApp("en");
    await screen.findByText("hi");
    expect(screen.getByRole("button", { name: "Image Studio" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skills" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Skills" })).toBeNull();
  });
});

describe("folder selection and allow-mode suggestion", () => {
  const chipLabel = () => screen.getByTitle("Where the assistant can work").textContent;

  async function sendMessage(text: string): Promise<void> {
    const box = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
  }

  it("sends no folder for a conversation nobody picked folders for", async () => {
    resetTauri({ ...chatHandlers([row(1, "user", "hi")]), chat_send: () => undefined });
    renderApp("en");
    await screen.findByText("hi");
    await waitFor(() => expect(chipLabel()).toBe("No folder"));
    await sendMessage("write a report");
    await waitFor(() =>
      expect(invokedWith("chat_send")).toEqual([
        { conversationId: 7, model: "deepseek-v4-flash", content: "write a report", grantIds: [] },
      ]),
    );
  });

  it("sends the conversation's remembered selection", async () => {
    window.localStorage.setItem(FOLDER_SELECTION_STORAGE_KEY, JSON.stringify({ "7": ["g1", "gone"] }));
    resetTauri({ ...chatHandlers([row(1, "user", "hi")]), chat_send: () => undefined });
    renderApp("en");
    await screen.findByText("hi");
    await waitFor(() => expect(chipLabel()).toBe("Proyecto"));
    await sendMessage("read it");
    await waitFor(() => expect(invokedWith("chat_send")[0]?.grantIds).toEqual(["g1"]));
  });

  it("suggests always allowing a folder after three approvals and switches it in one click", async () => {
    window.localStorage.setItem(FOLDER_SELECTION_STORAGE_KEY, JSON.stringify({ "7": ["g1"] }));
    resetTauri({
      ...chatHandlers([row(1, "user", "Tidy the folder")]),
      tools_grant_set_mode: () => ({
        id: "g1",
        canonical_path: "/Users/ana/Proyecto",
        granted_at: "",
        profile_id: "nan",
        scope: "folder",
        mode: "allow",
      }),
    });
    renderApp("en");
    await screen.findByText("Tidy the folder");
    await waitFor(() => expect(chipLabel()).toBe("Proyecto"));
    const suggestion = "You are approving many actions in Proyecto. Always allow in this folder?";
    for (const n of [1, 2, 3]) {
      act(() => {
        emit(APPROVAL_REQUEST_EVENT, approvalPayload({ approval_id: `pa-${n}`, path: `/Users/ana/Proyecto/f${n}.txt` }));
      });
      act(() => {
        emit(APPROVAL_RESOLVED_EVENT, { approval_id: `pa-${n}`, granted: true });
      });
      if (n < 3) expect(screen.queryByText(suggestion)).toBeNull();
    }
    expect(await screen.findByText(suggestion)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    await waitFor(() => expect(invokedWith("tools_grant_set_mode")).toEqual([{ grantId: "g1", mode: "allow" }]));
    expect(await screen.findByText("Actions in Proyecto are now always allowed.")).toBeTruthy();
    // Shown once: remembered for this conversation.
    expect(JSON.parse(window.localStorage.getItem(NUDGE_SHOWN_STORAGE_KEY) ?? "[]")).toEqual([7]);
  });

  it("a denial resets the count", async () => {
    window.localStorage.setItem(FOLDER_SELECTION_STORAGE_KEY, JSON.stringify({ "7": ["g1"] }));
    resetTauri(chatHandlers([row(1, "user", "Tidy")]));
    renderApp("en");
    await screen.findByText("Tidy");
    await waitFor(() => expect(chipLabel()).toBe("Proyecto"));
    const answers = [true, true, false, true, true];
    answers.forEach((granted, n) => {
      act(() => {
        emit(APPROVAL_REQUEST_EVENT, approvalPayload({ approval_id: `pd-${n}`, path: `/Users/ana/Proyecto/f${n}.txt` }));
      });
      act(() => {
        emit(APPROVAL_RESOLVED_EVENT, { approval_id: `pd-${n}`, granted });
      });
    });
    await screen.findAllByText(/Allowed: Delete a file/);
    expect(screen.queryByText(/You are approving many actions/)).toBeNull();
  });
});
