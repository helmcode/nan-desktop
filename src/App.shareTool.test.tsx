// @vitest-environment jsdom
// share_artifact in the app shell: `chat_send` tells the core to offer the
// tool only when shared links are on for the account (/api/auth/me), and a
// reply that shared something shows its link card with copy and open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow, SharedLink } from "./types";

const LINK: SharedLink = {
  url: "https://artifacts.nan.builders/a/tok-1",
  title: "Calculadora",
  scope: "public",
  recipients: [],
  expires_at: "2026-11-25T10:00:00Z",
};

function row(id: number, role: string, content: string, extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return { id, conversation_id: 7, role, content, model: null, created_at: "", partial: false, media_path: null, sources: [], ...extra };
}

function setup(me: Record<string, unknown> | null, messages: ChatMessageRow[] = [row(1, "user", "hola"), row(2, "assistant", "¿Qué tal?")]) {
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [{ id: 7, title: "Chat", updated_at: "", last_message: null }],
    messages_list: () => messages,
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    skills_list: () => [],
    chat_send: () => undefined,
    artifacts_request: (args) => {
      if (args?.path === "/api/auth/me") return me ? { status: 200, body: me } : { status: 401, body: null };
      return { status: 200, body: { artifacts: [] } };
    },
  });
}

function renderApp() {
  return render(
    <I18nProvider initial="es">
      <App />
    </I18nProvider>,
  );
}

async function sendHello() {
  await screen.findByText("¿Qué tal?");
  fireEvent.change(screen.getByRole("textbox", { name: "Mensaje" }), { target: { value: "comparte la web" } });
  fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
  await waitFor(() => expect(invokedWith("chat_send")).toHaveLength(1));
  return invokedWith("chat_send")[0];
}

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("share_artifact offer", () => {
  it("asks the core to offer the tool when shared links are on", async () => {
    setup({ email: "ana@acme.com", entitlements: { artifacts: true } });
    renderApp();
    await waitFor(() => expect(invokedWith("artifacts_request").length).toBeGreaterThan(0));
    // The access answer arrives before the user types.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await sendHello()).toMatchObject({ artifacts: "on" });
  });

  it("behind the paywall only says so (the core adds a hint, no tool); nothing when /me fails", async () => {
    setup({ email: "ana@acme.com", entitlements: { artifacts: false } });
    renderApp();
    await waitFor(() => expect(invokedWith("artifacts_request").length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await sendHello()).toMatchObject({ artifacts: "paywall" });
    cleanup();

    setup(null);
    renderApp();
    expect(await sendHello()).not.toHaveProperty("artifacts");
  });
});

describe("share_artifact link card", () => {
  it("shows the link the reply created, with copy and open", async () => {
    setup({ email: "ana@acme.com", entitlements: { artifacts: true } }, [
      row(1, "user", "compártela en público"),
      row(2, "assistant", "Aquí tienes el enlace.", { shares: [LINK] }),
    ]);
    renderApp();
    expect(await screen.findByRole("list", { name: "Enlaces compartidos en esta respuesta" })).toBeTruthy();
    expect(screen.getByText(LINK.url)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Abrir Calculadora en el navegador" }));
    expect(invokedWith("open_external")).toEqual([{ url: LINK.url }]);
    expect(screen.getByRole("button", { name: "Copiar el enlace de Calculadora" })).toBeTruthy();
  });

  it("a reply that is only a share still renders", async () => {
    setup(null, [row(1, "user", "compártela"), row(2, "assistant", "", { shares: [LINK] })]);
    renderApp();
    expect(await screen.findByText(LINK.url)).toBeTruthy();
  });
});
