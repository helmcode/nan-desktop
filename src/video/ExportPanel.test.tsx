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
  vi.useRealTimers();
});

describe("ExportPanel", () => {
  it("says how much export time is left this month", async () => {
    resetTauri({ video_export_quota: () => QUOTA });
    renderPanel();
    expect(await screen.findByText("Te quedan 84 min de exportación este mes")).toBeTruthy();
    expect(screen.getByText("Se renueva el 1 de diciembre")).toBeTruthy();
    expect(screen.getByText("Usará 0:08 de tu tiempo de exportación")).toBeTruthy();
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
    await waitFor(() => expect(invokedWith("video_export_start")).toEqual([{ profileId: "nan", projectId: PROJECT_ID, quality: "draft" }]));
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
      expect(invokedWith("video_export_download")).toEqual([{ profileId: "nan", projectId: PROJECT_ID, renderId: "r-1" }]),
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

  it("explains quota, subscription and size refusals in plain words", async () => {
    const errors = [
      { kind: "quota_exhausted", remaining_seconds: 12, period_end: "2026-12-01T00:00:00Z" },
      { kind: "subscription_required" },
      { kind: "too_large" },
      { kind: "too_many_active" },
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
      /Has gastado el tiempo de exportación de este mes \(te quedan 0:12\)\. Se renueva el 1 de diciembre\./,
      /necesitas una suscripción activa/,
      /máximo 90 MB/,
      /Ya tienes dos vídeos generándose/,
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
});
