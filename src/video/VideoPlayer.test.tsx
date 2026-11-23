// @vitest-environment jsdom
// R-V1: the player always loads the composition sealed (opaque origin) from
// the core's sandboxed URL, and the side pane releases the preview token
// when it goes away.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());
vi.mock("@hyperframes/player", () => ({}));

import { I18nProvider } from "../i18n";
import { invokedWith, resetTauri } from "../test/tauriMock";
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

afterEach(cleanup);

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
    expect(screen.getByText("1:15")).toBeTruthy();
    expect(screen.getByText("30 fps")).toBeTruthy();
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
});
