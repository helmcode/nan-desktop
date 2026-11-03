// @vitest-environment jsdom
// Round 6 UI flow over the mocked Tauri IPC: "Save as…" on generated images
// (both the composer's image rows and images inside a tool reply) asks the
// core to save exactly that image and reports the outcome in a notice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";

const COMPOSER_IMAGE = "/Users/ana/Library/Application Support/app/images/1111.png";
const TOOL_IMAGE = "/Users/ana/Library/Application Support/app/images/2222.png";

function row(id: number, role: string, content: string, extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
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
    ...extra,
  };
}

function handlers(saveAs: (args: Record<string, unknown> | undefined) => unknown) {
  return {
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [{ id: 7, title: "Arte", updated_at: "", last_message: null }],
    messages_list: () => [
      row(1, "user", "un zorro"),
      row(2, "assistant", "un zorro en la nieve", { media_path: COMPOSER_IMAGE }),
      row(3, "assistant", "Aquí está.", { artifacts: [{ path: TOOL_IMAGE, kind: "image" }] }),
    ],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    image_save_as: saveAs,
  };
}

function renderApp() {
  return render(
    <I18nProvider initial="en">
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("Save as… on generated images (round 6)", () => {
  it("offers it on every generated image and saves exactly the clicked one", async () => {
    resetTauri(handlers(() => "/Users/ana/Desktop/zorro.png"));
    renderApp();
    await screen.findByText("un zorro en la nieve");
    const buttons = await screen.findAllByRole("button", { name: "Save as…" });
    expect(buttons).toHaveLength(2);

    fireEvent.click(buttons[1]);
    await screen.findByText("Image saved to /Users/ana/Desktop/zorro.png");
    expect(invokedWith("image_save_as")).toEqual([{ sourcePath: TOOL_IMAGE }]);

    fireEvent.click(buttons[0]);
    await waitFor(() => expect(invokedWith("image_save_as")).toHaveLength(2));
    expect(invokedWith("image_save_as")[1]).toEqual({ sourcePath: COMPOSER_IMAGE });
  });

  it("tells the user when the image could not be saved", async () => {
    resetTauri(
      handlers(() => {
        throw new Error("cannot write the image");
      }),
    );
    renderApp();
    const [first] = await screen.findAllByRole("button", { name: "Save as…" });
    fireEvent.click(first);
    await screen.findByText("Could not save the image. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Could not save the image. Try again.")).toBeNull());
  });

  it("a cancelled dialog shows no notice", async () => {
    resetTauri(handlers(() => null));
    renderApp();
    const [first] = await screen.findAllByRole("button", { name: "Save as…" });
    fireEvent.click(first);
    await waitFor(() => expect(invokedWith("image_save_as")).toHaveLength(1));
    expect(screen.queryByText(/Image saved to/)).toBeNull();
    expect(screen.queryByText("Could not save the image. Try again.")).toBeNull();
  });
});
