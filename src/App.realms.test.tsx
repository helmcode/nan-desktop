// @vitest-environment jsdom
//
// Privacy fix (per-user realms): two accounts of the SAME tenant on one
// device. The fake core below keeps one data set per realm and serves
// whichever realm is active, exactly like the Rust core resolves every
// command through the active user's realm. The renderer surfaces covered:
// the history sidebar (conversation_list), the open transcript
// (messages_list), the identity chip, the fresh-realm notice and the
// per-conversation localStorage (folder selection, shown suggestions).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import { FOLDER_SELECTION_STORAGE_KEY } from "./chat/folderSelection";
import type { ChatMessageRow, ConversationView } from "./types";

type Realm = "realm-a" | "realm-b";

const USERS: Record<Realm, string> = { "realm-a": "ana@example.com", "realm-b": "bea@example.com" };

function message(conversationId: number, content: string): ChatMessageRow {
  return {
    id: conversationId * 10,
    conversation_id: conversationId,
    role: "user",
    content,
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
  };
}

/** A core with one data set per realm; `active` is the signed-in realm. */
function realmCore(initial: Realm | null) {
  const state: { active: Realm | null } = { active: initial };
  const conversations: Record<Realm, ConversationView[]> = {
    "realm-a": [{ id: 1, title: "Ana private plans", updated_at: "", last_message: "A-SECRET" }],
    "realm-b": [],
  };
  const messages: Record<Realm, ChatMessageRow[]> = {
    "realm-a": [message(1, "A-SECRET transcript")],
    "realm-b": [],
  };
  resetTauri({
    profiles_load: () =>
      state.active
        ? {
            profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
            active_profile: "nan",
            active_user: { email: USERS[state.active], realm: state.active },
          }
        : {
            profiles: [{ id: "nan", name: "NaN", has_key: false, key_mask: null }],
            active_profile: null,
            active_user: null,
          },
    // Every realm-scoped command answers from the ACTIVE realm only.
    conversation_list: () => (state.active ? conversations[state.active] : []),
    messages_list: () => (state.active ? messages[state.active] : []),
    device_login_start: () => undefined,
    device_logout: () => {
      state.active = null;
    },
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    skills_list: () => [],
  });
  return state;
}

function renderApp() {
  return render(
    <I18nProvider initial="en">
      <App />
    </I18nProvider>,
  );
}

async function signOut(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /Account menu/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
  await screen.findByText("Choose how to sign in:");
}

/** Pick the NaN card, then the core approves the device login of `realm`. */
async function signIn(state: { active: Realm | null }, realm: Realm, fresh: boolean): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /NaN/ }));
  await waitFor(() => expect(invokedWith("device_login_start").length).toBeGreaterThan(0));
  state.active = realm;
  await act(async () => {
    emit("device://approved", { key_alias: "desktop", profile_id: "nan", fresh_realm: fresh });
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe("privacy fix: per-user realms in the UI", () => {
  it("a second user of the same tenant sees none of the first user's chats, then A gets them back", async () => {
    const state = realmCore("realm-a");
    renderApp();
    expect(await screen.findByText("Ana private plans")).toBeTruthy();
    expect(screen.getByText("ana@example.com")).toBeTruthy();

    await signOut();
    await signIn(state, "realm-b", true);

    // B: the chip names B, the sidebar and the chat are empty, and the
    // empty state says this is a fresh space on this computer.
    expect(await screen.findByText("bea@example.com")).toBeTruthy();
    expect(
      await screen.findByText(
        "Signed in as bea@example.com for the first time on this computer. You start with an empty space: nothing from other accounts is shown here.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Ana private plans")).toBeNull();
    expect(screen.queryByText(/A-SECRET/)).toBeNull();
    expect(screen.queryByText("ana@example.com")).toBeNull();

    // A signs back in: their realm (and only theirs) is back, no notice.
    await signOut();
    await signIn(state, "realm-a", false);
    expect(await screen.findByText("Ana private plans")).toBeTruthy();
    expect(screen.getByText("ana@example.com")).toBeTruthy();
    expect(screen.queryByText(/for the first time on this computer/)).toBeNull();
  });

  it("the login identity failure is explained and nothing switches", async () => {
    const state = realmCore(null);
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: /NaN/ }));
    await waitFor(() => expect(invokedWith("device_login_start").length).toBeGreaterThan(0));
    await act(async () => {
      emit("device://error", { kind: "identity" });
    });
    expect(
      await screen.findByText("We could not confirm which account signed in, so nothing changed. Try again."),
    ).toBeTruthy();
    expect(state.active).toBeNull();
    expect(screen.queryByText("Ana private plans")).toBeNull();
  });

  it("per-conversation folder selections are stored per realm", async () => {
    // A's selection for its conversation 1 must not apply to B's
    // conversation 1 (ids restart in every realm database).
    window.localStorage.setItem(`${FOLDER_SELECTION_STORAGE_KEY}:realm-a`, JSON.stringify({ "1": ["g-of-a"] }));
    realmCore("realm-b");
    renderApp();
    await screen.findByText("bea@example.com");
    await waitFor(() =>
      expect(window.localStorage.getItem(`${FOLDER_SELECTION_STORAGE_KEY}:realm-b`)).not.toBeNull(),
    );
    expect(JSON.parse(window.localStorage.getItem(`${FOLDER_SELECTION_STORAGE_KEY}:realm-b`) ?? "{}")).toEqual({});
    // A's stored selection is untouched (and never read for B).
    expect(JSON.parse(window.localStorage.getItem(`${FOLDER_SELECTION_STORAGE_KEY}:realm-a`) ?? "{}")).toEqual({
      "1": ["g-of-a"],
    });
  });
});
