// @vitest-environment jsdom
// R-V1: the simple editor writes ONLY through the core commands (values,
// scene order and length, picked files by slot), never a path or HTML, and
// hands scene changes to the assistant with the project and time context.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());
vi.mock("@hyperframes/player", () => ({}));
const lintResult = vi.hoisted(() => ({ problems: [] as unknown[] }));
vi.mock("./lint", () => ({
  lintProject: async () => lintResult.problems,
  problemsForAssistant: (p: { code: string }[]) => p.map((x) => `- ${x.code}`).join("\n"),
}));

import { I18nProvider } from "../i18n";
import { invokedWith, resetTauri } from "../test/tauriMock";
import { VideoEditor, TEXT_SAVE_MS } from "./VideoEditor";
import { PREVIEW, PROJECT_ID, TOKEN, project } from "./fixtures";

function setup(ask = vi.fn()) {
  resetTauri({
    video_get: () => project(),
    video_preview: () => PREVIEW,
    video_update: (args) => {
      const patch = (args as { patch: { scenes?: { id: string; duration: number }[] } }).patch;
      const base = project();
      if (patch.scenes) {
        base.meta.scenes = patch.scenes.map((s) => ({ ...base.meta.scenes.find((x) => x.id === s.id)!, duration: s.duration }));
      }
      return base;
    },
    video_pick_asset: () => null,
    video_export_quota: () => ({ included_seconds: 0, used_seconds: 0, remaining_seconds: 0, period_end: null }),
    preview_release_site: () => null,
  });
  const view = render(
    <I18nProvider initial="es">
      <VideoEditor profileId="nan" projectId={PROJECT_ID} onClose={() => {}} onAskAssistant={ask} />
    </I18nProvider>,
  );
  return { view, ask };
}

afterEach(() => {
  cleanup();
  lintResult.problems = [];
  vi.useRealTimers();
});

describe("VideoEditor", () => {
  it("shows the fields, scenes, audio and format of the project", async () => {
    setup();
    expect(await screen.findByLabelText("Titular")).toBeTruthy();
    expect((screen.getByLabelText("Titular") as HTMLInputElement).value).toBe("Hola");
    expect((screen.getByLabelText("Color de acento") as HTMLInputElement).value).toBe("#7c6cff");
    expect(screen.getByText("logo.svg")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir a Inicio (0:00)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ir a Cierre (0:03)" })).toBeTruthy();
    expect(screen.getByText("song.mp3")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Horizontal 16:9" }).getAttribute("aria-checked")).toBe("true");
    expect(await screen.findByText("Listo para exportar.")).toBeTruthy();
    await waitFor(() => expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toBe(PREVIEW.url));
  });

  it("saves a typed text once it settles, as a value of that variable", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    const field = (await screen.findByLabelText("Titular")) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Hola de nuevo" } });
    expect(invokedWith("video_update")).toEqual([]);
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_MS + 10);
    await waitFor(() =>
      expect(invokedWith("video_update")).toEqual([
        { profileId: "nan", projectId: PROJECT_ID, patch: { values: { headline: "Hola de nuevo" } } },
      ]),
    );
  });

  it("reorders, retimes and changes the format through patches", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Bajar Inicio" }));
    await waitFor(() =>
      expect(invokedWith("video_update").at(-1)).toEqual({
        profileId: "nan",
        projectId: PROJECT_ID,
        patch: { scenes: [{ id: "cta", duration: 4.5 }, { id: "intro", duration: 3 }] },
      }),
    );
    const duration = screen.getByLabelText("Duración de Inicio en segundos") as HTMLInputElement;
    fireEvent.change(duration, { target: { value: "6" } });
    fireEvent.blur(duration);
    await waitFor(() => expect(JSON.stringify(invokedWith("video_update").at(-1))).toContain('{"id":"intro","duration":6}'));
    fireEvent.click(screen.getByRole("radio", { name: "Vertical 9:16" }));
    await waitFor(() => expect(invokedWith("video_update").at(-1)).toEqual({ profileId: "nan", projectId: PROJECT_ID, patch: { aspect: "9:16" } }));
  });

  it("picks files by slot (never a path) and removes music by flag", async () => {
    setup();
    const [logo, music] = await screen.findAllByRole("button", { name: "Cambiar" });
    fireEvent.click(logo);
    fireEvent.click(music);
    fireEvent.click(screen.getByRole("button", { name: "Añadir voz en off" }));
    await waitFor(() =>
      expect(invokedWith("video_pick_asset")).toEqual([
        { profileId: "nan", projectId: PROJECT_ID, slot: { kind: "image", variable: "logo" } },
        { profileId: "nan", projectId: PROJECT_ID, slot: { kind: "music" } },
        { profileId: "nan", projectId: PROJECT_ID, slot: { kind: "voice" } },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Quitar: Música" }));
    await waitFor(() => expect(invokedWith("video_update").at(-1)?.patch).toEqual({ remove_music: true }));
  });

  it("asks the assistant for a scene change with the project and scene context", async () => {
    const { ask } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Pedir al asistente un cambio en Cierre" }));
    expect(ask).toHaveBeenCalledWith(`En el vídeo «Promo» (project_id ${PROJECT_ID}), escena «Cierre» (de 0:03 a 0:07): `);
  });

  it("blocks the export on check errors and offers to send them to the assistant", async () => {
    lintResult.problems = [{ file: "compositions/intro.html", severity: "error", code: "missing_root", message: "x" }];
    const { ask } = setup();
    expect(await screen.findByText("1 problema que arreglar antes de exportar.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pedir al asistente que lo arregle" }));
    expect(ask.mock.calls[0][0]).toContain(`project_id ${PROJECT_ID}`);
    expect(ask.mock.calls[0][0]).toContain("- missing_root");
  });

  it("releases its preview token when it closes", async () => {
    const { view } = setup();
    await waitFor(() => expect(document.querySelector("hyperframes-player")).not.toBeNull());
    view.unmount();
    await waitFor(() => expect(invokedWith("preview_release_site")).toContainEqual({ token: TOKEN }));
  });
});
