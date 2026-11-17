// @vitest-environment jsdom
// Turn continuity: when the latest reply's turn ended before the work was
// done (tool_cap, stream_cut, length), the chat shows a calm notice under it
// and a "Continue" button that sends a continuation turn. It never shows
// for finished or user-stopped replies, nor under older replies, nor while
// a reply is running.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow, ConversationView } from "./types";

const SIGNED_IN = {
  profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
  active_profile: "nan",
};

function row(id: number, role: string, content: string, endReason: string | null = null): ChatMessageRow {
  return {
    id,
    conversation_id: 8,
    role,
    content,
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
    end_reason: endReason,
  };
}

let conversations: ConversationView[];
let rows: ChatMessageRow[];

function handlers(chatSend: (args: Record<string, unknown> | undefined) => unknown = () => undefined) {
  return {
    profiles_load: () => SIGNED_IN,
    conversation_list: () => conversations.map((c) => ({ ...c })),
    messages_list: () => rows.map((r) => ({ ...r })),
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    chat_send: chatSend,
    chat_stop: () => undefined,
    tts_stop: () => undefined,
  };
}

function renderApp(locale: "en" | "es" = "en") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  conversations = [{ id: 8, title: "Scraper", updated_at: "", last_message: null }];
});

afterEach(cleanup);

describe("continue an unfinished turn", () => {
  it("offers Continue under a capped reply and sends a flagged continuation", async () => {
    rows = [row(1, "user", "scrape the site"), row(2, "assistant", "Downloaded 40 of 120 pages.", "tool_cap")];
    resetTauri(handlers());
    renderApp("es");
    await screen.findByText("Downloaded 40 of 120 pages.");

    const note = await screen.findByText(/Me he detenido antes de terminar\./);
    expect(note.closest("[role=note]")?.textContent).toContain("muchos pasos");
    const button = screen.getByRole("button", { name: "Continuar" });

    await act(async () => {
      fireEvent.click(button);
    });
    const sends = invokedWith("chat_send");
    expect(sends).toHaveLength(1);
    expect(sends[0]?.content).toBe("Continúa con la tarea donde lo dejaste.");
    expect(sends[0]?.continuation).toBe(true);
    expect(sends[0]?.conversationId).toBe(8);
    // While the continuation runs, the button is gone (no double send).
    await waitFor(() => expect(screen.queryByRole("button", { name: "Continuar" })).toBeNull());
  });

  it("explains a cut connection and a too-long reply in plain words", async () => {
    rows = [row(1, "user", "go"), row(2, "assistant", "Partial answer", "stream_cut")];
    resetTauri(handlers());
    renderApp();
    await screen.findByText(/The connection dropped while I was replying\./);
    cleanup();

    rows = [row(1, "user", "go"), row(2, "assistant", "Long answer", "length")];
    resetTauri(handlers());
    renderApp();
    await screen.findByText(/The reply was too long for a single message\./);
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("still offers Continue when the cut reply has no text yet", async () => {
    rows = [row(1, "user", "build it"), row(2, "assistant", "", "stream_cut")];
    resetTauri(handlers());
    renderApp();
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("shows nothing for finished, stopped or older replies", async () => {
    rows = [row(1, "user", "hi"), row(2, "assistant", "All done.", "completed")];
    resetTauri(handlers());
    renderApp();
    await screen.findByText("All done.");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    cleanup();

    rows = [row(1, "user", "hi"), row(2, "assistant", "Stopped here.", "user_stop")];
    resetTauri(handlers());
    renderApp();
    await screen.findByText("Stopped here.");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    cleanup();

    // A capped reply the user already moved past: only the latest counts.
    rows = [
      row(1, "user", "scrape"),
      row(2, "assistant", "Paused.", "tool_cap"),
      row(3, "user", "thanks"),
      row(4, "assistant", "You're welcome.", "completed"),
    ];
    resetTauri(handlers());
    renderApp();
    await screen.findByText("You're welcome.");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByText(/I stopped before finishing/)).toBeNull();
  });

  it("appears once the turn ends capped, after the reload", async () => {
    rows = [row(1, "user", "first")];
    resetTauri(handlers());
    renderApp();
    await screen.findByText("first");
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();

    rows = [row(1, "user", "first"), row(2, "assistant", "Step 60 done.", "tool_cap")];
    await act(async () => emit("chat://done", { conversation_id: 8, reason: "tool_cap" }));
    expect(await screen.findByRole("button", { name: "Continue" })).toBeTruthy();
  });
});
