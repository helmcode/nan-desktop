// @vitest-environment jsdom
// R-V1: the export panel: plain-words quota, the full render flow against
// the core commands (which talk to the server), and every failure message.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { I18nProvider } from "../i18n";
import { emit, invokedWith, resetTauri } from "../test/tauriMock";
import { ExportPanel, POLL_MS } from "./ExportPanel";
import { resetExportQueues } from "./exportQueue";
import { PROJECT_ID, project } from "./fixtures";

const QUOTA = { included_seconds: 7200, used_seconds: 2160, remaining_seconds: 5040, period_end: "2026-12-01T00:00:00Z" };

function renderPanel(props: Partial<Parameters<typeof ExportPanel>[0]> = {}) {
  return render(
    <I18nProvider initial="es">
      <ExportPanel profileId="nan" project={project()} blocked={false} onExported={() => {}} {...props} />
    </I18nProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  resetExportQueues();
  vi.useRealTimers();
});

describe("ExportPanel", () => {
  it("says how much export time is left this month", async () => {
    resetTauri({ video_export_quota: () => QUOTA });
    renderPanel();
    expect(await screen.findByText("Te quedan 84 min de exportación este mes")).toBeTruthy();
    expect(screen.getByText("Se renueva el 1 de diciembre")).toBeTruthy();
    expect(screen.getByText("Usará 8 s de tu tiempo de exportación")).toBeTruthy();
  });

  it("renders on the server, polls, downloads into the project and offers the file", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const statuses = [
      { status: "queued", progress: 0, error: null, ready: false, size_bytes: null, expires_at: null },
      { status: "rendering", progress: 0.42, error: null, ready: false, size_bytes: null, expires_at: null },
      { status: "done", progress: 1, error: null, ready: true, size_bytes: 9000, expires_at: null },
    ];
    const exported = vi.fn();
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => ({ render_id: "r-1", charge_seconds: 8 }),
      video_export_status: () => statuses.shift(),
      video_export_download: () => ({ name: "promo.mp4", size: 9000 }),
      video_export_open: () => null,
      video_export_reveal: () => null,
    });
    const view = renderPanel({ onExported: exported });
    fireEvent.change(screen.getByLabelText("Calidad"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    await waitFor(() => expect(invokedWith("video_export_start")).toEqual([{ profileId: "nan", projectId: PROJECT_ID, quality: "draft", aspect: "16:9" }]));
    expect(await screen.findByText("Esperando un hueco para generarlo…")).toBeTruthy();
    expect(localStorage.getItem(`video.render.${PROJECT_ID}`)).toBe("r-1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(await screen.findByText("Generando el vídeo… 42%")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await waitFor(() =>
      expect(invokedWith("video_export_download")).toEqual([{ profileId: "nan", projectId: PROJECT_ID, renderId: "r-1", aspect: "16:9" }]),
    );
    expect(await screen.findByText("Tu MP4 está listo.")).toBeTruthy();
    expect(exported).toHaveBeenCalled();
    expect(localStorage.getItem(`video.render.${PROJECT_ID}`)).toBeNull();
    // The parent refreshes the project; its exports get the file actions.
    view.rerender(
      <I18nProvider initial="es">
        <ExportPanel profileId="nan" project={project({ exports: [{ name: "promo.mp4", size: 9000 }] })} blocked={false} onExported={exported} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    fireEvent.click(screen.getByRole("button", { name: "Mostrar en carpeta" }));
    await waitFor(() => expect(invokedWith("video_export_reveal")).toEqual([{ profileId: "nan", projectId: PROJECT_ID, name: "promo.mp4" }]));
    expect(invokedWith("video_export_open")).toEqual([{ profileId: "nan", projectId: PROJECT_ID, name: "promo.mp4" }]);
  });

  it("shows download progress from the core's events", async () => {
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_status: () => ({ status: "done", progress: 1, error: null, ready: true, size_bytes: 10, expires_at: null }),
      video_export_download: () => new Promise(() => {}),
    });
    localStorage.setItem(`video.render.${PROJECT_ID}`, "r-9");
    renderPanel();
    expect(await screen.findByText("Descargando el MP4…")).toBeTruthy();
    act(() => emit("video://download", { project_id: PROJECT_ID, received: 50, total: 200 }));
    expect(await screen.findByText("Descargando el MP4… 25%")).toBeTruthy();
    act(() => emit("video://download", { project_id: "other", received: 200, total: 200 }));
    expect(screen.getByText("Descargando el MP4… 25%")).toBeTruthy();
  });

  it("shows upload progress and warns when the connection is too slow", async () => {
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => new Promise(() => {}),
    });
    renderPanel();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    expect(await screen.findByText("Enviando el vídeo…")).toBeTruthy();
    now.mockReturnValue(1_000_000 + 2_000);
    act(() => emit("video://upload", { project_id: PROJECT_ID, sent: 50, total: 100 }));
    expect(await screen.findByText("Enviando el vídeo… 50%")).toBeTruthy();
    expect(screen.queryByText(/conexión va lenta/)).toBeNull();
    now.mockReturnValue(1_000_000 + 120_000);
    act(() => emit("video://upload", { project_id: PROJECT_ID, sent: 60, total: 600 }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/conexión va lenta/);
    now.mockRestore();
  });

  it("explains quota, subscription and size refusals in plain words", async () => {
    const errors = [
      { kind: "quota_exhausted", remaining_seconds: 12, period_end: "2026-12-01T00:00:00Z" },
      { kind: "subscription_required" },
      { kind: "too_large" },
      { kind: "unavailable" },
    ];
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => {
        throw errors.shift();
      },
    });
    renderPanel();
    const exportButton = screen.getByRole("button", { name: "Exportar MP4" });
    for (const text of [
      /Has gastado el tiempo de exportación de este mes \(te quedan 12 s\)\. Se renueva el 1 de diciembre\./,
      /necesitas una suscripción activa/,
      /máximo 90 MB/,
      /no está disponible ahora mismo/,
    ]) {
      fireEvent.click(exportButton);
      expect((await screen.findByRole("alert")).textContent).toMatch(text);
    }
  });

  it("maps a failed render, and cancels a running one", async () => {
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_status: () => ({ status: "failed", progress: 0.3, error: "timeout", ready: false, size_bytes: null, expires_at: null }),
    });
    localStorage.setItem(`video.render.${PROJECT_ID}`, "r-2");
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toMatch(/tardaba demasiado/);
    cleanup();
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_status: () => ({ status: "rendering", progress: 0.1, error: null, ready: false, size_bytes: null, expires_at: null }),
      video_export_cancel: () => null,
    });
    localStorage.setItem(`video.render.${PROJECT_ID}`, "r-3");
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(invokedWith("video_export_cancel")).toEqual([{ profileId: "nan", renderId: "r-3" }]));
    await waitFor(() => expect(localStorage.getItem(`video.render.${PROJECT_ID}`)).toBeNull());
  });

  it("warns before uploading when the balance does not cover the video", async () => {
    resetTauri({ video_export_quota: () => ({ ...QUOTA, remaining_seconds: 5 }) });
    renderPanel();
    expect(await screen.findByText("Este vídeo usa 8 s y te quedan 5 s de exportación este mes.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Ver planes" })).toBeTruthy();
  });

  it("offers plans after a subscription refusal and sign-in after an expired session", async () => {
    const signIn = vi.fn();
    const errors = [{ kind: "subscription_required" }, { kind: "no_session" }];
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => {
        throw errors.shift();
      },
      open_external: () => null,
    });
    renderPanel({ onSignIn: signIn });
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    fireEvent.click(await screen.findByRole("button", { name: "Ver planes" }));
    await waitFor(() => expect(invokedWith("open_external")).toEqual([{ url: "https://cloud.nan.builders/membership" }]));
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    fireEvent.click(await screen.findByRole("button", { name: "Volver a iniciar sesión" }));
    expect(signIn).toHaveBeenCalled();
  });

  it("cancels while the video is still uploading", async () => {
    let reject: (err: unknown) => void = () => {};
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => new Promise((_, no) => (reject = no)),
      video_export_abort: () => {
        reject({ kind: "canceled" });
        return true;
      },
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(invokedWith("video_export_abort")).toEqual([{ projectId: PROJECT_ID }]));
    // A cancel the user asked for is a neutral note, not an error.
    expect(await screen.findByText("Exportación cancelada. No se ha cobrado nada.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops offering Cancel once the whole video is sent, and keeps the render it gets", async () => {
    let resolve: (value: unknown) => void = () => {};
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => new Promise((ok) => (resolve = ok)),
      video_export_status: () => ({ status: "queued", progress: 0, error: null, ready: false, size_bytes: null, expires_at: null }),
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    act(() => emit("video://upload", { project_id: PROJECT_ID, sent: 100, total: 100 }));
    expect(await screen.findByText("Preparando la exportación… (no se puede cancelar hasta que empiece)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    await act(async () => resolve({ render_id: "r-9", charge_seconds: 8 }));
    expect(localStorage.getItem(`video.render.${PROJECT_ID}`)).toBe("r-9");
    // The render can be canceled (and refunded) as usual.
    expect(await screen.findByRole("button", { name: "Cancelar" })).toBeTruthy();
  });

  it("keeps polling through a dropped connection and resumes a remembered render", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const replies: unknown[] = [
      { kind: "offline" },
      { status: "rendering", progress: 0.5, error: null, ready: false, size_bytes: null, expires_at: null },
    ];
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_status: () => {
        const next = replies.shift();
        if (next && (next as { kind?: string }).kind) throw next;
        return next ?? { status: "rendering", progress: 0.5, error: null, ready: false, size_bytes: null, expires_at: null };
      },
    });
    localStorage.setItem(`video.render.${PROJECT_ID}`, "r-7");
    renderPanel();
    await waitFor(() => expect(invokedWith("video_export_status")).toEqual([{ profileId: "nan", renderId: "r-7" }]));
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });
    expect(await screen.findByText("Generando el vídeo… 50%")).toBeTruthy();
  });

  it("checks the session before calling a missing render gone (enterprise 404)", async () => {
    let quotaCalls = 0;
    resetTauri({
      video_export_quota: () => {
        quotaCalls += 1;
        if (quotaCalls > 1) throw { kind: "no_session" };
        return QUOTA;
      },
      video_export_status: () => {
        throw { kind: "not_found" };
      },
    });
    localStorage.setItem(`video.render.${PROJECT_ID}`, "r-8");
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toMatch(/Vuelve a iniciar sesión/);
  });

  it("cannot export while the check finds errors, and says when the quota is unknown", async () => {
    resetTauri({
      video_export_quota: () => {
        throw { kind: "offline" };
      },
    });
    renderPanel({ blocked: true });
    expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByText("No se ha podido consultar tu tiempo de exportación.")).toBeTruthy();
  });

  it("queues several formats and renders them one after another", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const done = { status: "done", progress: 1, error: null, ready: true, size_bytes: 9000, expires_at: null };
    let renders = 0;
    const exported = vi.fn();
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => ({ render_id: `r-${++renders}`, charge_seconds: 8 }),
      video_export_status: () => done,
      video_export_download: (args) => ({ name: `promo-${args?.aspect === "9:16" ? "vertical" : "horizontal"}.mp4`, size: 9000 }),
    });
    renderPanel({ onExported: exported });
    // The project's own format is preselected.
    expect((screen.getByRole("checkbox", { name: "Horizontal 16:9" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Vertical 9:16" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Vertical 9:16" }));
    // What it will cost, before starting: 2 x ceil(7.5 s).
    expect(screen.getByText("Usará 16 s de tu tiempo de exportación (8 s por formato). Se generan uno detrás de otro.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    await waitFor(() => expect(invokedWith("video_export_download").length).toBe(2));
    // One at a time, the project's own format first; each file says its format.
    expect(invokedWith("video_export_start").map((a) => a?.aspect)).toEqual(["16:9", "9:16"]);
    expect(invokedWith("video_export_download")).toEqual([
      { profileId: "nan", projectId: PROJECT_ID, renderId: "r-1", aspect: "16:9" },
      { profileId: "nan", projectId: PROJECT_ID, renderId: "r-2", aspect: "9:16" },
    ]);
    expect((await screen.findAllByText("Tu MP4 está listo.")).length).toBe(2);
    // Each row offers its own file.
    expect(screen.getAllByRole("button", { name: "Abrir" }).length).toBe(2);
    await waitFor(() => expect(exported).toHaveBeenCalledTimes(2));
  });

  it("never starts the next format before the previous one is finished", async () => {
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => ({ render_id: "r-1", charge_seconds: 8 }),
      video_export_status: () => ({ status: "rendering", progress: 0.2, error: null, ready: false, size_bytes: null, expires_at: null }),
      video_export_cancel: () => null,
    });
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Cuadrado 1:1" }));
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect(await screen.findByText("Generando el vídeo… 20%")).toBeTruthy();
    expect(screen.getByText("En cola, empieza cuando termine el anterior.")).toBeTruthy();
    expect(invokedWith("video_export_start").length).toBe(1);
    // The formats are locked while the queue runs.
    expect((screen.getByRole("button", { name: "Exportar 2 MP4" }) as HTMLButtonElement).disabled).toBe(true);
    // Cancel only the queued one: the running one carries on.
    fireEvent.click(screen.getByRole("button", { name: "Cancelar Cuadrado 1:1" }));
    expect(await screen.findByText("Exportación cancelada. No se ha cobrado nada.")).toBeTruthy();
    expect(invokedWith("video_export_cancel")).toEqual([]);
    expect(screen.getByText("Generando el vídeo… 20%")).toBeTruthy();
  });

  it("cancels the rest in one go", async () => {
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => ({ render_id: "r-1", charge_seconds: 8 }),
      video_export_status: () => ({ status: "queued", progress: 0, error: null, ready: false, size_bytes: null, expires_at: null }),
      video_export_cancel: () => null,
    });
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Vertical 9:16" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Cuadrado 1:1" }));
    fireEvent.click(screen.getByRole("button", { name: "Exportar 3 MP4" }));
    expect(await screen.findByText("Esperando un hueco para generarlo…")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar el resto" }));
    await waitFor(() => expect(screen.getAllByText("Exportación cancelada. No se ha cobrado nada.").length).toBe(3));
    expect(invokedWith("video_export_cancel")).toEqual([{ profileId: "nan", renderId: "r-1" }]);
    expect(invokedWith("video_export_start").length).toBe(1);
    expect(localStorage.getItem(`video.render.${PROJECT_ID}`)).toBeNull();
  });

  it("waits for a free slot when the server is full, then carries on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const replies: unknown[] = [{ kind: "too_many_active", retry_after: 5 }, { kind: "rate_limited" }];
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => {
        const next = replies.shift();
        if (next) throw next;
        return { render_id: "r-5", charge_seconds: 8 };
      },
      video_export_status: () => ({ status: "queued", progress: 0, error: null, ready: false, size_bytes: null, expires_at: null }),
    });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Exportar MP4" }));
    expect(await screen.findByText("Los servidores están llenos. Se vuelve a intentar en 5 s…")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // No Retry-After: the default wait.
    expect(await screen.findByText("Los servidores están llenos. Se vuelve a intentar en 30 s…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(await screen.findByText("Esperando un hueco para generarlo…")).toBeTruthy();
    expect(invokedWith("video_export_start").length).toBe(3);
  });

  it("skips the other formats after a refusal that applies to all of them", async () => {
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_start: () => {
        throw { kind: "subscription_required" };
      },
    });
    renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "Vertical 9:16" }));
    fireEvent.click(screen.getByRole("button", { name: "Exportar 2 MP4" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/necesitas una suscripción activa/);
    expect(await screen.findByText("No se ha exportado.")).toBeTruthy();
    expect(invokedWith("video_export_start").length).toBe(1);
  });

  it("refuses to start when the balance does not cover every format", async () => {
    resetTauri({ video_export_quota: () => ({ ...QUOTA, remaining_seconds: 10 }) });
    renderPanel();
    await screen.findByText("Te quedan 10 s de exportación este mes");
    expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: "Vertical 9:16" }));
    expect(screen.getByText("Estos formatos usan 16 s y te quedan 10 s de exportación este mes. Quita alguno o acorta el vídeo.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Exportar 2 MP4" }) as HTMLButtonElement).disabled).toBe(true);
    // None picked: nothing to export.
    fireEvent.click(screen.getByRole("checkbox", { name: "Vertical 9:16" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Horizontal 16:9" }));
    expect(screen.getByText("Elige al menos un formato.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("resumes a remembered render with its format", async () => {
    resetTauri({
      video_export_quota: () => QUOTA,
      video_export_status: () => ({ status: "done", progress: 1, error: null, ready: true, size_bytes: 10, expires_at: null }),
      video_export_download: () => ({ name: "promo-vertical.mp4", size: 10 }),
    });
    localStorage.setItem(`video.render.${PROJECT_ID}`, "r-6");
    localStorage.setItem(`video.render.${PROJECT_ID}.aspect`, "9:16");
    renderPanel();
    await waitFor(() =>
      expect(invokedWith("video_export_download")).toEqual([{ profileId: "nan", projectId: PROJECT_ID, renderId: "r-6", aspect: "9:16" }]),
    );
  });
});
