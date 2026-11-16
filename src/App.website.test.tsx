// @vitest-environment jsdom
// R20-D in the shell: the assistant builds a mini website (write_website),
// the core writes it to the session folder and declares it the turn's
// deliverable. The preview opens it, shows its text safely (the HTML
// preview is the whitelist renderer: no scripts, styles, images or frames
// run inside the app) and the header offers Share, which uploads exactly
// that file.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";

const SESSION = "/private/var/folders/x/T/helmcode-desktop/abc/conversation-7";
const SITE_PATH = `${SESSION}/website-panaderia-ana.html`;
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const SITE = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Panadería Ana</title>
<style>body{font-family:system-ui;background:url(data:image/png;base64,${PIXEL})}</style></head>
<body><h1>Pan del día</h1><img src="data:image/png;base64,${PIXEL.repeat(2000)}" alt="logo">
<p>Abrimos a las 8.</p><script>document.body.dataset.ran = "yes";</script></body></html>`;

function row(id: number, role: string, content: string, extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return { id, conversation_id: 7, role, content, model: null, created_at: "", partial: false, media_path: null, sources: [], ...extra };
}

function setup(messages: ChatMessageRow[]): void {
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: "helmcode", name: "Helmcode", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "helmcode",
    }),
    conversation_list: () => [{ id: 7, title: "Web", updated_at: "", last_message: null }],
    messages_list: () => messages,
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    skills_list: () => [],
    chat_send: () => undefined,
    preview_read_file: () => ({ base64: Buffer.from(SITE, "utf8").toString("base64"), size: SITE.length }),
    artifacts_request: (args) =>
      args?.path === "/api/auth/me"
        ? { status: 200, body: { email: "ana@acme.com", featureFlags: ["artifacts"], artifacts: true } }
        : { status: 200, body: { items: [] } },
    artifact_share: () => ({
      status: 201,
      body: { artifact: { id: "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e" }, url: "https://share.helmcode.com/a/web" },
    }),
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("R20-D: a website the assistant built", () => {
  it("opens in the preview, renders its text safely, and shares that exact file", async () => {
    const messages = [row(1, "user", "hola")];
    setup(messages);
    render(
      <I18nProvider initial="es">
        <App />
      </I18nProvider>,
    );
    await screen.findByText("hola");
    const box = await screen.findByRole("textbox", { name: "Mensaje" });
    fireEvent.change(box, { target: { value: "hazme una web para mi panadería" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await act(async () =>
      emit("chat://output", { conversation_id: 7, path: SITE_PATH, role: "deliverable", kind: "document" }),
    );
    messages.push(row(2, "user", "hazme una web para mi panadería"), {
      ...row(3, "assistant", `Tu web está lista:\n${SITE_PATH}`),
      artifacts: [{ path: SITE_PATH, kind: "file" }],
    });
    await act(async () => emit("chat://done", { conversation_id: 7 }));

    const pane = await screen.findByRole("complementary", { name: "Vista previa" });
    await waitFor(() => expect(within(pane).getByTitle(SITE_PATH)).toBeTruthy());
    // The text renders; nothing executable or fetched does (whitelist).
    expect(await within(pane).findByText("Pan del día")).toBeTruthy();
    expect(within(pane).getByText("Abrimos a las 8.")).toBeTruthy();
    expect(pane.querySelector("script, style, img, iframe")).toBeNull();
    expect(document.body.dataset.ran).toBeUndefined();

    fireEvent.click(within(pane).getByRole("button", { name: "Compartir website-panaderia-ana.html como enlace" }));
    const dialog = await screen.findByRole("dialog", { name: "Compartir como enlace" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Toda tu organización/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear enlace" }));
    expect(await screen.findByRole("dialog", { name: "Tu enlace está listo" })).toBeTruthy();
    expect(invokedWith("artifact_share")[0]?.source).toEqual({ kind: "file", path: SITE_PATH });
  });
});

// The model-facing wiring lives in the core; keep the renderer's view of it
// honest: the tool is offered on every reply and its guidance rides on the
// system prompt, next to save_chat_as_skill's.
describe("R20-D: write_website prompt wiring (core source)", () => {
  const chat = readFileSync("src-tauri/src/chat.rs", "utf8").replace(/\r\n/g, "\n");
  const website = readFileSync("src-tauri/src/tools/website.rs", "utf8").replace(/\r\n/g, "\n");

  it("is offered with the always-on tools and its guidance joins the system prompt", () => {
    const defs = /pub fn tool_definitions[\s\S]*?\];/.exec(chat)?.[0] ?? "";
    expect(defs).toContain("tools::website::tool_definition()");
    const prompt = /pub fn system_prompt[\s\S]*?\n}/.exec(chat)?.[0] ?? "";
    expect(prompt).toContain("tools::website::GUIDANCE");
    expect(prompt).toContain("tools::save_skill::GUIDANCE");
  });

  it("tells the model to build ONE self-contained file that works sandboxed", () => {
    const guidance = /pub const GUIDANCE: &str = "([\s\S]*?)";\n/.exec(website)?.[1] ?? "";
    expect(guidance).toContain("call write_website");
    expect(guidance).toContain("ONE self-contained file");
    expect(guidance).toContain("data: URI");
    expect(guidance).toContain("sandboxed");
  });
});
