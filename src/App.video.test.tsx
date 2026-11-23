// @vitest-environment jsdom
// R-V1 in the shell: a video the assistant creates opens in the preview
// pane (sealed player), "Edit video" opens the Videos editor on it, and
// "Ask for a change in this scene" comes back to the chat with the request
// in the composer. The sidebar entry opens the Videos surface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());
vi.mock("@hyperframes/player", () => ({}));
vi.mock("./video/lint", () => ({ lintProject: async () => [], problemsForAssistant: () => "" }));

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";
import { PREVIEW, PROJECT_ID, project } from "./video/fixtures";

function row(id: number, role: string, content: string): ChatMessageRow {
  return { id, conversation_id: 7, role, content, model: null, created_at: "", partial: false, media_path: null, sources: [] };
}

beforeEach(() => {
  window.localStorage.clear();
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [{ id: 7, title: "Vídeo", updated_at: "", last_message: null }],
    messages_list: () => [row(1, "user", "hazme un vídeo")],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    skills_list: () => [],
    artifacts_request: () => ({ status: 200, body: {} }),
    video_preview: () => PREVIEW,
    video_get: () => project(),
    video_list: () => [],
    video_templates: () => [],
    video_export_quota: () => ({ included_seconds: 7200, used_seconds: 0, remaining_seconds: 7200, period_end: null }),
    preview_release_site: () => null,
  });
});
afterEach(() => cleanup());

describe("R-V1: videos in the shell", () => {
  it("opens the video the assistant made, then the editor, then asks for a scene change", async () => {
    render(
      <I18nProvider initial="es">
        <App />
      </I18nProvider>,
    );
    await screen.findByText("hazme un vídeo");
    await act(async () => emit("video://changed", { conversation_id: 7, project_id: PROJECT_ID, title: "Promo" }));
    const pane = await screen.findByRole("complementary", { name: "Vista previa" });
    expect(await within(pane).findByText("Promo")).toBeTruthy();
    await waitFor(() => expect(pane.querySelector("hyperframes-player")?.getAttribute("sandbox-origin")).toBe("opaque"));

    fireEvent.click(within(pane).getByRole("button", { name: "Editar vídeo" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pedir al asistente un cambio en Inicio" }));
    const box = (await screen.findByRole("textbox", { name: "Mensaje" })) as HTMLTextAreaElement;
    expect(box.value).toBe(`En el vídeo «Promo» (project_id ${PROJECT_ID}), escena «Inicio» (de 0:00 a 0:03, ahora en 0:00): `);
  });

  it("has a Videos entry in the sidebar", async () => {
    render(
      <I18nProvider initial="es">
        <App />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Vídeos" }));
    expect(await screen.findByRole("heading", { name: "Vídeos" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Plantillas" })).toBeTruthy();
  });
});
