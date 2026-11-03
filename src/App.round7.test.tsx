// @vitest-environment jsdom
// Round 7 spec (designer feedback): the composer's image button must not look
// like "attach a file". It uses a sparkle icon (not a picture frame), has the
// tooltip "Create image", and when the mode is ON the placeholder asks for the
// image to create and the button shows the active accent state. Also: images
// in the chat get the hover download icon.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { Locale } from "./i18n/locale";
import { IconImage, IconPlus, IconSparkles } from "./icons";
import type { ChatMessageRow } from "./types";

const SIGNED_IN = {
  profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
  active_profile: "nan",
};

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

let rows: ChatMessageRow[];

function handlers(extra: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {}) {
  return {
    profiles_load: () => SIGNED_IN,
    conversation_list: () => [{ id: 7, title: "Report", updated_at: "", last_message: null }],
    messages_list: () => rows,
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    chat_send: () => undefined,
    image_generate: () => undefined,
    tts_stop: () => undefined,
    update_check: () => null,
    ...extra,
  };
}

function renderApp(locale: Locale = "en") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

/// The inner markup of an icon, to compare which glyph a button shows.
function glyph(node: Element | null): string {
  return node?.querySelector("svg")?.innerHTML ?? "";
}
function iconGlyph(el: ReactElement): string {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(el);
  return glyph(host);
}

beforeEach(() => {
  window.localStorage.clear();
  rows = [row(1, "user", "hola")];
});
afterEach(cleanup);

describe("composer image mode clarity (round 7)", () => {
  it("uses a sparkle icon, not the picture frame nor the attach plus", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("hola");
    const toggle = screen.getByRole("button", { name: "Create image" });
    expect(glyph(toggle)).toBe(iconGlyph(<IconSparkles />));
    expect(glyph(toggle)).not.toBe(iconGlyph(<IconImage />));
    expect(glyph(toggle)).not.toBe(iconGlyph(<IconPlus />));
  });

  it("has the tooltip 'Create image' and switches placeholder + accent state when active", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("hola");
    const toggle = screen.getByRole("button", { name: "Create image" });
    expect(toggle.getAttribute("title")).toBe("Create image");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.classList.contains("active")).toBe(false);
    const box = screen.getByRole("textbox", { name: "Message" });
    expect(box.getAttribute("placeholder")).toBe("Write a message");

    fireEvent.click(toggle);
    const active = screen.getByRole("button", { name: "Back to messages" });
    expect(active).toBe(toggle);
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(active.classList.contains("active")).toBe(true);
    expect(active.classList.contains("image-toggle")).toBe(true);
    const imageBox = screen.getByRole("textbox", { name: "Image description" });
    expect(imageBox.getAttribute("placeholder")).toBe("Describe the image to create…");
    expect(imageBox.closest(".composer-box")?.classList.contains("image-mode")).toBe(true);

    fireEvent.click(active);
    expect(screen.getByRole("textbox", { name: "Message" }).getAttribute("placeholder")).toBe("Write a message");
  });

  it("speaks Spanish", async () => {
    resetTauri(handlers());
    renderApp("es");
    await screen.findByText("hola");
    const toggle = screen.getByRole("button", { name: "Crear imagen" });
    expect(toggle.getAttribute("title")).toBe("Crear imagen");
    fireEvent.click(toggle);
    expect(screen.getByRole("textbox", { name: "Descripción de la imagen" }).getAttribute("placeholder")).toBe(
      "Describe la imagen que quieres crear…",
    );
  });
});

describe("chat images get the hover download icon (round 7)", () => {
  it("an image-mode result and a tool image both carry it, wired to Save-as", async () => {
    rows = [
      row(1, "user", "hola"),
      row(2, "assistant", "a red fox", { media_path: "/data/images/r.png" }),
      row(3, "assistant", "Here it is.", { artifacts: [{ path: "/data/images/t.png", kind: "image" }] }),
    ];
    resetTauri(handlers({ image_save_as: () => null }));
    renderApp();
    await screen.findByText("Here it is.");
    const icons = screen.getAllByRole("button", { name: "Download image" });
    expect(icons).toHaveLength(2);
    // The existing "Save as…" buttons stay.
    expect(screen.getAllByRole("button", { name: "Save as…" })).toHaveLength(2);
    fireEvent.click(icons[1]);
    await waitFor(() => expect(invokedWith("image_save_as")).toEqual([{ sourcePath: "/data/images/t.png" }]));
  });
});
