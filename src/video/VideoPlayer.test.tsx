// @vitest-environment jsdom
// R-V1: the player always loads the composition sealed (opaque origin) from
// the core's sandboxed URL, and the side pane releases the preview token
// when it goes away.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());
vi.mock("@hyperframes/player", () => ({}));
const lintResult = vi.hoisted(() => ({ problems: [] as unknown[] }));
vi.mock("./lint", () => ({ lintProject: async () => lintResult.problems, problemsForAssistant: () => "" }));

import { I18nProvider } from "../i18n";
import { emit, invokedWith, resetTauri } from "../test/tauriMock";
import { VIDEO_REFRESH_MS } from "./useVideoRevision";
import { resetExportQueues } from "./exportQueue";
import { project } from "./fixtures";
import PreviewPane from "../preview/PreviewPane";
import { PLAYER_SANDBOX_ORIGIN, VideoPlayer } from "./VideoPlayer";
import { formatTime, type VideoPreviewInfo } from "./api";

const ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "fedcba9876543210fedcba9876543210";
const INFO: VideoPreviewInfo = {
  url: `nan-site://localhost/${TOKEN}`,
  title: "Promo",
  width: 1080,
  height: 1920,
  fps: 30,
  duration: 75,
  aspect: "9:16",
};

afterEach(() => {
  cleanup();
  resetExportQueues();
  lintResult.problems = [];
  vi.useRealTimers();
});

describe("VideoPlayer", () => {
  it("creates the sealed player on the core's URL with the canvas size", async () => {
    render(
      <I18nProvider initial="es">
        <VideoPlayer info={INFO} />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.querySelector("hyperframes-player")).not.toBeNull());
    const player = document.querySelector("hyperframes-player")!;
    expect(PLAYER_SANDBOX_ORIGIN).toBe("opaque");
    expect(player.getAttribute("sandbox-origin")).toBe("opaque");
    expect(player.getAttribute("src")).toBe(INFO.url);
    expect(player.getAttribute("width")).toBe("1080");
    expect(player.getAttribute("height")).toBe("1920");
    expect(player.getAttribute("aria-label")).toBe("Reproductor de vídeo: Promo");
    expect(screen.getByLabelText("Formato 9:16").textContent).toBe("9:16");
    expect(screen.getByText("1 min 15 s")).toBeTruthy();
    // No fullscreen for the composition: the button is hidden.
    expect(player.hasAttribute("disable-fullscreen")).toBe(true);
    expect(screen.getByText("30 fps")).toBeTruthy();
  });

  it("narrows the frame to autoplay before loading, and resumes at startAt once ready", async () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("allow", "autoplay; fullscreen");
    const seeks: number[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(proto, "iframeElement", { configurable: true, get: () => frame });
    proto.seek = (t: number) => seeks.push(t);
    try {
      render(
        <I18nProvider initial="es">
          <VideoPlayer info={INFO} startAt={12.5} />
        </I18nProvider>,
      );
      await waitFor(() => expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toBe(INFO.url));
      expect(frame.getAttribute("allow")).toBe("autoplay");
      document.querySelector("hyperframes-player")!.dispatchEvent(new CustomEvent("ready"));
      expect(seeks).toEqual([12.5]);
    } finally {
      delete proto.iframeElement;
      delete proto.seek;
    }
  });

  it("goes full screen on the player (never the composition frame) and Escape leaves it", async () => {
    const requested: Element[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.requestFullscreen = function (this: Element) {
      requested.push(this);
      return Promise.resolve();
    };
    try {
      const onClose = vi.fn();
      resetTauri({ video_preview: () => INFO, preview_release_site: () => null });
      render(
        <I18nProvider initial="es">
          <PreviewPane target={{ kind: "video", ref: ID }} profileId="nan" onClose={onClose} onOpenLink={() => {}} />
        </I18nProvider>,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Pantalla completa" }));
      const figure = document.querySelector("figure.video-player")!;
      expect(figure.classList.contains("fullscreen")).toBe(true);
      expect(requested).toEqual([figure]);
      expect(screen.getByRole("dialog", { name: "Reproductor de vídeo: Promo" })).toBe(figure);
      // Not modal (the player's own controls stay reachable); the keyboard
      // lands on the exit button.
      expect(figure.hasAttribute("aria-modal")).toBe(false);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Salir de pantalla completa" }));
      // The composition frame still gets no fullscreen permission.
      expect(document.querySelector("hyperframes-player")!.hasAttribute("disable-fullscreen")).toBe(true);
      // Escape leaves full screen, and only that (the panel stays open).
      fireEvent.keyDown(window, { key: "Escape" });
      expect(figure.classList.contains("fullscreen")).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      delete proto.requestFullscreen;
    }
  });

  it("leaves full screen when a tool asks for approval (the card must not hide under it)", async () => {
    resetTauri({});
    render(
      <I18nProvider initial="es">
        <VideoPlayer info={INFO} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pantalla completa" }));
    const figure = document.querySelector("figure.video-player")!;
    expect(figure.classList.contains("fullscreen")).toBe(true);
    await act(async () => emit("tools://approval-request", { approval_id: "a1", conversation_id: 1 }));
    expect(figure.classList.contains("fullscreen")).toBe(false);
  });

  it("stays full screen when an assistant edit reloads the preview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let n = 0;
    resetTauri({
      video_preview: () => ({ ...INFO, url: `nan-site://localhost/${String(++n).padStart(32, "0")}` }),
      preview_release_site: () => null,
    });
    render(
      <I18nProvider initial="es">
        <PreviewPane target={{ kind: "video", ref: ID }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Pantalla completa" }));
    await act(async () => {
      emit("video://changed", { conversation_id: 1, project_id: ID, title: "Promo" });
      await vi.advanceTimersByTimeAsync(VIDEO_REFRESH_MS + 10);
    });
    await waitFor(() => expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toContain("02"));
    expect(document.querySelector("figure.video-player")!.classList.contains("fullscreen")).toBe(true);
    expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toBeTruthy();
  });

  it("falls back to filling the window when the webview has no Fullscreen API", async () => {
    render(
      <I18nProvider initial="en">
        <VideoPlayer info={INFO} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
    const figure = document.querySelector("figure.video-player")!;
    expect(figure.classList.contains("fullscreen")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Exit full screen" }));
    expect(figure.classList.contains("fullscreen")).toBe(false);
  });

  it("formats times as m:ss and h:mm:ss", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5.9)).toBe("0:05");
    expect(formatTime(600)).toBe("10:00");
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(Number.NaN)).toBe("0:00");
  });
});

describe("PreviewPane: video target", () => {
  it("asks the core for the project's preview and releases it on close", async () => {
    resetTauri({ video_preview: () => INFO, preview_release_site: () => null });
    const view = render(
      <I18nProvider initial="en">
        <PreviewPane target={{ kind: "video", ref: ID }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
      </I18nProvider>,
    );
    expect(await screen.findByText("Promo")).toBeTruthy();
    expect(invokedWith("video_preview")).toEqual([{ profileId: "nan", projectId: ID }]);
    await waitFor(() => expect(document.querySelector("hyperframes-player")).not.toBeNull());
    // No share button for a video, no "show in folder" (it lives in the app library).
    expect(screen.queryByRole("button", { name: /share/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
    view.unmount();
    await waitFor(() => expect(invokedWith("preview_release_site")).toEqual([{ token: TOKEN }]));
  });

  it("explains a project that no longer exists, and never loads a malformed id", async () => {
    resetTauri({
      video_preview: () => {
        throw { kind: "not_found", message: "x" };
      },
    });
    render(
      <I18nProvider initial="es">
        <PreviewPane target={{ kind: "video", ref: ID }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
      </I18nProvider>,
    );
    expect(await screen.findByText("Este vídeo ya no existe.")).toBeTruthy();
    cleanup();
    resetTauri({ video_preview: () => INFO });
    render(
      <I18nProvider initial="es">
        <PreviewPane target={{ kind: "video", ref: "../x" }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
      </I18nProvider>,
    );
    expect(invokedWith("video_preview")).toEqual([]);
  });

  it("offers the editor when the app wires it", async () => {
    resetTauri({ video_preview: () => INFO, preview_release_site: () => null });
    const open = vi.fn();
    render(
      <I18nProvider initial="es">
        <PreviewPane
          target={{ kind: "video", ref: ID }}
          profileId="nan"
          onClose={() => {}}
          onOpenLink={() => {}}
          onOpenVideo={open}
        />
      </I18nProvider>,
    );
    screen.getByRole("button", { name: "Editar vídeo" }).click();
    expect(open).toHaveBeenCalledWith(ID);
  });

  it("reloads when the assistant changes the video, keeping the playhead and releasing the old preview", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const seeks: number[] = [];
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.seek = (t: number) => seeks.push(t);
    try {
      let n = 0;
      resetTauri({
        video_preview: () => ({ ...INFO, url: `nan-site://localhost/${String(++n).padStart(32, "0")}` }),
        preview_release_site: () => null,
      });
      render(
        <I18nProvider initial="es">
          <PreviewPane target={{ kind: "video", ref: ID }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
        </I18nProvider>,
      );
      await waitFor(() => expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toContain("01"));
      document.querySelector("hyperframes-player")!.dispatchEvent(new CustomEvent("timeupdate", { detail: { currentTime: 9 } }));
      await act(async () => {
        emit("video://changed", { conversation_id: 1, project_id: ID, title: "Promo" });
        emit("video://changed", { conversation_id: 1, project_id: ID, title: "Promo" });
      });
      // Debounced: nothing yet, the old preview stays on screen.
      expect(invokedWith("video_preview").length).toBe(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(VIDEO_REFRESH_MS + 10);
      });
      await waitFor(() => expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toContain("02"));
      expect(invokedWith("video_preview").length).toBe(2);
      document.querySelector("hyperframes-player")!.dispatchEvent(new CustomEvent("ready"));
      expect(seeks.at(-1)).toBe(9);
      expect(invokedWith("preview_release_site")).toEqual([{ token: "1".padStart(32, "0") }]);
      // Another project's change is not ours.
      await act(async () => {
        emit("video://changed", { conversation_id: 1, project_id: "f".repeat(32), title: "x" });
        await vi.advanceTimersByTimeAsync(VIDEO_REFRESH_MS + 10);
      });
      expect(invokedWith("video_preview").length).toBe(2);
    } finally {
      delete proto.seek;
    }
  });

  it("keeps the last good preview when a reload fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    resetTauri({
      video_preview: () => {
        calls += 1;
        if (calls > 1) throw { kind: "io", message: "x" };
        return INFO;
      },
      preview_release_site: () => null,
    });
    render(
      <I18nProvider initial="es">
        <PreviewPane target={{ kind: "video", ref: ID }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.querySelector("hyperframes-player")).not.toBeNull());
    await act(async () => {
      emit("video://changed", { conversation_id: 1, project_id: ID, title: "Promo" });
      await vi.advanceTimersByTimeAsync(VIDEO_REFRESH_MS + 10);
    });
    expect(calls).toBe(2);
    expect(document.querySelector("hyperframes-player")?.getAttribute("src")).toBe(INFO.url);
    expect(screen.queryByText("No se ha podido cargar la vista previa del vídeo.")).toBeNull();
  });

  it("exports the MP4 from the panel with the same export as the editor", async () => {
    const quota = { included_seconds: 7200, used_seconds: 0, remaining_seconds: 7200, period_end: null };
    resetTauri({
      video_preview: () => INFO,
      preview_release_site: () => null,
      video_get: () => project({ id: ID }),
      video_export_quota: () => quota,
      video_export_start: () => ({ render_id: "r-1", charge_seconds: 8 }),
      video_export_status: () => ({ status: "done", progress: 1, error: null, ready: true, size_bytes: 9, expires_at: null }),
      video_export_download: () => ({ name: "promo-horizontal.mp4", size: 9 }),
      video_export_reveal: () => null,
    });
    render(
      <I18nProvider initial="es">
        <PreviewPane target={{ kind: "video", ref: ID }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
      </I18nProvider>,
    );
    const toggle = await screen.findByRole("button", { name: "Exportar", expanded: false });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("Te quedan 120 min de exportación este mes")).toBeTruthy();
    // The section it controls comes into view with the keyboard on its heading.
    const section = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(section).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(section).getByRole("heading", { name: "Exportar MP4" })));
    const start = await screen.findByRole("button", { name: "Exportar MP4" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByText("Tu MP4 está listo.")).toBeTruthy();
    expect(invokedWith("video_export_start")).toEqual([{ profileId: "nan", projectId: ID, quality: "standard", aspect: "16:9" }]);
  });

  it("does not export from the panel while the check finds errors", async () => {
    lintResult.problems = [{ file: "index.html", severity: "error", code: "x", message: "x" }];
    resetTauri({
      video_preview: () => INFO,
      preview_release_site: () => null,
      video_get: () => project({ id: ID }),
      video_export_quota: () => ({ included_seconds: 7200, used_seconds: 0, remaining_seconds: 7200, period_end: null }),
    });
    render(
      <I18nProvider initial="es">
        <PreviewPane target={{ kind: "video", ref: ID }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Exportar" }));
    expect(await screen.findByText(/tiene problemas que arreglar antes de exportarlo/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Exportar MP4" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
