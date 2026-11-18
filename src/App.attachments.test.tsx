// @vitest-environment jsdom
// Composer attachments over the mocked Tauri IPC: the paperclip asks the
// core for its native picker, documents are read back and their text
// extracted locally, files dropped on the window arrive through the core's
// event, and `chat_send` carries the staged ids (+ text for documents).
// A sent user message shows its attachments; a refused send gives the
// files back with a plain explanation.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";
import type { StageResult } from "./core";

const IMAGE_PATH = "/Users/ana/Library/Application Support/app/images/attachments/aaaa.jpg";

function row(id: number, role: string, content: string, extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id,
    conversation_id: 7,
    role,
    content,
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
    ...extra,
  };
}

const PICKED: StageResult = {
  staged: [
    { id: "img-1", kind: "image", name: "gato.png", size: 2048, preview_path: IMAGE_PATH },
    { id: "doc-1", kind: "text", name: "notas.md", size: 12, preview_path: null },
  ],
  rejected: [],
};

function handlers(extra: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {}) {
  return {
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [{ id: 7, title: "Chat", updated_at: "", last_message: null }],
    messages_list: () => [row(1, "user", "hola"), row(2, "assistant", "¿Qué tal?")],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash", "glm5.3"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    skills_list: () => [],
    attachments_pick: () => PICKED,
    attachment_read: () => new TextEncoder().encode("# Lista\n- pan").buffer,
    attachment_discard: () => undefined,
    chat_send: () => undefined,
    ...extra,
  };
}

function renderApp() {
  return render(
    <I18nProvider initial="es">
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("composer attachments", () => {
  it("the paperclip opens the core's picker, reads documents and sends ids plus extracted text", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("¿Qué tal?");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText("gato.png");
    expect(screen.getByText("notas.md")).toBeTruthy();
    expect(invokedWith("attachments_pick")).toEqual([undefined]);
    // The document is read back once (never the image) for local extraction.
    await waitFor(() => expect(invokedWith("attachment_read")).toEqual([{ id: "doc-1" }]));
    await waitFor(() => expect(screen.queryByText("Leyendo…")).toBeNull());

    // Files alone are a valid message: the send button is enabled.
    const send = screen.getByRole("button", { name: "Enviar" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(invokedWith("chat_send")).toHaveLength(1));
    expect(invokedWith("chat_send")[0]).toMatchObject({
      conversationId: 7,
      content: "",
      attachments: [{ id: "img-1" }, { id: "doc-1", text: "# Lista\n- pan" }],
    });
    // The tray is cleared; the optimistic bubble shows the files.
    await waitFor(() => expect(screen.queryByRole("list", { name: "Archivos adjuntos a este mensaje" })).toBeNull());
    expect(screen.getByRole("img", { name: "gato.png" })).toBeTruthy();
  });

  it("removing a chip discards the staged file and a plain-text message carries no attachments", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("¿Qué tal?");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText("gato.png");
    fireEvent.click(screen.getByRole("button", { name: "Quitar gato.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Quitar notas.md" }));
    await waitFor(() => expect(invokedWith("attachment_discard")).toEqual([{ id: "img-1" }, { id: "doc-1" }]));
    fireEvent.change(screen.getByRole("textbox", { name: "Mensaje" }), { target: { value: "solo texto" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await waitFor(() => expect(invokedWith("chat_send")).toHaveLength(1));
    expect(invokedWith("chat_send")[0]).not.toHaveProperty("attachments");
  });

  it("files dropped on the window arrive through the core's event, with rejections explained", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("¿Qué tal?");
    act(() => emit("tauri://drag-enter", { paths: ["/x/a.png"], position: { x: 1, y: 1 } }));
    await screen.findByText("Suelta los archivos aquí para adjuntarlos");
    act(() =>
      emit("attachments://dropped", {
        staged: [{ id: "img-2", kind: "image", name: "foto.jpg", size: 10, preview_path: IMAGE_PATH }],
        rejected: [{ name: "programa.exe", reason: "unsupported" }],
      }),
    );
    await screen.findByText("foto.jpg");
    expect(screen.queryByText("Suelta los archivos aquí para adjuntarlos")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "No se puede leer «programa.exe». Prueba con una imagen, un PDF, un Word, una hoja de cálculo o un archivo de texto.",
    );
  });

  it("a refused send gives the files back and says why in plain words", async () => {
    resetTauri(
      handlers({
        chat_send: () => {
          throw "attachments:total_too_large";
        },
      }),
    );
    renderApp();
    await screen.findByText("¿Qué tal?");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText("gato.png");
    await waitFor(() => expect(screen.queryByText("Leyendo…")).toBeNull());
    fireEvent.change(screen.getByRole("textbox", { name: "Mensaje" }), { target: { value: "mira" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("Estos archivos ocupan demasiado juntos. Quita alguno y vuelve a intentarlo.");
    expect(screen.getByText("gato.png")).toBeTruthy();
    expect(screen.getByText("notas.md")).toBeTruthy();
  });

  it("a sent message shows its image thumbnails and document chips after a reload", async () => {
    resetTauri(
      handlers({
        messages_list: () => [
          row(1, "user", "revisa esto", {
            attachments: [
              { id: "i", kind: "image", name: "plano.jpg", size: 5000, path: IMAGE_PATH, truncated: false },
              { id: "d", kind: "pdf", name: "contrato.pdf", size: 3_500_000, path: null, truncated: true },
            ],
          }),
          row(2, "assistant", "Hecho."),
        ],
      }),
    );
    renderApp();
    await screen.findByText("Hecho.");
    const img = screen.getByRole("img", { name: "plano.jpg" }) as HTMLImageElement;
    expect(img.src).toContain("images/attachments/aaaa.jpg");
    expect(screen.getByText("contrato.pdf")).toBeTruthy();
    expect(screen.getByText("Solo se ha usado el principio")).toBeTruthy();
    expect(screen.getByText("revisa esto")).toBeTruthy();
  });

  it("more than ten files: the extra ones are discarded with a plain notice", async () => {
    const many: StageResult = {
      staged: Array.from({ length: 12 }, (_, i) => ({
        id: `f${i}`,
        kind: "image" as const,
        name: `f${i}.png`,
        size: 1,
        preview_path: IMAGE_PATH,
      })),
      rejected: [],
    };
    resetTauri(handlers({ attachments_pick: () => many }));
    renderApp();
    await screen.findByText("¿Qué tal?");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText("f9.png");
    expect(screen.queryByText("f10.png")).toBeNull();
    expect(screen.getByText("Se pueden adjuntar hasta 10 archivos por mensaje.")).toBeTruthy();
    await waitFor(() => expect(invokedWith("attachment_discard")).toEqual([{ id: "f10" }, { id: "f11" }]));
  });
  it("a pasted screenshot is staged as an image; a plain-text paste is left alone", async () => {
    resetTauri(
      handlers({
        attachments_stage_bytes: (args) => ({
          id: "p1",
          kind: "image",
          name: String(args?.name),
          size: 4,
          preview_path: IMAGE_PATH,
        }),
      }),
    );
    renderApp();
    await screen.findByText("¿Qué tal?");
    const box = screen.getByRole("textbox", { name: "Mensaje" });
    const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    fireEvent.paste(box, { clipboardData: { files: [png] } });
    await screen.findByText("Imagen pegada.png");
    expect(invokedWith("attachments_stage_bytes")).toEqual([
      { name: "Imagen pegada.png", dataBase64: btoa(String.fromCharCode(137, 80, 78, 71)) },
    ]);
    fireEvent.paste(box, { clipboardData: { files: [] } });
    expect(invokedWith("attachments_stage_bytes")).toHaveLength(1);
  });
  it("a clipboard with text and an image (Office, Excel) pastes the text and stages nothing", async () => {
    resetTauri(handlers({ attachments_stage_bytes: () => ({}) }));
    renderApp();
    await screen.findByText("¿Qué tal?");
    const box = screen.getByRole("textbox", { name: "Mensaje" });
    const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.assign(event, {
      clipboardData: { files: [png], getData: (type: string) => (type === "text/plain" ? "A1\tB1\n" : "") },
    });
    box.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invokedWith("attachments_stage_bytes")).toHaveLength(0);
  });

  it("removing a chip moves focus to the next chip, then the previous one, then the composer", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("¿Qué tal?");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText("gato.png");
    fireEvent.click(screen.getByRole("button", { name: "Quitar gato.png" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Quitar notas.md" })));
    fireEvent.click(screen.getByRole("button", { name: "Quitar notas.md" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Mensaje" })));
  });

  it("removing the last chip of several focuses the previous chip", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("¿Qué tal?");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText("notas.md");
    fireEvent.click(screen.getByRole("button", { name: "Quitar notas.md" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Quitar gato.png" })));
  });

  it("the tray announces changes politely, marks reading chips busy, and the notice closes with its own label", async () => {
    let release: (bytes: ArrayBuffer) => void = () => {};
    resetTauri(
      handlers({
        attachment_read: () => new Promise<ArrayBuffer>((resolve) => (release = resolve)),
        attachments_pick: () => ({ ...PICKED, rejected: [{ name: "x.key", reason: "not_allowed" }] }),
      }),
    );
    renderApp();
    await screen.findByText("¿Qué tal?");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    const tray = await screen.findByRole("list", { name: "Archivos adjuntos a este mensaje" });
    expect(tray.getAttribute("aria-live")).toBe("polite");
    const reading = screen.getByText("notas.md").closest("li");
    expect(reading?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain(
      "«x.key» no se puede adjuntar. Prueba con una imagen, un PDF, un Word, una hoja de cálculo o un archivo de texto.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    act(() => release(new TextEncoder().encode("hola").buffer));
    await waitFor(() => expect(screen.getByText("notas.md").closest("li")?.getAttribute("aria-busy")).toBe("false"));
  });

  it("a scanned PDF without text suggests attaching it as an image", async () => {
    resetTauri(handlers({ attachment_read: () => new Uint8Array([32, 32]).buffer }));
    renderApp();
    await screen.findByText("¿Qué tal?");
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText(
      "No se encontró texto en «notas.md». Si es un documento escaneado, adjunta una captura como imagen.",
    );
  });
});
