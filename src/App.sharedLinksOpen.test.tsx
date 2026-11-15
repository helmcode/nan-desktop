// @vitest-environment jsdom
// R20-A: the first open of "Shared links" showed "This section stopped
// working" until Try again. Root cause: with a PDF open in the preview,
// leaving the chat for Settings unmounted the PDF preview, whose cleanup
// called `doc.destroy()`. pdf.js 6 has no `destroy()` on the document proxy
// (only on the loading task), so the cleanup threw a TypeError that only
// the always-mounted surface boundary could catch. Try again "fixed" it
// because the PDF was already gone.
//
// pdfjs-dist is mocked with its REAL shape (destroy on the task only); the
// rest of the preview renderers are the real ones.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";

const pdf = vi.hoisted(() => ({ destroy: vi.fn() }));

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve() }),
      }),
    }),
    destroy: pdf.destroy,
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.js" }));

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow } from "./types";

const DIR = "/Users/ana/Proyecto";
const PDF = `${DIR}/informe.pdf`;

const ENTERPRISE_LIST = {
  artifacts: [
    {
      id: "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e",
      title: "Informe",
      filename: "informe.pdf",
      kind: "document",
      content_type: "application/pdf",
      size: 1024,
      sha256: "ab",
      scope: "members",
      status: "active",
      recipient_count: 2,
      external_count: 0,
      risk_ack_kind: null,
      expires_at: null,
      created_at: "2026-11-10T10:00:00.123456Z",
      revoked_at: null,
      revoked_reason: null,
      view_count: 0,
      last_viewed_at: null,
    },
  ],
  total: 1,
};

function setup(list: unknown): void {
  const message: ChatMessageRow = {
    id: 2,
    conversation_id: 7,
    role: "assistant",
    content: "Done.",
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
    artifacts: [{ path: PDF, kind: "file" }],
  };
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: "helmcode", name: "Helmcode", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "helmcode",
    }),
    conversation_list: () => [{ id: 7, title: "Report", updated_at: "", last_message: null }],
    messages_list: () => [message],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [
      { id: "g1", canonical_path: DIR, granted_at: "", profile_id: "helmcode", scope: "folder", mode: "ask" },
    ],
    tts_stop: () => undefined,
    skills_list: () => [],
    skills_team_cache_load: () => ({ etag: null, skills: [], cached: {}, links: {} }),
    skills_team_request: () => ({ status: 200, etag: null, body: {} }),
    skills_team_cache_store_list: () => ({ etag: null, skills: [], cached: {}, links: {} }),
    preview_read_file: () => ({ base64: btoa("%PDF-1.4"), size: 8 }),
    artifact_share: () => ({
      status: 201,
      body: { artifact: ENTERPRISE_LIST.artifacts[0], url: "https://share.helmcode.com/a/tok" },
    }),
    artifacts_request: (args) => {
      if (args?.path === "/api/auth/me") {
        return { status: 200, body: { email: "ana@acme.com", role: "admin", featureFlags: ["artifacts"], artifacts: true } };
      }
      if (args?.path === "/api/members") return { status: 200, body: { items: [] } };
      return { status: 200, body: list };
    },
  });
}

function renderApp() {
  return render(
    <I18nProvider initial="es">
      <App />
    </I18nProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  pdf.destroy.mockReset().mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openPdfPreview(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Abrir la vista previa: informe.pdf" }));
  const pane = await screen.findByRole("complementary", { name: "Vista previa" });
  await within(pane).findByRole("group", { name: /Documento PDF/ });
}

describe("R20-A: the first open of Shared links", () => {
  for (const [name, list] of [
    ["an empty list", { artifacts: [], total: 0 }],
    ["an enterprise list", ENTERPRISE_LIST],
  ] as const) {
    it(`with a PDF open in the preview and ${name}: never the crashed-section fallback`, async () => {
      setup(list);
      renderApp();
      await openPdfPreview();
      fireEvent.click(screen.getByRole("button", { name: /Menú de la cuenta/ }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Enlaces compartidos" }));
      expect(await screen.findByRole("heading", { name: "Enlaces compartidos", level: 1 })).toBeTruthy();
      await waitFor(() =>
        expect(invokedWith("artifacts_request")).toContainEqual({ profileId: "helmcode", method: "GET", path: "/api/artifacts" }),
      );
      expect(screen.queryByText(/Esta sección ha dejado de funcionar/)).toBeNull();
      // The PDF document was released through its loading task.
      expect(pdf.destroy).toHaveBeenCalledTimes(1);
    });
  }

  it("from the share dialog's Manage links, with the shared PDF still in the preview", async () => {
    setup(ENTERPRISE_LIST);
    renderApp();
    await openPdfPreview();
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    fireEvent.click(within(pane).getByRole("button", { name: "Compartir informe.pdf como enlace" }));
    const dialog = await screen.findByRole("dialog", { name: "Compartir como enlace" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Toda tu organización" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Crear enlace" }));
    const ready = await screen.findByRole("dialog", { name: "Tu enlace está listo" });
    fireEvent.click(within(ready).getByRole("button", { name: "Gestionar enlaces" }));
    expect(await screen.findByRole("heading", { name: "Enlaces compartidos", level: 1 })).toBeTruthy();
    expect(await screen.findByText("Informe")).toBeTruthy();
    expect(screen.queryByText(/Esta sección ha dejado de funcionar/)).toBeNull();
  });
});
