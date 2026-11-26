// @vitest-environment jsdom
// Export on demand: the project's own format exports right away, unchecked;
// any other selected format is checked first. One that fits joins the
// queue; one that comes out cut off is fixed by the assistant (no choice
// put to the user), re-checked with the own format, and downloads by
// itself; bounded, cancelable, and a check that cannot run never holds
// anything back.
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
import {
  exportFixDropped,
  exportFixTurnEnded,
  exportFixTurnStarted,
  resetExportFixes,
  setExportFixScreen,
  setExportFixSender,
  type ExportFixRequest,
} from "./exportFix";
import { resetExportQueues } from "./exportQueue";
import { PROJECT_ID, project } from "./fixtures";
import type { LayoutReport } from "./layoutCheck";

const QUOTA = { included_seconds: 7200, used_seconds: 0, remaining_seconds: 7200, period_end: "2026-12-01T00:00:00Z" };
const cut = (scene: string) => ({ scene, time: 1, kind: "clipped" as const, element: '#t "Hola"' });
const FIXING_VERTICAL =
  "El formato vertical (9:16) necesita ajustes: hay partes del vídeo que se salen del encuadre o quedan cortadas. Esperando a que el asistente lo corrija; se descargará automáticamente cuando esté listo.";
const FIXING_VERTICAL_STARTED =
  "El formato vertical (9:16) necesita ajustes: hay partes del vídeo que se salen del encuadre o quedan cortadas. El asistente lo está corrigiendo; se descargará automáticamente cuando esté listo.";

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

/// The assistant: records each fix request; `withdrawn` counts take-backs.
let requests: ExportFixRequest[] = [];
let withdrawn = 0;
function connectAssistant(conversationId = 7) {
  setExportFixScreen(7, (id) => (id === 3 ? "Reel de verano" : null));
  setExportFixSender(async (request) => {
    requests.push(request);
    return {
      withdraw: () => {
        withdrawn += 1;
      },
      conversationId,
    };
  });
}

/// The last request's turn runs in conversation 7 and ends.
async function fixTurn(reason = "completed") {
  await act(async () => {
    exportFixTurnStarted(7, requests[requests.length - 1].fixId);
    exportFixTurnEnded(7, reason);
    await new Promise((r) => setTimeout(r, 0));
  });
}

/// The aspects each export render was started with.
const started = () => invokedWith("video_export_start").map((args) => args.aspect);

beforeEach(() => {
  localStorage.clear();
  requests = [];
  withdrawn = 0;
  checkLayout.mockReset();
  resetTauri({
    video_export_quota: () => QUOTA,
    video_export_start: () => new Promise(() => {}),
  });
});
afterEach(() => {
  cleanup();
  resetExportQueues();
  resetExportFixes();
});

describe("ExportPanel: export on demand", () => {
  it("the own format alone exports right away, with no check", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(started()).toEqual(["16:9"]));
    expect(checkLayout).not.toHaveBeenCalled();
    expect(screen.queryByText(/Comprobando/)).toBeNull();
  });

  it("the own format starts at once while the other one is checked; one that fits joins the queue", async () => {
    let finish: (r: LayoutReport) => void = () => undefined;
    checkLayout.mockReturnValueOnce(new Promise<LayoutReport>((r) => (finish = r)));
    renderPanel();
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    // Only the other format is checked; the own one is already on its way.
    expect(checkLayout).toHaveBeenCalledWith("nan", PROJECT_ID, ["9:16"], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await waitFor(() => expect(started()).toEqual(["16:9"]));
    expect(screen.getByText("Comprobando que el vídeo cabe en los demás formatos…").getAttribute("role")).toBe("status");
    expect((screen.getByRole("button", { name: "Exportar 2 MP4" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ "9:16": [] }));
    // Queued behind the own format (one render at a time).
    expect(await screen.findByText("En cola, empieza cuando termine el anterior.")).toBeTruthy();
    expect(screen.queryByText(/Comprobando/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a cut-off format is not put to the user as a choice: the assistant fixes it and it downloads when ready", async () => {
    connectAssistant();
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro"), cut("cta")] });
    renderPanel({ onFixLayout: vi.fn() });
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect(await screen.findByText(FIXING_VERTICAL)).toBeTruthy();
    expect(screen.getByText(FIXING_VERTICAL).getAttribute("role")).toBe("status");
    // What is cut, by scene title; the own format keeps exporting.
    expect(screen.getByText("Vertical (9:16): 2 elementos cortados (Inicio, Cierre).")).toBeTruthy();
    // The format already exporting is named, and so is its queue row.
    expect(screen.getByText("El formato horizontal (16:9) ya se está exportando.")).toBeTruthy();
    expect(document.querySelector(".video-queue-format")?.textContent).toBe("Horizontal 16:9");
    expect(started()).toEqual(["16:9"]);
    // No choice to make, and the keyboard lands on the way out.
    expect(screen.queryByRole("button", { name: "Exportar igualmente" })).toBeNull();
    const cancel = screen.getByRole("button", { name: "No exportar el formato vertical (9:16)" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    // The assistant got ONE request for that format, keeping the own one.
    expect(requests).toEqual([
      {
        fixId: expect.any(Number),
        projectId: PROJECT_ID,
        title: "Promo",
        own: "16:9",
        aspects: ["9:16"],
        report: { "9:16": [cut("intro"), cut("cta")] },
        round: 1,
      },
    ]);
    // Its turn starts: the assistant is on it now.
    act(() => exportFixTurnStarted(7, requests[0].fixId));
    expect(screen.getByText(FIXING_VERTICAL_STARTED)).toBeTruthy();
    // It completes: the fixed format AND the own one are checked again.
    checkLayout.mockResolvedValueOnce({ "16:9": [], "9:16": [] });
    await fixTurn();
    expect(checkLayout.mock.calls[1].slice(0, 3)).toEqual(["nan", PROJECT_ID, ["16:9", "9:16"]]);
    expect(await screen.findByText("El asistente ha corregido el formato vertical (9:16) y se ha añadido a la exportación.")).toBeTruthy();
    // It joined the export by itself, behind the own format (whose row stays).
    expect(screen.getByText("En cola, empieza cuando termine el anterior.")).toBeTruthy();
    expect(screen.queryByText(FIXING_VERTICAL)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The keyboard is not dropped on <body>.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("bounded: still cut off after two fixes, it says so and offers export anyway, the chat, or not exporting", async () => {
    connectAssistant();
    const fix = vi.fn();
    checkLayout
      .mockResolvedValueOnce({ "9:16": [cut("intro")] })
      .mockResolvedValueOnce({ "16:9": [], "9:16": [cut("intro")] })
      .mockResolvedValueOnce({ "16:9": [], "9:16": [cut("intro")] });
    renderPanel({ onFixLayout: fix });
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    await screen.findByText(FIXING_VERTICAL);
    await fixTurn();
    await waitFor(() => expect(requests).toHaveLength(2));
    // The attempt is said apart from the live sentence (one announcement).
    expect(screen.getByText(FIXING_VERTICAL).getAttribute("role")).toBe("status");
    expect(screen.getByText("Intento 2 de 2.").getAttribute("role")).toBeNull();
    await fixTurn();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "El formato vertical (9:16) sigue saliendo cortado tras los cambios del asistente, así que no se ha exportado.",
    );
    expect(requests).toHaveLength(2);
    const anyway = screen.getByRole("button", { name: "Exportar igualmente" });
    await waitFor(() => expect(document.activeElement).toBe(anyway));
    expect(screen.getByRole("button", { name: "No exportar" })).toBeTruthy();
    // "Fix it in the chat" hands the same request to the chat.
    fireEvent.click(screen.getByRole("button", { name: "Arreglarlo en el chat" }));
    expect(fix).toHaveBeenCalledWith(
      "Para exportar este vídeo en el formato vertical (9:16), hay partes que se salen del encuadre o quedan cortadas. Ajusta el diseño para que se vea completo ahí, sin cambiar cómo se ve en el formato horizontal (16:9).",
      {
        project_id: PROJECT_ID,
        title: "Promo",
        problems: ['9:16 (1080x1920): scene intro at 1 s: #t "Hola" is cut off at the edge of the frame'],
      },
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("'Export anyway' in the final state queues the format as it is", async () => {
    connectAssistant();
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro")] }).mockResolvedValue({ "16:9": [], "9:16": [cut("intro")] });
    renderPanel();
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    await screen.findByText(FIXING_VERTICAL);
    await fixTurn();
    await waitFor(() => expect(requests).toHaveLength(2));
    await fixTurn();
    // Without a way to the chat, that option is not offered.
    expect(screen.queryByRole("button", { name: "Arreglarlo en el chat" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Exportar igualmente" }));
    expect(await screen.findByText("En cola, empieza cuando termine el anterior.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(document.activeElement?.closest(".video-export")).not.toBeNull());
    checkLayout.mockReset();
  });

  it("cancel while the assistant fixes: its queued request is taken back and nothing more is exported", async () => {
    connectAssistant();
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro")] });
    renderPanel();
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    await screen.findByText(FIXING_VERTICAL);
    await waitFor(() => expect(requests).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "No exportar el formato vertical (9:16)" }));
    expect(withdrawn).toBe(1);
    expect(screen.queryByText(FIXING_VERTICAL)).toBeNull();
    await fixTurn();
    expect(checkLayout).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("En cola, empieza cuando termine el anterior.")).toBeNull();
    // The keyboard is not dropped.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("cancel during the check: that format is not exported; the own one keeps going", async () => {
    let options: { signal: AbortSignal; onAspect: (a: string) => void } | undefined;
    let finish: (r: LayoutReport) => void = () => undefined;
    checkLayout.mockImplementationOnce((_p, _id, _a, opts) => {
      options = opts;
      return new Promise<LayoutReport>((r) => (finish = r));
    });
    renderPanel({ onFixLayout: vi.fn() });
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    act(() => options!.onAspect("9:16"));
    expect(screen.getByText("Comprobando el formato vertical (9:16)…").getAttribute("role")).toBe("status");
    fireEvent.click(screen.getByRole("button", { name: "No exportar el formato vertical (9:16)" }));
    expect(options!.signal.aborted).toBe(true);
    expect(screen.queryByText(/Comprobando/)).toBeNull();
    // The check ending afterwards changes nothing.
    finish({ "9:16": [cut("intro")] });
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(started()).toEqual(["16:9"]);
    expect(screen.queryByText(FIXING_VERTICAL)).toBeNull();
    expect(screen.queryByText("En cola, empieza cuando termine el anterior.")).toBeNull();
  });

  it("a check that cannot run never holds a format back, and is not remembered", async () => {
    connectAssistant();
    resetTauri({ video_export_quota: () => QUOTA, video_export_start: () => ({ render_id: "r1", estimated_seconds: 1 }) });
    checkLayout.mockResolvedValueOnce({ "9:16": null }).mockRejectedValueOnce(new Error("boom"));
    renderPanel();
    pick("Horizontal 16:9", "Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(started()).toEqual(["9:16"]));
    expect(requests).toEqual([]);
    cleanup();
    resetExportQueues();
    renderPanel();
    pick("Horizontal 16:9", "Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(started()).toEqual(["9:16", "9:16"]));
    expect(checkLayout).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([]);
  });

  it("a fix that breaks the own format is surfaced, with the chat as the way to fix it", async () => {
    connectAssistant();
    const fix = vi.fn();
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro")] }).mockResolvedValueOnce({ "16:9": [cut("cta")], "9:16": [] });
    renderPanel({ onFixLayout: fix });
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    await screen.findByText(FIXING_VERTICAL);
    await fixTurn();
    const alert = await screen.findByRole("alert");
    // The own render had already started (uploading): it keeps the earlier version.
    expect(alert.textContent).toBe(
      "Tras los cambios del asistente, el formato horizontal (16:9) sale cortado. La exportación que ya estaba en marcha usa la versión anterior.",
    );
    expect(screen.getByText("Horizontal (16:9): 1 elemento cortado (Cierre).")).toBeTruthy();
    const chat = screen.getByRole("button", { name: "Arreglarlo en el chat" });
    await waitFor(() => expect(document.activeElement).toBe(chat));
    fireEvent.click(chat);
    expect(fix).toHaveBeenCalledWith(
      "Tras los últimos cambios, en el formato horizontal (16:9) hay partes de este vídeo que se salen del encuadre o quedan cortadas. Ajusta el diseño para que vuelva a verse completo.",
      {
        project_id: PROJECT_ID,
        title: "Promo",
        problems: ['16:9 (1920x1080): scene cta at 1 s: #t "Hola" is cut off at the edge of the frame'],
      },
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a video changed while it is checked: the old verdict is dropped, the new version is checked, one render per format", async () => {
    const pending: ((r: LayoutReport) => void)[] = [];
    checkLayout.mockImplementation(() => new Promise<LayoutReport>((r) => pending.push(r)));
    resetTauri({ video_export_quota: () => QUOTA, video_export_start: () => new Promise(() => {}) });
    const view = renderPanel();
    pick("Horizontal 16:9", "Vertical 9:16");
    const exportButton = () => screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement;
    fireEvent.click(exportButton());
    expect(checkLayout).toHaveBeenCalledTimes(1);
    const changed = project({ sources: { index: "<!doctype html>", scenes: [{ id: "intro", html: "<template>v2</template>" }] } });
    view.rerender(
      <I18nProvider initial="es">
        <ExportPanel profileId="nan" project={changed} blocked={false} onExported={() => {}} />
      </I18nProvider>,
    );
    expect(exportButton().disabled).toBe(true);
    fireEvent.click(exportButton());
    expect(checkLayout).toHaveBeenCalledTimes(1);
    // The old version's verdict (cut off) arrives: nothing shown or queued.
    await act(async () => pending[0]({ "9:16": [cut("intro")] }));
    expect(screen.queryByText(FIXING_VERTICAL)).toBeNull();
    expect(started()).toEqual([]);
    await waitFor(() => expect(checkLayout).toHaveBeenCalledTimes(2));
    expect(checkLayout.mock.calls[1].slice(0, 3)).toEqual(["nan", PROJECT_ID, ["9:16"]]);
    await act(async () => pending[1]({ "9:16": [] }));
    await waitFor(() => expect(started()).toEqual(["9:16"]));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(started()).toEqual(["9:16"]);
  });

  it("remembers a verdict for this version of the video; a changed video is checked again", async () => {
    resetTauri({ video_export_quota: () => QUOTA, video_export_start: () => ({ render_id: "r1", estimated_seconds: 1 }) });
    checkLayout.mockResolvedValue({ "9:16": [] });
    const view = renderPanel();
    pick("Horizontal 16:9", "Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(started()).toHaveLength(1));
    resetExportQueues();
    await waitFor(() => expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(started()).toHaveLength(2));
    expect(checkLayout).toHaveBeenCalledTimes(1);
    const changed = project({ sources: { index: "<!doctype html>", scenes: [{ id: "intro", html: "<template>v2</template>" }] } });
    expect(layoutKey(changed)).not.toBe(layoutKey(project()));
    view.rerender(
      <I18nProvider initial="es">
        <ExportPanel profileId="nan" project={changed} blocked={false} onExported={() => {}} />
      </I18nProvider>,
    );
    resetExportQueues();
    await waitFor(() => expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(checkLayout).toHaveBeenCalledTimes(2));
    checkLayout.mockReset();
  });

  it("names an untitled scene by its position", async () => {
    connectAssistant();
    const untitled = project();
    untitled.meta.scenes = [
      { id: "s1", title: "Inicio", duration: 3 },
      { id: "s2", title: "", duration: 4.5 },
    ];
    checkLayout.mockResolvedValueOnce({ "1:1": [cut("s2")] });
    renderPanel({ project: untitled });
    pick("Cuadrado 1:1");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect(await screen.findByText("Cuadrado (1:1): 1 elemento cortado (Escena 2).")).toBeTruthy();
  });

  it("without a way to reach the assistant, it says so and offers to export anyway", async () => {
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro")] });
    renderPanel();
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "No se ha podido pedir al asistente que corrija el formato vertical (9:16), así que no se ha exportado.",
    );
    expect(screen.getByRole("button", { name: "Exportar igualmente" })).toBeTruthy();
  });

  it("speaks English too", async () => {
    connectAssistant();
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro")], "1:1": [cut("intro")] });
    renderPanel({}, "en");
    fireEvent.click(screen.getByLabelText("Vertical 9:16"));
    fireEvent.click(screen.getByLabelText("Square 1:1"));
    fireEvent.click(screen.getByRole("button", { name: "Export 3 MP4s" }));
    expect(
      await screen.findByText(
        "The vertical (9:16) and square (1:1) formats need adjustments: parts of the video go outside the frame or get cut off. Waiting for the assistant to fix them; they will download automatically when ready.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't export the vertical (9:16) and square (1:1) formats" })).toBeTruthy();
    expect(screen.getByText("The horizontal (16:9) format is already exporting.")).toBeTruthy();
  });

  it("a request taken out of the chat queue ends the wait with a clear final state", async () => {
    connectAssistant();
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro")] });
    renderPanel({ onFixLayout: vi.fn() });
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    await screen.findByText(FIXING_VERTICAL);
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() => exportFixDropped(requests[0].fixId, "removed"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "La petición para corregir el formato vertical (9:16) se quitó de la cola del chat, así que no se ha exportado.",
    );
    expect(screen.getByRole("button", { name: "Exportar igualmente" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Exportar 2 MP4" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the conversation the request waits in when it is not on screen", async () => {
    connectAssistant(3);
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro")] });
    renderPanel();
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect(await screen.findByText("La petición espera en la conversación «Reel de verano»: se enviará cuando la abras.")).toBeTruthy();
    act(() => setExportFixScreen(3, () => "Reel de verano"));
    expect(screen.queryByText(/La petición espera/)).toBeNull();
  });

  it("'Don't export' once the assistant is working says it may keep editing in the chat", async () => {
    connectAssistant();
    checkLayout.mockResolvedValueOnce({ "9:16": [cut("intro")] });
    renderPanel();
    pick("Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    await screen.findByText(FIXING_VERTICAL);
    await waitFor(() => expect(requests).toHaveLength(1));
    act(() => exportFixTurnStarted(7, requests[0].fixId));
    fireEvent.click(screen.getByRole("button", { name: "No exportar el formato vertical (9:16)" }));
    expect(screen.getByText("Puede que el asistente siga editando el vídeo en el chat; puedes detenerlo allí.")).toBeTruthy();
    expect(withdrawn).toBe(1);
  });

  it("a panel opened while another one checks cannot start the same export twice", async () => {
    let finish: (r: LayoutReport) => void = () => undefined;
    checkLayout.mockReturnValueOnce(new Promise<LayoutReport>((r) => (finish = r)));
    resetTauri({ video_export_quota: () => QUOTA, video_export_start: () => new Promise(() => {}) });
    // The own format is not exported: only the other one, checked.
    const first = renderPanel();
    pick("Horizontal 16:9", "Vertical 9:16");
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    first.unmount();
    renderPanel();
    pick("Horizontal 16:9", "Vertical 9:16");
    const exportButton = screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(screen.getByText("Comprobando que el vídeo cabe en los demás formatos…").getAttribute("role")).toBe("status");
    fireEvent.click(exportButton);
    expect(checkLayout).toHaveBeenCalledTimes(1);
    // The first panel's check still lands (the queue outlives it), once.
    await act(async () => finish({ "9:16": [] }));
    await waitFor(() => expect(started()).toEqual(["9:16"]));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(started()).toEqual(["9:16"]);
  });
});
