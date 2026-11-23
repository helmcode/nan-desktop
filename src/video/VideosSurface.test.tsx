// @vitest-environment jsdom
// R-V1: the Videos surface: the library, the template gallery and
// "Use this template" in the chosen format.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());
vi.mock("@hyperframes/player", () => ({}));

import { I18nProvider } from "../i18n";
import { invokedWith, resetTauri } from "../test/tauriMock";
import { VideosSurface } from "./VideosSurface";
import { PREVIEW, PROJECT_ID } from "./fixtures";

const TEMPLATE = {
  id: "social-ad",
  title: "Anuncio para redes",
  description: "Vertical",
  category: "marketing",
  aspect: "9:16",
  duration: 12,
  scenes: 4,
  attribution: null,
};

function renderSurface(open = vi.fn(), projects: unknown[] = []) {
  resetTauri({
    video_list: () => projects,
    video_templates: () => [TEMPLATE, { ...TEMPLATE, id: "decision-tree", title: "Árbol", attribution: "Based on HyperFrames (Apache-2.0)" }],
    video_template_preview: () => PREVIEW,
    video_create_from_template: () => PROJECT_ID,
    video_delete: () => null,
    preview_release_site: () => null,
  });
  render(
    <I18nProvider initial="es">
      <VideosSurface profileId="nan" active projectId={null} onOpenProject={open} onClose={() => {}} onAskAssistant={() => {}} />
    </I18nProvider>,
  );
  return open;
}

afterEach(cleanup);

describe("VideosSurface", () => {
  it("starts on the templates when there are no videos yet", async () => {
    renderSurface();
    await waitFor(() => expect(screen.getByRole("tab", { name: "Plantillas" }).getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("button", { name: "Vista previa de Anuncio para redes" })).toBeTruthy();
    const poster = document.querySelector("img[src='/video-templates/social-ad.webp']");
    expect(poster).not.toBeNull();
  });

  it("previews a template live on hover and releases it after", async () => {
    renderSurface();
    const card = await screen.findByRole("button", { name: "Vista previa de Anuncio para redes" });
    fireEvent.mouseEnter(card);
    await waitFor(() => expect(invokedWith("video_template_preview")).toEqual([{ templateId: "social-ad", aspect: null, locale: "es" }]));
    await waitFor(() => expect(document.querySelector("hyperframes-player")?.hasAttribute("controls")).toBe(false));
    fireEvent.mouseLeave(card);
    await waitFor(() => expect(invokedWith("preview_release_site").length).toBe(1));
  });

  it("uses a template in the chosen format and opens the new video", async () => {
    const open = renderSurface();
    fireEvent.click(await screen.findByRole("button", { name: "Vista previa de Anuncio para redes" }));
    expect(screen.getByRole("radio", { name: "Vertical 9:16" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Cuadrado 1:1" }));
    await waitFor(() => expect(invokedWith("video_template_preview").at(-1)).toEqual({ templateId: "social-ad", aspect: "1:1", locale: "es" }));
    fireEvent.click(screen.getByRole("button", { name: "Usar la plantilla Anuncio para redes" }));
    await waitFor(() =>
      expect(invokedWith("video_create_from_template")).toEqual([{ profileId: "nan", templateId: "social-ad", aspect: "1:1", locale: "es" }]),
    );
    await waitFor(() => expect(open).toHaveBeenCalledWith(PROJECT_ID));
  });

  it("moves between tabs and formats with the arrow keys", async () => {
    renderSurface();
    const templatesTab = await screen.findByRole("tab", { name: "Plantillas" });
    await waitFor(() => expect(templatesTab.getAttribute("aria-selected")).toBe("true"));
    expect(templatesTab.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(templatesTab, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Mis vídeos" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Mis vídeos" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    fireEvent.click(await screen.findByRole("button", { name: "Vista previa de Anuncio para redes" }));
    // One way back to the gallery, named for where it goes.
    expect(screen.getByRole("button", { name: "Todas las plantillas" })).toBeTruthy();
    const vertical = screen.getByRole("radio", { name: "Vertical 9:16" });
    fireEvent.keyDown(vertical, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Cuadrado 1:1" }).getAttribute("aria-checked")).toBe("true");
  });

  it("shows loading, then a clear error when a template preview fails", async () => {
    resetTauri({
      video_list: () => [],
      video_templates: () => new Promise((ok) => setTimeout(() => ok([TEMPLATE]), 30)),
      video_template_preview: () => {
        throw { kind: "io" };
      },
    });
    render(
      <I18nProvider initial="es">
        <VideosSurface profileId="nan" active projectId={null} onOpenProject={() => {}} onClose={() => {}} onAskAssistant={() => {}} />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Plantillas" }));
    expect(screen.getByText("Cargando plantillas…")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Vista previa de Anuncio para redes" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No se ha podido cargar esta vista previa.");
  });

  it("credits templates derived from upstream examples", async () => {
    renderSurface();
    fireEvent.click(await screen.findByRole("button", { name: "Vista previa de Árbol" }));
    expect(screen.getByText("Créditos: Based on HyperFrames (Apache-2.0)")).toBeTruthy();
  });

  it("lists, opens and deletes (after confirming) the user's videos", async () => {
    const summary = { id: PROJECT_ID, title: "Promo", aspect: "16:9", width: 1920, height: 1080, duration: 12, scenes: 3, template: null, updated_ms: 0, exports: 0 };
    const open = renderSurface(vi.fn(), [summary]);
    fireEvent.click(await screen.findByRole("button", { name: "Abrir Promo" }));
    expect(open).toHaveBeenCalledWith(PROJECT_ID);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar Promo" }));
    const dialog = screen.getByRole("alertdialog", { name: "¿Eliminar este vídeo?" });
    expect(document.activeElement?.textContent).toBe("Cancelar");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(invokedWith("video_delete")).toEqual([]);
    expect(dialog).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Eliminar Promo" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(invokedWith("video_delete")).toEqual([{ profileId: "nan", projectId: PROJECT_ID }]));
  });
});
