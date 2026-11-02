// @vitest-environment jsdom
// Round 5 / TASK 3: a conversation whose first message was just sent shows
// up in the sidebar IMMEDIATELY, in its streaming state, and stays there
// when the user switches away; coming back shows the live stream (still
// growing from the same deltas) instead of the core's in-progress row.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

function row(id: number, conversationId: number, role: string, content: string, partial = false): ChatMessageRow {
  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    model: null,
    created_at: "",
    partial,
    media_path: null,
    sources: [],
  };
}

/// What the core has persisted: conversations (most recent first) and rows.
let conversations: ConversationView[];
let rows: Map<number, ChatMessageRow[]>;

function handlers(chatSend: (args: Record<string, unknown> | undefined) => unknown) {
  return {
    profiles_load: () => SIGNED_IN,
    conversation_list: () => conversations.map((c) => ({ ...c })),
    conversation_create: () => {
      // The core inserts the row (empty title → untitled fallback).
      conversations = [{ id: 9, title: "Nueva conversación", updated_at: "", last_message: null }, ...conversations];
      rows.set(9, []);
      return 9;
    },
    messages_list: (args: Record<string, unknown> | undefined) => rows.get(Number(args?.conversationId)) ?? [],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    chat_send: chatSend,
    chat_stop: () => undefined,
    tts_stop: () => undefined,
  };
}

/// chat_send as the core does it: title + user row + in-progress assistant
/// row persisted, stream task spawned, command returns.
function persistingSend(args: Record<string, unknown> | undefined): undefined {
  const id = Number(args?.conversationId);
  const content = String(args?.content);
  conversations = conversations.map((c) => (c.id === id ? { ...c, title: content } : c));
  rows.set(id, [...(rows.get(id) ?? []), row(100, id, "user", content), row(101, id, "assistant", "", true)]);
  return undefined;
}

function renderApp() {
  return render(
    <I18nProvider initial="en">
      <App />
    </I18nProvider>,
  );
}

const history = () => screen.getByRole("navigation", { name: "History" });

/// The sidebar row for one conversation, found by its exact title (the
/// accessible name composes title + streaming state + nested controls, so a
/// name-regex would match the row AND its delete button).
async function convRow(title: string): Promise<HTMLButtonElement> {
  await waitFor(() => {
    const rows = Array.from(history().querySelectorAll<HTMLButtonElement>(".conv-main")).filter(
      (b) => b.getAttribute("title") === title,
    );
    expect(rows).toHaveLength(1);
  });
  return Array.from(history().querySelectorAll<HTMLButtonElement>(".conv-main")).find(
    (b) => b.getAttribute("title") === title,
  ) as HTMLButtonElement;
}

async function sendMessage(text: string): Promise<void> {
  const box = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
}

beforeEach(() => {
  window.localStorage.clear();
  conversations = [{ id: 8, title: "Other", updated_at: "", last_message: null }];
  rows = new Map([[8, [row(50, 8, "user", "other chat"), row(51, 8, "assistant", "other answer")]]]);
});

afterEach(cleanup);

describe("in-flight conversations in the sidebar (round 5)", () => {
  it("registers a new conversation the moment it is sent, before chat_send even resolves", async () => {
    // chat_send never resolves: the list must not depend on it.
    resetTauri(handlers(() => new Promise(() => {})));
    renderApp();
    await screen.findByText("other chat");
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    await sendMessage("  plan   my trip ");

    const item = await convRow("plan my trip");
    expect(item.getAttribute("aria-current")).toBe("page");
    // Streaming state, announced and visible on the row.
    expect(within(item).getByText("Replying")).toBeTruthy();
    expect(item.closest(".conv-item")?.classList.contains("streaming")).toBe(true);
    // No terminal event was needed.
    expect(invokedWith("chat_send")).toHaveLength(1);
  });

  it("refreshes to the core's real title once chat_send resolves", async () => {
    resetTauri(handlers(persistingSend));
    renderApp();
    await screen.findByText("other chat");
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    await sendMessage("plan my trip");
    // Exactly one row: counted by the row's title attribute (the accessible
    // name of the row composes title + streaming state + nested controls).
    await waitFor(() =>
      expect(
        Array.from(history().querySelectorAll<HTMLButtonElement>(".conv-main")).filter(
          (b) => b.getAttribute("title") === "plan my trip",
        ),
      ).toHaveLength(1),
    );
    // The row was not duplicated and the untitled fallback never stuck.
    expect(within(history()).queryByText("Nueva conversación")).toBeNull();
    expect(invokedWith("conversation_list").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps streaming across a switch away and back, and never aborts the stream", async () => {
    resetTauri(handlers(persistingSend));
    renderApp();
    await screen.findByText("other chat");
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    await sendMessage("plan my trip");
    await act(async () => emit("chat://delta", { conversation_id: 9, delta: "Day one: " }));
    await screen.findByText(/Day one:/);

    // Switch away while the reply is still streaming.
    fireEvent.click(await convRow("Other"));
    await screen.findByText("other answer");
    expect(screen.queryByText(/Day one:/)).toBeNull();
    // The new chat is still listed, still flagged as replying.
    const item = await convRow("plan my trip");
    expect(within(item).getByText("Replying")).toBeTruthy();

    // Deltas keep arriving for the chat we are not looking at.
    await act(async () => emit("chat://delta", { conversation_id: 9, delta: "the coast." }));

    // Back: the live stream continues, one assistant bubble, no "interrupted".
    fireEvent.click(await convRow("plan my trip"));
    await screen.findByText("Day one: the coast.");
    await waitFor(() => expect(screen.getAllByText("plan my trip", { selector: ".msg-user-text" })).toHaveLength(1));
    expect(screen.queryByText("The reply was interrupted.")).toBeNull();
    expect(document.querySelectorAll(".msg-assistant")).toHaveLength(1);
    expect(invokedWith("chat_stop")).toHaveLength(0);

    await act(async () => emit("chat://delta", { conversation_id: 9, delta: " Day two." }));
    await screen.findByText("Day one: the coast. Day two.");

    // The reply ends: the indicator goes away, the complete row is shown.
    rows.set(9, [row(100, 9, "user", "plan my trip"), row(101, 9, "assistant", "Day one: the coast. Day two.")]);
    await act(async () => emit("chat://done", { conversation_id: 9 }));
    await waitFor(async () =>
      expect(within(await convRow("plan my trip")).queryByText("Replying")).toBeNull(),
    );
    expect(screen.getByText("Day one: the coast. Day two.")).toBeTruthy();
  });
});
