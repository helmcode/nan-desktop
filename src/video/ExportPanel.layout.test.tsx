// @vitest-environment jsdom
// Round 25: the export's layout gate. Every selected format is checked
// before its render starts; the ones that fit export right away, a format
// that would come out cut off is held, named, with "Fix with the assistant"
// and "Export anyway".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());
const checkLayout = vi.fn();
vi.mock("./layoutCheck", async (original) => ({
  ...(await original<typeof import("./layoutCheck")>()),
  checkLayout: (...args: unknown[]) => checkLayout(...args),
}));

import { I18nProvider } from "../i18n";
import { invokedWith, resetTauri } from "../test/tauriMock";
import { ExportPanel, layoutKey } from "./ExportPanel";
import { resetExportQueues } from "./exportQueue";
import { PROJECT_ID, project } from "./fixtures";
import type { LayoutReport } from "./layoutCheck";

const QUOTA = { included_seconds: 7200, used_seconds: 0, remaining_seconds: 7200, period_end: "2026-12-01T00:00:00Z" };
const cut = (scene: string) => ({ scene, time: 1, kind: "clipped" as const, element: '#t "Hola"' });

function renderPanel(props: Partial<Parameters<typeof ExportPanel>[0]> = {}, locale: "es" | "en" = "es") {
  return render(
    <I18nProvider initial={locale}>
      <ExportPanel profileId="nan" project={project()} blocked={false} onExported={() => {}} {...props} />
    </I18nProvider>,
  );
}

/// Pick these formats (the project's own, 16:9, starts selected).
function pick(...names: string[]) {
  for (const name of names) fireEvent.click(screen.getByLabelText(name));
}

beforeEach(() => {
  localStorage.clear();
  resetTauri({
    video_export_quota: () => QUOTA,
    video_export_start: () => new Promise(() => {}),
  });
});
afterEach(() => {
  cleanup();
  resetExportQueues();
});

describe("ExportPanel layout gate", () => {
  it("checks the selected formats first, then exports them when they all fit", async () => {
    let finish: (r: LayoutReport) => void = () => undefined;
    checkLayout.mockReturnValueOnce(new Promise<LayoutReport>((r) => (finish = r)));
    renderPanel();
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect(checkLayout).toHaveBeenCalledWith("nan", PROJECT_ID, ["16:9", "9:16"], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    // While it checks: said, and the button cannot start a second check.
    expect(screen.getByText("Comprobando que el vídeo cabe en cada formato…").getAttribute("role")).toBe("status");
    expect((screen.getByRole("button", { name: "Exportar 2 MP4" }) as HTMLButtonElement).disabled).toBe(true);
    expect(invokedWith("video_export_start")).toEqual([]);
    finish({ "16:9": [], "9:16": [] });
    await waitFor(() => expect(invokedWith("video_export_start")).toHaveLength(1));
    expect(invokedWith("video_export_start")[0]).toMatchObject({ aspect: "16:9" });
    expect(screen.queryByText("Comprobando que el vídeo cabe en cada formato…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Exportar igualmente" })).toBeNull();
  });

  it("exports the formats that fit and holds the cut-off one with a fix and an override", async () => {
    checkLayout.mockResolvedValueOnce({ "16:9": [], "9:16": [], "1:1": [cut("intro"), cut("cta")] });
    const fix = vi.fn();
    renderPanel({ onFixLayout: fix });
    pick("Vertical 9:16", "Cuadrado 1:1");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 3 MP4" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("En el formato cuadrado (1:1) hay partes del vídeo que se salen del encuadre o quedan cortadas.");
    // Scene titles, not ids.
    // The same label style as the sentence.
    expect(screen.getByText("Cuadrado (1:1): 2 elementos cortados (Inicio, Cierre).")).toBeTruthy();
    expect(screen.getByText("Los demás formatos se están exportando con normalidad.")).toBeTruthy();
    // The fitting formats went out (one at a time: the first is uploading).
    await waitFor(() => expect(invokedWith("video_export_start")).toHaveLength(1));
    expect(screen.getAllByText("En cola, empieza cuando termine el anterior.")).toHaveLength(1);
    // The keyboard is on the way out.
    const fixButton = screen.getByRole("button", { name: "Arreglar con el asistente" });
    expect(document.activeElement).toBe(fixButton);
    fireEvent.click(fixButton);
    expect(fix).toHaveBeenCalledWith(
      "En el formato cuadrado (1:1) hay partes de este vídeo que se salen del encuadre o quedan cortadas. Ajusta el diseño para que se vea completo en los tres formatos.",
      {
        project_id: PROJECT_ID,
        title: "Promo",
        problems: [
          '1:1 (1080x1080): scene intro at 1 s: #t "Hola" is cut off at the edge of the frame',
          '1:1 (1080x1080): scene cta at 1 s: #t "Hola" is cut off at the edge of the frame',
        ],
      },
    );
    expect(screen.queryByRole("button", { name: "Arreglar con el asistente" })).toBeNull();
    // The keyboard is not dropped: the Export button is busy, so it lands on
    // a queue control.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(document.activeElement?.closest(".video-export")).not.toBeNull();
  });

  it("'Export anyway' queues the held formats", async () => {
    checkLayout.mockResolvedValueOnce({ "16:9": [cut("intro")], "1:1": [cut("intro")] });
    renderPanel({ onFixLayout: vi.fn() });
    pick("Cuadrado 1:1");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "En los formatos horizontal (16:9) y cuadrado (1:1) hay partes del vídeo que se salen del encuadre o quedan cortadas.",
    );
    // Nothing fit: nothing started, and no "the others are exporting".
    expect(invokedWith("video_export_start")).toEqual([]);
    expect(screen.queryByText("Los demás formatos se están exportando con normalidad.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exportar igualmente" }));
    await waitFor(() => expect(invokedWith("video_export_start")).toHaveLength(1));
    // Focus goes to the queue (the Export button is disabled while it runs).
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Cancelar"));
    expect(invokedWith("video_export_start")[0]).toMatchObject({ aspect: "16:9" });
    expect(screen.getAllByText("En cola, empieza cuando termine el anterior.")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says which format it is checking, and 'Cancel export' sends nothing", async () => {
    let options: { signal: AbortSignal; onAspect: (a: string) => void } | undefined;
    let finish: (r: LayoutReport) => void = () => undefined;
    checkLayout.mockImplementationOnce((_p, _id, _a, opts) => {
      options = opts;
      return new Promise<LayoutReport>((r) => (finish = r));
    });
    renderPanel({ onFixLayout: vi.fn() });
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect(screen.getByText("Comprobando que el vídeo cabe en cada formato…")).toBeTruthy();
    act(() => options!.onAspect("9:16"));
    expect(screen.getByText("Comprobando el formato vertical (9:16)…").getAttribute("role")).toBe("status");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar exportación" }));
    expect(options!.signal.aborted).toBe(true);
    expect(screen.queryByText(/Comprobando/)).toBeNull();
    // Back on the Export button, ready again.
    const exportButton = screen.getByRole("button", { name: "Exportar 2 MP4" }) as HTMLButtonElement;
    await waitFor(() => expect(document.activeElement).toBe(exportButton));
    expect(exportButton.disabled).toBe(false);
    // The check ending afterwards changes nothing: no export, no prompt.
    finish({ "16:9": [], "9:16": [cut("intro")] });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(invokedWith("video_export_start")).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a video changed while it is checked: Export stays disabled, the old verdict is dropped, the new version is checked, one render per format", async () => {
    const pending: ((r: LayoutReport) => void)[] = [];
    checkLayout.mockImplementation(() => new Promise<LayoutReport>((r) => pending.push(r)));
    const view = renderPanel({ onFixLayout: vi.fn() });
    const exportButton = () => screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement;
    fireEvent.click(exportButton());
    expect(checkLayout).toHaveBeenCalledTimes(1);
    // The assistant changes a scene mid-check.
    const changed = project({ sources: { index: "<!doctype html>", scenes: [{ id: "intro", html: "<template>v2</template>" }] } });
    view.rerender(
      <I18nProvider initial="es">
        <ExportPanel profileId="nan" project={changed} blocked={false} onExported={() => {}} onFixLayout={vi.fn()} />
      </I18nProvider>,
    );
    expect(exportButton().disabled).toBe(true);
    expect(screen.getByText("Comprobando que el vídeo cabe en cada formato…")).toBeTruthy();
    // A second click cannot start anything.
    fireEvent.click(exportButton());
    expect(checkLayout).toHaveBeenCalledTimes(1);
    // The old version's verdict (cut off) arrives: no alert, nothing queued,
    // the same format is checked again for the new version.
    await act(async () => pending[0]({ "16:9": [cut("intro")] }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(invokedWith("video_export_start")).toEqual([]);
    await waitFor(() => expect(checkLayout).toHaveBeenCalledTimes(2));
    expect(checkLayout.mock.calls[1].slice(0, 3)).toEqual(["nan", PROJECT_ID, ["16:9"]]);
    expect(exportButton().disabled).toBe(true);
    await act(async () => pending[1]({ "16:9": [] }));
    await waitFor(() => expect(invokedWith("video_export_start")).toHaveLength(1));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(invokedWith("video_export_start")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    checkLayout.mockReset();
  });

  it("'could not check' is not remembered: the next export tries again", async () => {
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => {
        throw { kind: "unavailable" };
      },
    });
    checkLayout.mockResolvedValueOnce({ "16:9": null }).mockResolvedValueOnce({ "16:9": [] });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(invokedWith("video_export_start")).toHaveLength(1));
    await waitFor(() => expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(checkLayout).toHaveBeenCalledTimes(2));
  });

  it("a check that throws never holds a format", async () => {
    checkLayout.mockRejectedValueOnce(new Error("boom"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(invokedWith("video_export_start")).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names an untitled scene by its position", async () => {
    const untitled = project();
    untitled.meta.scenes = [
      { id: "s1", title: "Inicio", duration: 3 },
      { id: "s2", title: "", duration: 4.5 },
    ];
    checkLayout.mockResolvedValueOnce({ "16:9": [cut("s2")] });
    renderPanel({ project: untitled, onFixLayout: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    expect(await screen.findByText("Horizontal (16:9): 1 elemento cortado (Escena 2).")).toBeTruthy();
  });

  it("without a way to reach the assistant, only the override is offered (and focused)", async () => {
    checkLayout.mockResolvedValueOnce({ "16:9": [cut("intro")] });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    const anyway = await screen.findByRole("button", { name: "Exportar igualmente" });
    expect(screen.queryByRole("button", { name: "Arreglar con el asistente" })).toBeNull();
    expect(document.activeElement).toBe(anyway);
  });

  it("a check that could not run never holds a format", async () => {
    checkLayout.mockResolvedValueOnce({ "16:9": null });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(invokedWith("video_export_start")).toHaveLength(1));
    checkLayout.mockRejectedValueOnce(new Error("boom"));
    cleanup();
    resetExportQueues();
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(invokedWith("video_export_start")).toHaveLength(2));
  });

  it("remembers a verdict for this version of the video; a changed video is checked again", async () => {
    checkLayout.mockResolvedValue({ "16:9": [cut("intro")] });
    const view = renderPanel({ onFixLayout: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await screen.findByRole("alert");
    expect(checkLayout).toHaveBeenCalledTimes(1);
    // A new MP4 in the list is not a new version: the verdict stays on screen.
    view.rerender(
      <I18nProvider initial="es">
        <ExportPanel profileId="nan" project={project({ exports: [{ name: "a.mp4", size: 1 }] })} blocked={false} onExported={() => {}} onFixLayout={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    // The assistant changed a scene: the old verdict goes, the next export re-checks.
    const changed = project({ sources: { index: "<!doctype html>", scenes: [{ id: "intro", html: "<template>v2</template>" }] } });
    expect(layoutKey(changed)).not.toBe(layoutKey(project()));
    view.rerender(
      <I18nProvider initial="es">
        <ExportPanel profileId="nan" project={changed} blocked={false} onExported={() => {}} onFixLayout={vi.fn()} />
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await screen.findByRole("alert");
    expect(checkLayout).toHaveBeenCalledTimes(2);
  });

  it("speaks English too", async () => {
    checkLayout.mockResolvedValueOnce({ "16:9": [], "9:16": [cut("intro")] });
    renderPanel({ onFixLayout: vi.fn() }, "en");
    fireEvent.click(screen.getByLabelText("Vertical 9:16"));
    fireEvent.click(screen.getByRole("button", { name: "Export 2 MP4s" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "In the vertical (9:16) format, parts of the video go outside the frame or get cut off.",
    );
    expect(screen.getByRole("button", { name: "Fix with the assistant" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export anyway" })).toBeTruthy();
    expect(screen.getByText("The other formats are exporting normally.")).toBeTruthy();
  });
});
