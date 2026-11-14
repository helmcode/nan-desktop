// @vitest-environment jsdom
// "Show in folder" next to the close button: reveals a previewed local file
// in the OS file manager through the grant-checked core command.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { I18nProvider } from "../i18n";
import { invoke, invokedWith, resetTauri } from "../test/tauriMock";
import PreviewPane from "./PreviewPane";
import type { PreviewTarget } from "./kind";

const FILE = "/Users/ana/Proyecto/notes.txt";

function renderPane(target: PreviewTarget, locale: "en" | "es" = "en") {
  return render(
    <I18nProvider initial={locale}>
      <PreviewPane target={target} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("PreviewPane: show in folder", () => {
  it("sits next to the close button and asks the core to reveal the file", async () => {
    resetTauri({
      preview_read_file: () => ({ base64: btoa("hello"), size: 5 }),
      preview_reveal_location: () => null,
    });
    renderPane({ kind: "file", ref: FILE });
    const reveal = screen.getByRole("button", { name: "Show in folder" });
    // Immediately before the close button, in the header.
    expect(reveal.nextElementSibling).toBe(screen.getByRole("button", { name: "Close preview" }));
    expect(reveal.getAttribute("title")).toBe("Show in folder");

    fireEvent.click(reveal);
    await waitFor(() => expect(invokedWith("preview_reveal_location")).toEqual([{ profileId: "nan", path: FILE }]));
    // It reveals; it never opens the file or anything else.
    const commands = invoke.mock.calls.map((call) => call[0]);
    expect(commands.filter((cmd) => cmd !== "preview_read_file" && cmd !== "preview_reveal_location")).toEqual([]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the folder cannot be shown, and clears on retry", async () => {
    let fail = true;
    resetTauri({
      preview_read_file: () => ({ base64: btoa("hello"), size: 5 }),
      preview_reveal_location: () => {
        if (fail) throw { kind: "no_grant", message: "x" };
        return null;
      },
    });
    renderPane({ kind: "file", ref: FILE });
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not open the folder.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Show in folder" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(invokedWith("preview_reveal_location")).toHaveLength(2);
  });

  it("is hidden for web pages and generated images (nothing of the user's to show)", () => {
    resetTauri({ web_preview_fetch: () => new Promise(() => {}) });
    renderPane({ kind: "web", ref: "https://example.com/a" });
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close preview" })).toBeTruthy();
    cleanup();

    renderPane({ kind: "media", ref: "/data/images/r.png" });
    expect(screen.queryByRole("button", { name: "Show in folder" })).toBeNull();
    expect(invokedWith("preview_reveal_location")).toEqual([]);
  });

  it("shows for any local file, previewable or not, and speaks Spanish", () => {
    resetTauri({ preview_read_file: () => ({ base64: "", size: 0 }) });
    renderPane({ kind: "file", ref: "/Users/ana/Proyecto/archive.zip" }, "es");
    expect(screen.getByRole("button", { name: "Mostrar en la carpeta" })).toBeTruthy();
    expect(screen.getByText("No hay vista previa para este tipo de archivo.")).toBeTruthy();
  });
});
