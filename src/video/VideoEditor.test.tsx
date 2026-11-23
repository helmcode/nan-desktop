// @vitest-environment jsdom
// R-V1: the simple editor writes ONLY through the core commands (values,
// scene order and length, picked files by slot), never a path or HTML, and
// hands scene changes to the assistant with the project and time context.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

function setupWith(base: ReturnType<typeof project>, ask = vi.fn()) {
  resetTauri({
    video_get: () => base,
    video_preview: () => PREVIEW,
    video_update: () => base,
    video_export_quota: () => ({ included_seconds: 0, used_seconds: 0, remaining_seconds: 0, period_end: null }),
    preview_release_site: () => null,
  });
  return render(
    <I18nProvider initial="es">
      <VideoEditor profileId="nan" projectId={PROJECT_ID} onClose={() => {}} onAskAssistant={ask} />
    </I18nProvider>,
  );
}

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

  it("asks for a scene change in plain words, with the ids as hidden context", async () => {
    const { ask } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Pedir al asistente un cambio en Cierre" }));
    expect(ask).toHaveBeenCalledWith("Escena «Cierre» (0:03 a 0:07): ", {
      project_id: PROJECT_ID,
      title: "Promo",
      scene_id: "cta",
      scene_title: "Cierre",
      from: 3,
      to: 7.5,
    });
  });

  it("blocks the export on check errors and offers to send them to the assistant", async () => {
    lintResult.problems = [{ file: "compositions/intro.html", severity: "error", code: "missing_root", message: "x" }];
    const { ask } = setup();
    expect(await screen.findByText("1 problema que arreglar antes de exportar.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pedir al asistente que lo arregle" }));
    expect(ask.mock.calls[0][0]).toBe("Arregla los problemas que ha encontrado la revisión automática de este vídeo.");
    expect(ask.mock.calls[0][1]).toEqual({ project_id: PROJECT_ID, title: "Promo", problems: ["missing_root"] });
  });

  it("removes a scene only after the in-app dialog confirms it", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Quitar Inicio" }));
    let dialog = screen.getByRole("alertdialog", { name: "¿Quitar esta escena?" });
    expect(document.activeElement?.textContent).toBe("Cancelar");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(invokedWith("video_update")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Quitar Inicio" }));
    dialog = screen.getByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Quitar" }));
    await waitFor(() => expect(invokedWith("video_update").at(-1)?.patch).toEqual({ scenes: [{ id: "cta", duration: 4.5 }] }));
  });

  it("saves numbers, colors and volume once they settle (one save each)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resetTauri({});
    const base = project();
    base.meta.variables.push({ id: "bar-1", type: "number", label: "Longitud", value: "10" });
    setupWith(base);
    const color = (await screen.findByLabelText("Color de acento")) as HTMLInputElement;
    fireEvent.change(color, { target: { value: "#112233" } });
    fireEvent.change(color, { target: { value: "#445566" } });
    fireEvent.blur(color);
    fireEvent.change(screen.getByLabelText("Longitud"), { target: { value: "6.5" } });
    fireEvent.change(screen.getByLabelText("Volumen de música"), { target: { value: "0.3" } });
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_MS + 10);
    await waitFor(() =>
      expect(invokedWith("video_update").map((c) => c?.patch)).toEqual([
        { values: { accent: "#445566" } },
        { values: { "bar-1": "6.5" } },
        { music_volume: 0.3 },
      ]),
    );
    expect(screen.getByText("30 %")).toBeTruthy();
  });

  it("lets a number be cleared and retyped, saving exactly what was typed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const base = project();
    base.meta.variables.push({ id: "bar-1", type: "number", label: "Longitud", value: "10" });
    setupWith(base);
    const input = (await screen.findByLabelText("Longitud")) as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "1" } });
    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.change(input, { target: { value: "25" } });
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_MS + 10);
    await waitFor(() => expect(invokedWith("video_update").map((c) => c?.patch)).toEqual([{ values: { "bar-1": "25" } }]));
    // Leaving it empty restores the saved value and saves nothing.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("10");
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_MS + 10);
    expect(invokedWith("video_update").length).toBe(1);
  });

  it("re-syncs a field to the value the core normalized", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const base = project();
    base.meta.variables.push({ id: "bar-1", type: "number", label: "Longitud", value: "10" });
    const saved = project();
    saved.meta.variables.push({ id: "bar-1", type: "number", label: "Longitud", value: "6.5" });
    resetTauri({
      video_get: () => base,
      video_preview: () => PREVIEW,
      video_update: () => saved,
      video_export_quota: () => ({ included_seconds: 0, used_seconds: 0, remaining_seconds: 0, period_end: null }),
      preview_release_site: () => null,
    });
    render(
      <I18nProvider initial="es">
        <VideoEditor profileId="nan" projectId={PROJECT_ID} onClose={() => {}} onAskAssistant={() => {}} />
      </I18nProvider>,
    );
    const input = (await screen.findByLabelText("Longitud")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6,5" } });
    await vi.advanceTimersByTimeAsync(TEXT_SAVE_MS + 10);
    await waitFor(() => expect(invokedWith("video_update").at(-1)?.patch).toEqual({ values: { "bar-1": "6.5" } }));
    await waitFor(() => expect(input.value).toBe("6.5"));
  });

  it("uses one line for short texts and more for long ones", async () => {
    setup();
    const field = (await screen.findByLabelText("Titular")) as HTMLTextAreaElement;
    expect(field.rows).toBe(1);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "x".repeat(60) } });
    expect(field.rows).toBe(3);
  });

  it("opens on a frame with content and shows its own timeline only for tall films", async () => {
    const seeks: number[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.seek = (t: number) => seeks.push(t);
    try {
      setup();
      await waitFor(() => expect(document.querySelector("hyperframes-player")).not.toBeNull());
      document.querySelector("hyperframes-player")!.dispatchEvent(new CustomEvent("ready"));
      expect(seeks).toEqual([1]);
      expect(screen.queryByLabelText("Posición en el vídeo")).toBeNull();
    } finally {
      delete proto.seek;
    }
    cleanup();
    resetTauri({
      video_get: () => project(),
      video_preview: () => ({ ...PREVIEW, width: 1080, height: 1920, aspect: "9:16" }),
      video_export_quota: () => ({ included_seconds: 0, used_seconds: 0, remaining_seconds: 0, period_end: null }),
      preview_release_site: () => null,
    });
    render(
      <I18nProvider initial="es">
        <VideoEditor profileId="nan" projectId={PROJECT_ID} onClose={() => {}} onAskAssistant={() => {}} />
      </I18nProvider>,
    );
    expect(await screen.findByLabelText("Posición en el vídeo")).toBeTruthy();
  });

  it("returns the focus to the button that opened the dialog, and names formats in words", async () => {
    setup();
    const trigger = await screen.findByRole("button", { name: "Quitar Inicio" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("alertdialog", { name: "¿Quitar esta escena?" }).textContent).toContain(
      "«Inicio» deja de formar parte del vídeo.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("radio", { name: "Vertical 9:16" }).textContent).toContain("Vertical");
  });

  it("keeps the playhead when a change reloads the preview", async () => {
    const seeks: number[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.seek = (t: number) => seeks.push(t);
    try {
      let n = 0;
      setup();
      resetTauri({
        video_get: () => project(),
        video_preview: () => ({ ...PREVIEW, url: `nan-site://localhost/${String(++n).padStart(32, "0")}` }),
        video_update: () => project(),
        video_export_quota: () => ({ included_seconds: 0, used_seconds: 0, remaining_seconds: 0, period_end: null }),
        preview_release_site: () => null,
      });
      cleanup();
      render(
        <I18nProvider initial="es">
          <VideoEditor profileId="nan" projectId={PROJECT_ID} onClose={() => {}} onAskAssistant={() => {}} />
        </I18nProvider>,
      );
      await waitFor(() => expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toContain("01"));
      const first = document.querySelector("hyperframes-player")!;
      first.dispatchEvent(new CustomEvent("timeupdate", { detail: { currentTime: 5.5 } }));
      fireEvent.click(screen.getByRole("radio", { name: "Cuadrado 1:1" }));
      await waitFor(() => expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toContain("02"));
      document.querySelector("hyperframes-player")!.dispatchEvent(new CustomEvent("ready"));
      expect(seeks.at(-1)).toBe(5.5);
      // A scene edit lands on that scene's new start instead.
      fireEvent.click(screen.getByRole("button", { name: "Bajar Inicio" }));
      await waitFor(() => expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toContain("03"));
      document.querySelector("hyperframes-player")!.dispatchEvent(new CustomEvent("ready"));
      expect(seeks.at(-1)).toBe(4.5);
    } finally {
      delete proto.seek;
    }
  });

  it("releases its preview token when it closes", async () => {
    const { view } = setup();
    await waitFor(() => expect(document.querySelector("hyperframes-player")).not.toBeNull());
    view.unmount();
    await waitFor(() => expect(invokedWith("preview_release_site")).toContainEqual({ token: TOKEN }));
  });
});
