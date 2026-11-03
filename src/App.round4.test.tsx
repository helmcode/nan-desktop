// @vitest-environment jsdom
// Round 4 UI flows over the mocked Tauri IPC (the same event/command wire
// the Rust core speaks): auto-open of produced artifacts, the generate_image
// tool rendered inline, per-conversation image mode, and the shell
// surviving a conversation switch after a PDF was produced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";

const SIGNED_IN = {
  profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
  active_profile: "nan",
};

function row(
  id: number,
  conversationId: number,
  role: string,
  content: string,
  extra: Partial<ChatMessageRow> = {},
): ChatMessageRow {
  return {
    id,
    conversation_id: conversationId,
    role,
    content,
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
    ...extra,
  };
}

/// Mutable per-conversation rows: tests append what the core "persisted".
let store: Map<number, ChatMessageRow[]>;

function handlers(extra: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {}) {
  return {
    profiles_load: () => SIGNED_IN,
    conversation_list: () => [
      { id: 7, title: "Report", updated_at: "", last_message: null },
      { id: 8, title: "Other", updated_at: "", last_message: null },
    ],
    messages_list: (args: Record<string, unknown> | undefined) => store.get(Number(args?.conversationId)) ?? [],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [
      { id: "g1", canonical_path: "/Users/ana/Proyecto", granted_at: "", profile_id: "nan", scope: "folder", mode: "ask" },
    ],
    chat_send: () => undefined,
    image_generate: () => undefined,
    tts_stop: () => undefined,
    ...extra,
  };
}

function renderApp() {
  return render(
    <I18nProvider initial="en">
      <App />
    </I18nProvider>,
  );
}

const previewPane = () => screen.findByRole("complementary", { name: "Preview" });
const queryPreviewPane = () => screen.queryByRole("complementary", { name: "Preview" });

async function sendMessage(text: string, label = "Message"): Promise<void> {
  const box = await screen.findByRole("textbox", { name: label });
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
}

beforeEach(() => {
  window.localStorage.clear();
  store = new Map([
    [7, [row(1, 7, "user", "hola")]],
    [8, [row(50, 8, "user", "other chat")]],
  ]);
});

afterEach(cleanup);

describe("auto-open of produced artifacts (round 4)", () => {
  it("opens the file a reply produced, replaces it with a later one, and respects a close", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("hola");
    expect(queryPreviewPane()).toBeNull();

    // Reply 1 produced a PDF → the pane opens it by itself.
    await sendMessage("make a pdf");
    store.get(7)!.push(
      row(2, 7, "assistant", "Done.", { artifacts: [{ path: "/Users/ana/Proyecto/report.pdf", kind: "file" }] }),
    );
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    const pane = await previewPane();
    await waitFor(() => expect(within(pane).getByTitle("/Users/ana/Proyecto/report.pdf")).toBeTruthy());

    // Reply 2 produced two files → the LAST one replaces the PDF.
    await sendMessage("now a page and a sheet");
    store.get(7)!.push(
      row(3, 7, "assistant", "Both saved.", {
        artifacts: [
          { path: "/Users/ana/Proyecto/web/index.html", kind: "file" },
          { path: "/Users/ana/Proyecto/data.csv", kind: "file" },
        ],
      }),
    );
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    await waitFor(async () =>
      expect(within(await previewPane()).getByTitle("/Users/ana/Proyecto/data.csv")).toBeTruthy(),
    );

    // The user closes it; a reply that produced nothing leaves it closed.
    fireEvent.click(within(await previewPane()).getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(queryPreviewPane()).toBeNull());
    await sendMessage("thanks");
    store.get(7)!.push(row(4, 7, "assistant", "You're welcome."));
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    await screen.findByText("You're welcome.");
    expect(queryPreviewPane()).toBeNull();
  });

  it("switching conversations never opens anything by itself", async () => {
    store.set(8, [
      row(50, 8, "user", "old"),
      row(51, 8, "assistant", "old file", { artifacts: [{ path: "/Users/ana/Proyecto/old.pdf", kind: "file" }] }),
    ]);
    resetTauri(handlers());
    renderApp();
    await screen.findByText("hola");
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await screen.findByText("old file");
    expect(queryPreviewPane()).toBeNull();
  });

  it("a reply that finishes in a background conversation is open when the user returns", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("hola");
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await screen.findByText("other chat");
    store.get(7)!.push(
      row(2, 7, "assistant", "Done.", { artifacts: [{ path: "/Users/ana/Proyecto/report.pdf", kind: "file" }] }),
    );
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    // Not on screen now (conversation 8 has no pane)...
    expect(queryPreviewPane()).toBeNull();
    // ...but conversation 7 shows it when the user goes back.
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    const pane = await previewPane();
    expect(within(pane).getByTitle("/Users/ana/Proyecto/report.pdf")).toBeTruthy();
  });
});

describe("generate_image tool end to end over the event wire (round 4)", () => {
  it("chat send → generating_image activity → done → inline image + pane opens it", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("hola");
    await sendMessage("dibuja un zorro en la nieve");
    await waitFor(() => expect(invokedWith("chat_send")[0]?.content).toBe("dibuja un zorro en la nieve"));

    await act(async () => emit("chat://activity", { conversation_id: 7, activity: "generating_image" }));
    expect(await screen.findByText(/Creating the image/)).toBeTruthy();

    // The core downloaded the presigned url and saved it under app_data/images.
    store.get(7)!.push(
      row(2, 7, "assistant", "Aquí está tu zorro.", {
        artifacts: [{ path: "/Users/ana/Library/Application Support/x/images/fox.png", kind: "image" }],
      }),
    );
    await act(async () => emit("chat://done", { conversation_id: 7 }));

    const inline = await screen.findByRole("img", { name: "Image created by the assistant" });
    expect(inline.getAttribute("src")).toBe("asset://localhost//Users/ana/Library/Application Support/x/images/fox.png");
    const pane = await previewPane();
    const shown = await within(pane).findByRole("img", { name: "fox.png" });
    expect(shown.getAttribute("src")).toBe("asset://localhost//Users/ana/Library/Application Support/x/images/fox.png");
    // A generated image is shown through the asset protocol, never read
    // through the grant-checked file API.
    expect(invokedWith("preview_read_file")).toEqual([]);
    expect(screen.queryByText(/Creating the image/)).toBeNull();
  });

  it("the composer's image mode result opens in the pane too", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("hola");
    fireEvent.click(screen.getByRole("button", { name: "Create image" }));
    await sendMessage("a red fox", "Image description");
    await waitFor(() =>
      expect(invokedWith("image_generate")).toEqual([{ conversationId: 7, prompt: "a red fox", size: "1024x1024" }]),
    );
    await act(async () => emit("images://started", { conversation_id: 7 }));
    store.get(7)!.push(row(2, 7, "assistant", "a red fox", { model: "qwen-image-2.1", media_path: "/data/images/r.png" }));
    await act(async () => emit("images://done", { conversation_id: 7, media_path: "/data/images/r.png" }));
    const pane = await previewPane();
    expect((await within(pane).findByRole("img", { name: "r.png" })).getAttribute("src")).toBe(
      "asset://localhost//data/images/r.png",
    );
  });
});

describe("image mode is per conversation (round 4)", () => {
  it("does not leak across chats and is remembered per chat", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("hola");
    fireEvent.click(screen.getByRole("button", { name: "Create image" }));
    expect(await screen.findByRole("textbox", { name: "Image description" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    await screen.findByText("other chat");
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create image" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    await screen.findByText("hola");
    expect(screen.getByRole("textbox", { name: "Image description" })).toBeTruthy();
  });

  it("a new chat starts in text mode and keeps the mode it was given once created", async () => {
    resetTauri(handlers({ conversation_create: () => 9 }));
    renderApp();
    await screen.findByText("hola");
    fireEvent.click(screen.getByRole("button", { name: "Create image" }));
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create image" }));
    store.set(9, []);
    await sendMessage("a boat", "Image description");
    await waitFor(() => expect(invokedWith("image_generate")[0]?.conversationId).toBe(9));
    // The created row adopted the blank chat's image mode.
    expect(screen.getByRole("textbox", { name: "Image description" })).toBeTruthy();
  });
});
