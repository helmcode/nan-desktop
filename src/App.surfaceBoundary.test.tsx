// @vitest-environment jsdom
// R19-A at the APP level: "Save as skill" switches the main surface from the
// chat to Settings by itself when the distillation turn ends. That deletes
// the whole chat area, preview pane and its regional boundary included, so
// a throw while that subtree tears down skips every boundary deleted with
// it. The always-mounted surface boundary in App.tsx must hold it: the
// sidebar stays, an inline alert offers "Try again", and the error never
// reaches the root (no full-window recovery screen).
//
// Mutation check: with the App.tsx surface <ErrorBoundary> removed, the
// first test fails (the root recovery screen shows, the sidebar is gone).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emit, resetTauri } from "./test/tauriMock";

const failure = vi.hoisted(() => ({ onUnmount: false }));

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());
vi.mock("./preview/renderers", async () => {
  const { useEffect } = await import("react");
  // A chat-area component whose effect cleanup throws when it is deleted.
  function PdfPreview({ bytes }: { bytes: Uint8Array }) {
    useEffect(
      () => () => {
        if (failure.onUnmount) throw new Error("pdf.js teardown failed");
      },
      [],
    );
    return <p>PDF READY ({bytes.length} bytes)</p>;
  }
  const Stub = () => <p>stub</p>;
  return { PdfPreview, ImagePreview: Stub, TextPreview: Stub, HtmlPreview: Stub, SheetPreview: Stub, DocxPreview: Stub };
});

import App from "./App";
import { AppErrorBoundary } from "./ErrorBoundary";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";

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

let messages: ChatMessageRow[];
let consoleError: ReturnType<typeof vi.spyOn>;
const rootReload = vi.fn();

const distilled = {
  title: "Weekly report",
  description: "Builds the weekly PDF report. Use when: weekly report.",
  instructions: "Build the report.\n\n1. Collect.\n2. Write.\n3. Export to PDF.",
};

function setup(): void {
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [{ id: 7, title: "Report", updated_at: "", last_message: null }],
    messages_list: () => messages,
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    preview_read_file: () => ({ base64: "JVBERi0=" }),
    tts_stop: () => undefined,
    chat_send: () => undefined,
    skills_list: () => [],
  });
  // The real app runs under the root boundary (main.tsx -> startApp): if the
  // surface boundary let the error through, its recovery screen would show.
  render(
    <AppErrorBoundary onReload={rootReload}>
      <I18nProvider initial="en">
        <App />
      </I18nProvider>
    </AppErrorBoundary>,
  );
}

/// Chat with a PDF open in the preview pane, then "Save as skill" until the
/// turn ends and the app switches to Settings on its own.
async function saveAsSkillWithPdfOpen(throwOnTeardown: boolean): Promise<void> {
  await screen.findByText("weekly report please");
  messages.push(row(2, "assistant", "PDF listo.", { artifacts: [{ path: "/Users/ana/informe.pdf", kind: "file" }] }));
  await act(async () => emit("chat://done", { conversation_id: 7 }));
  expect(await screen.findByText(/PDF READY/)).toBeTruthy();

  failure.onUnmount = throwOnTeardown;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save as skill" }));
  });
  await act(async () => emit("chat://skill_draft", { conversation_id: 7, draft: distilled }));
  await act(async () => emit("chat://done", { conversation_id: 7 }));
}

function rootRecoveryAbsent(): void {
  expect(document.getElementById("crash-title")).toBeNull();
  expect(screen.queryByRole("button", { name: "Restart the app" })).toBeNull();
  expect(rootReload).not.toHaveBeenCalled();
}

beforeEach(() => {
  window.localStorage.clear();
  failure.onUnmount = false;
  rootReload.mockClear();
  messages = [row(1, "user", "weekly report please")];
  // React reports the caught error on the console; keep the output clean.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleError.mockRestore();
});

describe("chat -> Settings surface switch (R19-A)", () => {
  it("a chat-area teardown throw is contained by the surface boundary; the root never sees it", async () => {
    setup();
    await saveAsSkillWithPdfOpen(true);

    // (a) The sidebar stays (in Settings it lists the sections) and the
    // surface shows the inline alert.
    expect(screen.getByRole("complementary", { name: "Settings sections" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Account menu/ })).toBeTruthy();
    expect(
      (await screen.findByRole("alert")).textContent,
    ).toContain("This section stopped working. Your work is saved; try again.");
    // The chat area is gone (the switch happened), Settings is not shown yet.
    expect(screen.queryByText(/PDF READY/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "New skill" })).toBeNull();

    // (b) The error did not reach the root boundary.
    rootRecoveryAbsent();

    // (c) Try again restores Settings with the distilled draft.
    failure.onUnmount = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(await screen.findByRole("heading", { name: "New skill" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(distilled.title);
    expect(screen.queryByText("This section stopped working. Your work is saved; try again.")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Settings sections" })).toBeTruthy();
    rootRecoveryAbsent();
  });

  it("baseline: without a throw the switch goes straight to the draft, no alert", async () => {
    setup();
    await saveAsSkillWithPdfOpen(false);
    expect(await screen.findByRole("heading", { name: "New skill" })).toBeTruthy();
    expect(screen.queryByText("This section stopped working. Your work is saved; try again.")).toBeNull();
    rootRecoveryAbsent();
  });
});
