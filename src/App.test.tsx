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

  it("round 16: one activity line sits right under the last message; the composer has none", async () => {
    resetTauri({ ...chatHandlers([row(1, "user", "Earlier"), row(2, "assistant", "Answer")]), chat_send: () => undefined });
    const { container } = renderApp("es");
    await screen.findByText("Answer");
    const box = await screen.findByRole("textbox", { name: "Mensaje" });
    fireEvent.change(box, { target: { value: "Haz el PDF" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    const lines = container.querySelectorAll('[data-testid="turn-indicator"]');
    expect(lines).toHaveLength(1);
    const bubble = lines[0].closest("article.streaming");
    expect(bubble).not.toBeNull();
    // Directly after the newest message in the flow, not floating elsewhere.
    expect(bubble?.previousElementSibling?.textContent).toContain("Haz el PDF");
    expect(container.querySelector("footer.composer")?.textContent).not.toMatch(/En curso|Pensando/);
    expect(lines[0].textContent).toMatch(/^Pensando· 0 s$/);
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
    expect(await screen.findByRole("heading", { name: "Working folders" })).toBeTruthy();
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
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
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

describe("round 14 review fixes (B1/B2, C6, QA busy state)", () => {
  const settingsHandlers = {
    tools_settings_get: () => ({ tools_allow_run_command: true }),
    memory_settings_get: () => ({ mode: "remote" }),
    app_info: () => ({ version: "0.2.2" }),
  };
  const updateHandlers = (install: () => Promise<void>) => ({
    update_check: () => ({ version: "0.3.0", current_version: "0.2.0" }),
    update_install: install,
  });

  async function openSettings(menuItem = "Settings"): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: menuItem }));
    await screen.findByRole("navigation", { name: "Settings sections" });
  }

  it("B1: Escape closes the account menu and stays in Settings", async () => {
    resetTauri({ ...chatHandlers([row(1, "user", "hi")]), ...settingsHandlers });
    renderApp("en");
    await screen.findByText("hi");
    await openSettings();

    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    // A real key event targets the focused element, which is inside the menu.
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();
  });

  it("B1: Escape closes the whole-computer dialog and stays in Settings", async () => {
    resetTauri({ ...chatHandlers([row(1, "user", "hi")]), ...settingsHandlers });
    renderApp("en");
    await screen.findByText("hi");
    await openSettings("Working folders");

    fireEvent.click(await screen.findByRole("button", { name: /Give access to the whole computer/ }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
  });

  it("C6: the Account section offers the update and shares the busy state", async () => {
    let finish: () => void = () => {};
    resetTauri({
      ...chatHandlers([row(1, "user", "hi")]),
      ...settingsHandlers,
      ...updateHandlers(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    renderApp("en");
    await screen.findByText("hi");
    await openSettings();

    expect(await screen.findByText("A new version is available: 0.3.0")).toBeTruthy();
    const update = screen.getByRole("button", { name: "Update" });
    await act(async () => {
      fireEvent.click(update);
    });
    const busy = screen.getByRole("button", { name: "Updating…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(invokedWith("update_install")).toHaveLength(1);
    await act(async () => finish());
  });

  it("F4: the Settings surface is a region named Settings (region navigation)", async () => {
    resetTauri({ ...chatHandlers([row(1, "user", "hi")]), ...settingsHandlers });
    renderApp("en");
    await screen.findByText("hi");
    await openSettings();
    // The six sections each carry an h1, so the surface names itself instead.
    expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
  });

  it("QA: one install at a time across the banner, the account menu and Settings", async () => {
    let finish: () => void = () => {};
    resetTauri({
      ...chatHandlers([row(1, "user", "hi")]),
      ...settingsHandlers,
      ...updateHandlers(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    renderApp("en");
    await screen.findByText("hi");

    // The install starts from the banner, inside the chat.
    const banner = await screen.findByRole("button", { name: "Update" });
    await act(async () => {
      fireEvent.click(banner);
    });
    await waitFor(() => expect(invokedWith("update_install")).toHaveLength(1));

    // The account menu is busy too, and clicking it starts nothing.
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    const item = await screen.findByRole("menuitem", { name: "Updating…" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(item);
    expect(invokedWith("update_install")).toHaveLength(1);

    // So is the Account section in Settings.
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    await screen.findByRole("navigation", { name: "Settings sections" });
    const inSettings = await screen.findByRole("button", { name: "Updating…" });
    expect(inSettings.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(inSettings);
    expect(invokedWith("update_install")).toHaveLength(1);

    await act(async () => finish());
  });

  it("C1: Skills keeps the Back label of where Settings was opened from", async () => {
    resetTauri({
      ...chatHandlers([
        row(1, "user", "make a fox"),
        { ...row(2, "assistant", "a red fox"), media_path: "/data/images/r.png" },
      ]),
      ...settingsHandlers,
      preview_read_file: () => {
        throw "unavailable";
      },
      image_edit_pick: () => {
        throw "source_not_allowed";
      },
      image_edit_stage: () => ({ path: "/data/images/staged/s1.png", name: "s1.png" }),
    });
    renderApp("en");
    await screen.findByText("a red fox");

    // Settings opened from the Studio: its Back returns to the Studio, and
    // the Skills section must say the same (round 14/C1).
    fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
    await screen.findByRole("region", { name: "Image Studio" });
    fireEvent.click(await screen.findByRole("button", { name: "Add reference" }));
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Open Settings to add a working folder" }));
    await screen.findByRole("navigation", { name: "Settings sections" });

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(await screen.findByRole("heading", { name: "Skills", level: 1 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to the Image Studio" })).toBeTruthy();
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

describe("round 17 (S1): the turn's declared deliverable opens in the preview", () => {
  const W = "/Users/ana/Proyecto";
  async function sendText(text: string): Promise<void> {
    const box = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: text } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
  }
  const output = (path: string, role: "deliverable" | "byproduct", kind: "document" | "image" | null = null) =>
    emit("chat://output", { conversation_id: 7, path, role, kind });

  it("owner case: the rendered PDF opens, not the cover render produced after it", async () => {
    const messages = [row(1, "user", "hola")];
    resetTauri({ ...chatHandlers(messages), chat_send: () => undefined });
    renderApp("en");
    await screen.findByText("hola");
    await sendText("crea una presentacion");
    await act(async () => {
      output(`${W}/fonts/Inter.ttf`, "byproduct");
      output(`${W}/Deck.pdf`, "deliverable", "document");
      output(`${W}/s0.png`, "byproduct");
      output(`${W}/Deck.pdf.png`, "byproduct");
    });
    messages.push(row(2, "user", "crea una presentacion"), {
      ...row(3, "assistant", "Listo."),
      artifacts: [
        { path: `${W}/fonts/Inter.ttf`, kind: "file" },
        { path: `${W}/index.html`, kind: "file" },
        { path: `${W}/Deck.pdf`, kind: "file" },
        { path: `${W}/s0.png`, kind: "file" },
        { path: `${W}/check.js`, kind: "file" },
        { path: `${W}/preview.html`, kind: "file" },
        { path: `${W}/Deck.pdf.png`, kind: "file" },
      ],
    });
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    const pane = await screen.findByRole("complementary", { name: "Preview" });
    await waitFor(() => expect(within(pane).getByTitle(`${W}/Deck.pdf`)).toBeTruthy());
    expect(within(pane).queryByTitle(`${W}/Deck.pdf.png`)).toBeNull();
  });

  it("declarations do not leak into the next turn: a byproduct-only turn opens nothing", async () => {
    const messages = [row(1, "user", "hola")];
    resetTauri({ ...chatHandlers(messages), chat_send: () => undefined });
    renderApp("en");
    await screen.findByText("hola");
    await sendText("render it");
    await act(async () => output(`${W}/old.pdf`, "deliverable", "document"));
    await act(async () => emit("chat://error", { conversation_id: 7, kind: "network" }));
    await sendText("check the pages");
    await act(async () => {
      output(`${W}/s1.png`, "byproduct");
      output(`${W}/s2.png`, "byproduct");
    });
    messages.push({
      ...row(3, "assistant", "Checked."),
      artifacts: [
        { path: `${W}/s1.png`, kind: "file" },
        { path: `${W}/s2.png`, kind: "file" },
      ],
    });
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    await screen.findByText("Checked.");
    expect(screen.queryByRole("complementary", { name: "Preview" })).toBeNull();
  });
});

describe("round 17 (S4): the conversation row menu", () => {
  function setupRows() {
    let title = "Report";
    const messages = [row(1, "user", "hola")];
    resetTauri({
      ...chatHandlers(messages),
      conversation_list: () => [{ id: 7, title, updated_at: "", last_message: null }],
      conversation_rename: (args: Record<string, unknown> | undefined) => {
        title = String(args?.title);
        return title;
      },
      conversation_delete: () => undefined,
    });
  }
  const kebab = (title = "Report") => screen.findByRole("button", { name: `Options for "${title}"` });

  it("replaces the trash with a menu button that opens Rename and Delete, and Escape gives focus back", async () => {
    setupRows();
    renderApp("en");
    const button = await kebab();
    expect(screen.queryByRole("button", { name: 'Delete chat "Report"' })).toBeNull();
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    const menu = screen.getByRole("menu", { name: 'Options for "Report"' });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Rename", "Delete"]);
    // The first item takes focus; arrows move between items and wrap.
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("Rename edits inline: Enter saves through the core and focus returns to the menu button", async () => {
    setupRows();
    renderApp("en");
    fireEvent.click(await kebab());
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: 'New name for "Report"' });
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe("Report");
    fireEvent.change(input, { target: { value: "  Q3 board deck " } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(invokedWith("conversation_rename")).toEqual([{ conversationId: 7, title: "Q3 board deck" }]);
    const renamed = await kebab("Q3 board deck");
    expect(screen.queryByRole("textbox", { name: /New name/ })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(renamed));
  });

  it("Escape cancels a rename: nothing is sent and the title stays", async () => {
    setupRows();
    renderApp("en");
    fireEvent.click(await kebab());
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: 'New name for "Report"' });
    fireEvent.change(input, { target: { value: "Nope" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(invokedWith("conversation_rename")).toEqual([]);
    expect(screen.queryByRole("textbox", { name: /New name/ })).toBeNull();
    expect(screen.getByText("Report")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: 'Options for "Report"' })));
  });

  it("an empty or unchanged name sends nothing", async () => {
    setupRows();
    renderApp("en");
    for (const value of ["   ", "Report"]) {
      fireEvent.click(await kebab());
      fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
      const input = screen.getByRole("textbox", { name: 'New name for "Report"' });
      fireEvent.change(input, { target: { value } });
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter" });
      });
    }
    expect(invokedWith("conversation_rename")).toEqual([]);
  });

  it("Delete keeps the destructive two-step confirmation", async () => {
    setupRows();
    renderApp("en");
    fireEvent.click(await kebab());
    fireEvent.click(screen.getByRole("menuitem", { name: 'Delete chat "Report"' }));
    expect(invokedWith("conversation_delete")).toEqual([]);
    const armed = screen.getByRole("menuitem", { name: 'Click again to delete "Report" forever' });
    expect(armed.textContent).toBe("Delete?");
    await act(async () => {
      fireEvent.click(armed);
    });
    expect(invokedWith("conversation_delete")).toEqual([{ conversationId: 7 }]);
  });

  it("speaks Spanish", async () => {
    setupRows();
    renderApp("es");
    fireEvent.click(await screen.findByRole("button", { name: "Opciones de «Report»" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Renombrar", "Eliminar"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Eliminar la conversación «Report»" }));
    expect(screen.getByRole("menuitem", { name: "Pulsa otra vez para eliminar «Report» para siempre" }).textContent).toBe(
      "¿Eliminar?",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Renombrar" }));
    expect(screen.getByRole("textbox", { name: "Nuevo nombre para «Report»" })).toBeTruthy();
  });
});

describe("round 17 (S4): a rename saves once", () => {
  it("a blur fired after Enter (webviews that blur on removal) does not save twice; leaving the field saves", async () => {
    let title = "Report";
    resetTauri({
      ...chatHandlers([row(1, "user", "hola")]),
      conversation_list: () => [{ id: 7, title, updated_at: "", last_message: null }],
      conversation_rename: (args: Record<string, unknown> | undefined) => {
        title = String(args?.title);
        return title;
      },
    });
    renderApp("en");
    fireEvent.click(await screen.findByRole("button", { name: 'Options for "Report"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: 'New name for "Report"' });
    fireEvent.change(input, { target: { value: "Deck" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
    });
    expect(invokedWith("conversation_rename")).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: 'Options for "Deck"' }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const again = screen.getByRole("textbox", { name: 'New name for "Deck"' });
    fireEvent.change(again, { target: { value: "Deck v2" } });
    await act(async () => {
      fireEvent.blur(again);
    });
    expect(invokedWith("conversation_rename")).toEqual([
      { conversationId: 7, title: "Deck" },
      { conversationId: 7, title: "Deck v2" },
    ]);
  });
});
