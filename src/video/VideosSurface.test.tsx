// @vitest-environment jsdom
// R-V1: the Videos surface: the library, the template gallery and
// "Use this template" in the chosen format.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar Promo" }));
    expect(invokedWith("video_delete")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar Promo" }));
    await waitFor(() => expect(invokedWith("video_delete")).toEqual([{ profileId: "nan", projectId: PROJECT_ID }]));
    confirm.mockRestore();
  });
});
