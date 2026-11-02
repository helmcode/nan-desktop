// @vitest-environment jsdom
// Round 4 — the post-PDF freeze. After a PDF was produced and shown in the
// preview pane, switching conversations blanked the WHOLE window until a
// restart. Mechanism: React unmounts the entire root on any uncaught error
// thrown while rendering OR while committing (an effect cleanup that runs
// when the pane unmounts on the switch), and the shell had no error
// boundary. The PDF renderer is replaced here by one that fails exactly
// like that (its cleanup throws on unmount / its render throws), so these
// tests fail on the pre-round-4 shell (blank: no textbox, no sidebar) and
// pass once the failure is contained.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, resetTauri } from "./test/tauriMock";

const failure = vi.hoisted(() => ({ onUnmount: false, onRender: false }));

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());
vi.mock("./preview/renderers", async () => {
  const { useEffect } = await import("react");
  function PdfPreview({ bytes }: { bytes: Uint8Array }) {
    useEffect(
      () => () => {
        if (failure.onUnmount) throw new Error("pdf.js teardown failed");
      },
      [],
    );
    if (failure.onRender) throw new Error("pdf.js render failed");
    return <p>PDF READY ({bytes.length} bytes)</p>;
  }
  const Stub = () => <p>stub</p>;
  return { PdfPreview, ImagePreview: Stub, TextPreview: Stub, HtmlPreview: Stub, SheetPreview: Stub, DocxPreview: Stub };
});

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";

function row(
  id: number,
  conversationId: number,
  role: string,
  content: string,
  extra: Partial<ChatMessageRow> = {},
): ChatMessageRow {
  return {
    id,
    conversation_id: conversationId,
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

let store: Map<number, ChatMessageRow[]>;

function setup(): void {
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [
      { id: 7, title: "Report", updated_at: "", last_message: null },
      { id: 8, title: "Other", updated_at: "", last_message: null },
    ],
    messages_list: (args) => store.get(Number(args?.conversationId)) ?? [],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    // "%PDF-" — the bytes the core hands the pane.
    preview_read_file: () => ({ base64: "JVBERi0=" }),
    tts_stop: () => undefined,
  });
  render(
    <I18nProvider initial="en">
      <App />
    </I18nProvider>,
  );
}

/// Produce a PDF in conversation 7 the way the core reports it.
async function producePdf(): Promise<void> {
  store.get(7)!.push(
    row(2, 7, "assistant", "PDF listo.", { artifacts: [{ path: "/Users/ana/Proyecto/informe.pdf", kind: "file" }] }),
  );
  await act(async () => emit("chat://done", { conversation_id: 7 }));
}

function shellIsAlive(): void {
  // Not blank: sidebar, conversation list and composer are all rendered.
  expect(screen.getByRole("complementary", { name: "Conversations" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Report" })).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
}

beforeEach(() => {
  window.localStorage.clear();
  failure.onUnmount = false;
  failure.onRender = false;
  store = new Map([
    [7, [row(1, 7, "user", "hazme un pdf")]],
    [8, [row(50, 8, "user", "other chat")]],
  ]);
});

afterEach(cleanup);

describe("post-PDF freeze (round 4)", () => {
  it("baseline: PDF produced → pane opens → switching conversations keeps the shell", async () => {
    setup();
    await screen.findByText("hazme un pdf");
    await producePdf();
    expect(await screen.findByText(/PDF READY/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(await screen.findByText("other chat")).toBeTruthy();
    shellIsAlive();
    expect(screen.queryByText(/PDF READY/)).toBeNull();
  });

  it("a renderer whose teardown throws on the switch no longer blanks the window", async () => {
    setup();
    await screen.findByText("hazme un pdf");
    await producePdf();
    expect(await screen.findByText(/PDF READY/)).toBeTruthy();

    failure.onUnmount = true;
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(await screen.findByText("other chat")).toBeTruthy();
    shellIsAlive();

    // The other conversation is fully usable, and going back shows the
    // PDF again (the failure was contained, not remembered).
    failure.onUnmount = false;
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(await screen.findByText(/PDF READY/)).toBeTruthy();
    shellIsAlive();
  });

  it("a renderer that throws while rendering shows a closable note instead of a blank window", async () => {
    failure.onRender = true;
    setup();
    await screen.findByText("hazme un pdf");
    await producePdf();
    const pane = await screen.findByRole("complementary", { name: "Preview" });
    expect(await within(pane).findByText(/stopped working/)).toBeTruthy();
    shellIsAlive();
    expect(screen.getByText("PDF listo.")).toBeTruthy();

    fireEvent.click(within(pane).getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Preview" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Other" }));
    expect(await screen.findByText("other chat")).toBeTruthy();
    shellIsAlive();
  });
});
