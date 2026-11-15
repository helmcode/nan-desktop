// @vitest-environment jsdom
// Shared artifacts (F3/F4) in the app shell: the share action shows only
// where the feature is available (Helmcode: the org flag in /api/auth/me,
// top-level `artifacts` or `featureFlags`; community: entitlements.artifacts,
// the paywall copy without it), from the
// file chips and the preview header, and "Shared links" opens from the
// account menu.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider, type Locale } from "./i18n";
import type { ChatMessageRow } from "./types";

const FILE = "/Users/ana/Proyecto/notes.md";

function row(id: number, role: string, content: string): ChatMessageRow {
  return { id, conversation_id: 7, role, content, model: null, created_at: "", partial: false, media_path: null, sources: [] };
}

function setup(
  profile: "nan" | "helmcode",
  me: Record<string, unknown> | null,
  { activeEmail = null as string | null, members = [] as Array<{ userId: string; email: string }> } = {},
) {
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: profile, name: profile, has_key: true, key_mask: "sk-…abcd" }],
      active_profile: profile,
      active_user: activeEmail ? { email: activeEmail, realm: "r1" } : null,
    }),
    conversation_list: () => [{ id: 7, title: "Report", updated_at: "", last_message: null }],
    messages_list: () => [
      row(1, "user", "write notes"),
      { ...row(2, "assistant", "Done."), artifacts: [{ path: FILE, kind: "file" }] },
    ],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [
      { id: "g1", canonical_path: "/Users/ana/Proyecto", granted_at: "", profile_id: profile, scope: "folder", mode: "ask" },
    ],
    tts_stop: () => undefined,
    skills_list: () => [],
    skills_team_cache_load: () => ({ etag: null, skills: [], cached: {}, links: {} }),
    skills_team_request: () => ({ status: 200, etag: null, body: {} }),
    skills_team_cache_store_list: () => ({ etag: null, skills: [], cached: {}, links: {} }),
    preview_read_file: () => ({ base64: btoa("# Notes"), size: 7 }),
    artifacts_request: (args) => {
      if (args?.path === "/api/auth/me") return me ? { status: 200, body: me } : { status: 401, body: null };
      if (args?.path === "/api/members") return { status: 200, body: { items: members } };
      return { status: 200, body: { artifacts: [] } };
    },
  });
}

function renderApp(locale: Locale = "en") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

const chipShare = () => screen.queryByRole("button", { name: "Share notes.md as a link" });

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("share action gating", () => {
  it("Helmcode with the org flag: share from the chip opens the four-scope dialog", async () => {
    setup("helmcode", { email: "ana@acme.com", featureFlags: ["chat", "artifacts"] });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Share notes.md as a link" }));
    const dialog = await screen.findByRole("dialog", { name: "Share as a link" });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(4);
  });

  it("Helmcode's real /me (top-level artifacts: true, featureFlags list): share shows", async () => {
    setup("helmcode", { email: "ana@acme.com", role: "member", featureFlags: ["chat", "artifacts"], artifacts: true });
    renderApp();
    expect(await screen.findByRole("button", { name: "Share notes.md as a link" })).toBeTruthy();
  });

  it("Helmcode with only the top-level boolean: share shows", async () => {
    setup("helmcode", { email: "ana@acme.com", featureFlags: [], artifacts: true });
    renderApp();
    expect(await screen.findByRole("button", { name: "Share notes.md as a link" })).toBeTruthy();
  });

  it("Helmcode without the flag: no share action and no Shared links entry", async () => {
    setup("helmcode", { email: "ana@acme.com", featureFlags: ["chat", "skills_sharing"], skillsSharing: true });
    renderApp();
    await screen.findByRole("button", { name: "Open preview: notes.md" });
    await waitFor(() => expect(invokedWith("artifacts_request").length).toBeGreaterThan(0));
    expect(chipShare()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.queryByRole("menuitem", { name: "Shared links" })).toBeNull();
  });

  it("an unanswered /api/auth/me keeps it hidden", async () => {
    setup("helmcode", null);
    renderApp();
    await screen.findByRole("button", { name: "Open preview: notes.md" });
    await waitFor(() => expect(invokedWith("artifacts_request").length).toBeGreaterThan(0));
    expect(chipShare()).toBeNull();
  });

  it("community's real /me (entitlements.artifacts): a two-scope dialog", async () => {
    setup("nan", { email: "ana@x.io", entitlements: { inference: true, artifacts: true }, entitlementsError: false });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Share notes.md as a link" }));
    const dialog = await screen.findByRole("dialog", { name: "Share as a link" });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
  });

  it("community with entitlements.artifacts false: the membership copy", async () => {
    setup("nan", { email: "ana@x.io", entitlements: { inference: true, artifacts: false }, entitlementsError: false });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Share notes.md as a link" }));
    expect(await screen.findByText("Sharing links is part of the membership")).toBeTruthy();
  });

  it("community with the capability: a two-scope dialog", async () => {
    setup("nan", { email: "ana@x.io", capabilities: { inference: true, artifacts: true } });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Share notes.md as a link" }));
    const dialog = await screen.findByRole("dialog", { name: "Share as a link" });
    expect(within(dialog).getAllByRole("radio")).toHaveLength(2);
  });

  it("community without the capability: the share button opens the membership copy", async () => {
    setup("nan", { email: "ana@x.io", capabilities: { inference: false } });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Share notes.md as a link" }));
    expect(await screen.findByText("Sharing links is part of the membership")).toBeTruthy();
    expect(invokedWith("artifact_share")).toHaveLength(0);
  });

  it("community whose account endpoint sends no artifacts flag at all: the paywall stays", async () => {
    setup("nan", { email: "ana@x.io", entitlements: { inference: true }, entitlementsError: false });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Share notes.md as a link" }));
    expect(await screen.findByText("Sharing links is part of the membership")).toBeTruthy();
    expect(invokedWith("artifact_share")).toHaveLength(0);
  });

  it("community whose entitlements failed to resolve: hidden, never a paywall", async () => {
    setup("nan", { email: "ana@x.io", entitlements: null, entitlementsError: true });
    renderApp();
    await screen.findByRole("button", { name: "Open preview: notes.md" });
    await waitFor(() => expect(invokedWith("artifacts_request").length).toBeGreaterThan(0));
    expect(chipShare()).toBeNull();
  });
});

describe("entry points", () => {
  it("the preview header offers Share for the open file", async () => {
    setup("helmcode", { featureFlags: ["artifacts"] });
    renderApp();
    await screen.findByRole("button", { name: "Share notes.md as a link" });
    fireEvent.click(screen.getByRole("button", { name: "Open preview: notes.md" }));
    const pane = await screen.findByRole("complementary", { name: "Preview" });
    fireEvent.click(within(pane).getByRole("button", { name: "Share notes.md as a link" }));
    expect(await screen.findByRole("dialog", { name: "Share as a link" })).toBeTruthy();
  });

  it("Shared links opens from the account menu, in Spanish too", async () => {
    setup("helmcode", { featureFlags: ["artifacts"] });
    renderApp("es");
    await screen.findByRole("button", { name: "Compartir notes.md como enlace" });
    fireEvent.click(screen.getByRole("button", { name: /Menú de la cuenta/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Enlaces compartidos" }));
    expect(await screen.findByRole("heading", { name: "Enlaces compartidos", level: 1 })).toBeTruthy();
    await waitFor(() =>
      expect(invokedWith("artifacts_request")).toContainEqual({ profileId: "helmcode", method: "GET", path: "/api/artifacts" }),
    );
  });
});

describe("member picker (R20-B)", () => {
  const MEMBERS = [
    { userId: "u1", email: "ana@acme.com" },
    { userId: "u2", email: "bob@acme.com" },
  ];

  it("never offers the signed-in account (the realm's email)", async () => {
    setup("helmcode", { featureFlags: ["artifacts"] }, { activeEmail: "Ana@Acme.com", members: MEMBERS });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Share notes.md as a link" }));
    const dialog = await screen.findByRole("dialog", { name: "Share as a link" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Team members/ }));
    expect(await within(dialog).findByRole("checkbox", { name: "bob@acme.com" })).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox", { name: "ana@acme.com" })).toBeNull();
  });

  it("falls back to the email /api/auth/me reports", async () => {
    setup("helmcode", { email: "ana@acme.com", featureFlags: ["artifacts"] }, { members: MEMBERS });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Share notes.md as a link" }));
    const dialog = await screen.findByRole("dialog", { name: "Share as a link" });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Team members/ }));
    expect(await within(dialog).findByRole("checkbox", { name: "bob@acme.com" })).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox", { name: "ana@acme.com" })).toBeNull();
  });
});
