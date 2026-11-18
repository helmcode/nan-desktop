// @vitest-environment jsdom
// Composer queue + attachments: files can be attached while a reply runs;
// they travel with the queued message (sent with it when the turn ends),
// come back to the tray on Edit and are discarded on Remove.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";

const IMAGE_PATH = "/Users/ana/Library/Application Support/app/images/attachments/aaaa.jpg";

function row(id: number, role: string, content: string, endReason: string | null = null): ChatMessageRow {
  return {
    id,
    conversation_id: 8,
    role,
    content,
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
    end_reason: endReason,
  };
}

let rows: ChatMessageRow[];
let sendCalls: number;
let refuseQueued: string | null;
let pickResult: unknown;

function handlers() {
  return {
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [{ id: 8, title: "Informe", updated_at: "", last_message: null }],
    messages_list: () => rows.map((r) => ({ ...r })),
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    chat_send: () => {
      sendCalls += 1;
      if (sendCalls > 1 && refuseQueued) throw refuseQueued;
      return undefined;
    },
    chat_stop: () => undefined,
    tts_stop: () => undefined,
    attachments_pick: () => pickResult,
    attachment_discard: () => undefined,
    attachments_set_accepting: () => undefined,
    attachments_internal_drag: () => undefined,
  };
}

const composer = () => screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
const queueRegion = () => screen.getByRole("region", { name: "Mensajes en cola" });

async function startStreamingWithQueuedImage(): Promise<void> {
  resetTauri(handlers());
  render(
    <I18nProvider initial="es">
      <App />
    </I18nProvider>,
  );
  await screen.findByText("hola");
  fireEvent.change(composer(), { target: { value: "primera" } });
  fireEvent.keyDown(composer(), { key: "Enter" });
  await screen.findByRole("button", { name: "Detener" });
  // While the reply runs the paperclip still works.
  const clip = screen.getByRole("button", { name: "Adjuntar archivos" }) as HTMLButtonElement;
  expect(clip.disabled).toBe(false);
  fireEvent.click(clip);
  await screen.findByText("plano.png");
  fireEvent.change(composer(), { target: { value: "mira esto" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Enviar cuando termine" }));
  });
  // The files left the tray with the queued message.
  expect(screen.queryByRole("list", { name: "Archivos adjuntos a este mensaje" })).toBeNull();
  expect(within(queueRegion()).getByText("plano.png")).toBeTruthy();
}

beforeEach(() => {
  window.localStorage.clear();
  rows = [row(1, "user", "hola")];
  sendCalls = 0;
  refuseQueued = null;
  pickResult = {
    staged: [{ id: "img-1", kind: "image", name: "plano.png", size: 10, preview_path: IMAGE_PATH }],
    rejected: [],
  };
});
afterEach(cleanup);

describe("queued messages carry their attachments", () => {
  it("a queued message with an image is sent with it when the turn ends", async () => {
    await startStreamingWithQueuedImage();
    expect(invokedWith("chat_send")).toHaveLength(1);
    rows = [...rows, row(2, "user", "primera"), row(3, "assistant", "Hecho.", "completed")];
    await act(async () => emit("chat://done", { conversation_id: 8, reason: "completed" }));
    await waitFor(() => expect(invokedWith("chat_send")).toHaveLength(2));
    expect(invokedWith("chat_send")[1]).toMatchObject({ content: "mira esto", attachments: [{ id: "img-1" }] });
  });

  it("Edit puts the text and the files back in the composer", async () => {
    await startStreamingWithQueuedImage();
    await act(async () => {
      fireEvent.click(within(queueRegion()).getByRole("button", { name: "Editar" }));
    });
    expect(composer().value).toBe("mira esto");
    expect(screen.getByRole("list", { name: "Archivos adjuntos a este mensaje" })).toBeTruthy();
    expect(screen.getByText("plano.png")).toBeTruthy();
    expect(invokedWith("attachment_discard")).toEqual([]);
  });

  it("Remove discards the queued files", async () => {
    await startStreamingWithQueuedImage();
    await act(async () => {
      fireEvent.click(within(queueRegion()).getByRole("button", { name: "Quitar" }));
    });
    await waitFor(() => expect(invokedWith("attachment_discard")).toEqual([{ id: "img-1" }]));
    expect(screen.queryByText("plano.png")).toBeNull();
  });

  it("files alone can be queued", async () => {
    resetTauri(handlers());
    render(
      <I18nProvider initial="es">
        <App />
      </I18nProvider>,
    );
    await screen.findByText("hola");
    fireEvent.change(composer(), { target: { value: "primera" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await screen.findByRole("button", { name: "Detener" });
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText("plano.png");
    const queueButton = screen.getByRole("button", { name: "Enviar cuando termine" }) as HTMLButtonElement;
    expect(queueButton.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(queueButton);
    });
    expect(within(queueRegion()).getByText("plano.png")).toBeTruthy();
  });

  it("a queued message whose files the core refuses is held with the reason and leaves no stray bubble", async () => {
    refuseQueued = "attachments:total_too_large";
    await startStreamingWithQueuedImage();
    rows = [...rows, row(2, "user", "primera"), row(3, "assistant", "Hecho.", "completed")];
    await act(async () => emit("chat://done", { conversation_id: 8, reason: "completed" }));
    await waitFor(() => expect(invokedWith("chat_send")).toHaveLength(2));
    const region = await screen.findByRole("region", { name: "Mensajes en cola" });
    await within(region).findByText("Estos archivos ocupan demasiado juntos. Quita alguno y vuelve a intentarlo.");
    expect(within(region).getByText("plano.png")).toBeTruthy();
    await waitFor(() => {
      const bubbles = Array.from(document.querySelectorAll(".msg-user")).map((el) => el.textContent ?? "");
      expect(bubbles.some((text) => text.includes("mira esto"))).toBe(false);
    });
    expect(invokedWith("attachment_discard")).toEqual([]);
  });

  it("Edit into a tray that is already full keeps 10 files and says so", async () => {
    await startStreamingWithQueuedImage();
    pickResult = {
      staged: Array.from({ length: 10 }, (_, i) => ({
        id: `f${i}`,
        kind: "image",
        name: `f${i}.png`,
        size: 1,
        preview_path: IMAGE_PATH,
      })),
      rejected: [],
    };
    fireEvent.click(screen.getByRole("button", { name: "Adjuntar archivos" }));
    await screen.findByText("f9.png");
    await act(async () => {
      fireEvent.click(within(queueRegion()).getByRole("button", { name: "Editar" }));
    });
    const tray = screen.getByRole("list", { name: "Archivos adjuntos a este mensaje" });
    expect(within(tray).getAllByRole("listitem")).toHaveLength(10);
    expect(screen.getByText("Se pueden adjuntar hasta 10 archivos por mensaje.")).toBeTruthy();
    await waitFor(() => expect(invokedWith("attachment_discard")).toEqual([{ id: "img-1" }]));
  });
});
