// @vitest-environment jsdom
// R22: the whole-computer card offers the same two approval modes as a
// folder, and the folders page warns when the whole computer allows while
// some folders still ask (the core keeps asking there: the strictest mode
// wins per path).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import { I18nProvider } from "./i18n";
import { Settings } from "./Settings";
import type { GrantMode } from "./core";
import type { GrantView } from "./types";
import type { Workspace } from "./workspace";

afterEach(cleanup);
beforeEach(() =>
  resetTauri({
    tools_settings_get: () => ({ tools_allow_run_command: true }),
    memory_settings_get: () => ({ mode: "remote" }),
    app_info: () => ({ version: "0.2.11" }),
  }),
);

function grant(id: string, path: string, overrides: Partial<GrantView> = {}): GrantView {
  return { id, canonical_path: path, granted_at: "", profile_id: "nan", scope: "folder", mode: "ask", ...overrides };
}

const WIDE = grant("cw", "/Users/ana", { scope: "computer_wide" });
const STRICT = grant("s", "/Users/ana/Contratos");
const OPEN = grant("o", "/Users/ana/Borradores");

function workspace(modes: Record<string, GrantMode>, overrides: Partial<Workspace> = {}): Workspace {
  return {
    folders: [STRICT, OPEN],
    computerWide: WIDE,
    modes,
    busy: false,
    error: "",
    clearError: vi.fn(),
    refresh: vi.fn(async () => {}),
    addFolder: vi.fn(async () => true),
    pickFolder: vi.fn(async () => null),
    repickFolder: vi.fn(async () => true),
    setMode: vi.fn(async () => null),
    enableComputerWide: vi.fn(async () => true),
    disableComputerWide: vi.fn(async () => {}),
    removeGrant: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderSettings(ws: Workspace, locale: "en" | "es" = "en") {
  return render(
    <I18nProvider initial={locale}>
      <Settings
        profile={{ id: "nan", name: "NaN", has_key: true, key_mask: null }}
        workspace={ws}
        voice="ef_dora"
        onVoiceChange={vi.fn()}
        onAskComputerWide={vi.fn()}
        onBack={vi.fn()}
        onSignOut={vi.fn()}
        signingOut={false}
        focusSection="folders"
      />
    </I18nProvider>,
  );
}

const MIXED = { cw: "allow", s: "ask", o: "allow" } as const;

describe("R22 whole-computer approval mode in Settings", () => {
  it("warns and lists the folders that still ask when the whole computer allows", () => {
    renderSettings(workspace(MIXED));
    const warning = screen.getByRole("status");
    expect(warning.textContent).toContain(
      "One folder still asks: even though whole-computer access does not ask, that folder will.",
    );
    expect(within(warning).getByText("Contratos")).toBeTruthy();
    expect(within(warning).getByText("/Users/ana/Contratos")).toBeTruthy();
    expect(within(warning).queryByText("Borradores")).toBeNull();
  });

  it("says it in natural Spanish, with a count for several folders", () => {
    renderSettings(workspace({ cw: "allow" }), "es");
    const warning = screen.getByRole("status");
    expect(warning.textContent).toContain(
      "Tienes 2 carpetas que siguen preguntando: aunque el acceso a todo el equipo no pregunte, en esas carpetas sí se preguntará.",
    );
    expect(within(warning).getByText("Contratos")).toBeTruthy();
    expect(within(warning).getByText("Borradores")).toBeTruthy();
  });

  it("shows no warning when the whole computer asks, is off, or no folder asks", () => {
    renderSettings(workspace({ ...MIXED, cw: "ask" }));
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    renderSettings(workspace(MIXED, { computerWide: null }));
    expect(screen.queryByRole("status")).toBeNull();
    cleanup();
    renderSettings(workspace(MIXED, { folders: [OPEN] }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the whole-computer card shows its mode and switches it through the core", () => {
    const ws = workspace({ cw: "ask", s: "ask", o: "allow" });
    renderSettings(ws);
    const group = screen.getByRole("radiogroup", { name: "Approval mode for the whole computer" });
    expect(within(group).getByRole("radio", { name: "Ask every time" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("The assistant can ask for any file in your user account. It asks before every action.")).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "Allow without asking" }));
    expect(ws.setMode).toHaveBeenCalledWith("cw", "allow");
  });

  it("in allow mode the card carries the same warning line as a folder, deletes included", () => {
    renderSettings(workspace(MIXED), "es");
    const card = screen.getByText("Todo el equipo").closest("li") as HTMLElement;
    const group = within(card).getByRole("radiogroup", { name: "Modo de permiso para todo el equipo" });
    expect(within(group).getByRole("radio", { name: "Permitir sin preguntar" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(within(card).getByText("Las acciones cubiertas se hacen sin preguntar, también los borrados.")).toBeTruthy();
    expect(within(card).getByText("El asistente puede usar cualquier archivo de tu usuario sin preguntarte.")).toBeTruthy();
  });
});

describe("0.2.16 new folders allow by default", () => {
  it("starts the New folders selector on Allow without asking and adds with it", () => {
    const ws = workspace({ cw: "ask", s: "ask", o: "allow" });
    renderSettings(ws);
    const group = screen.getByRole("radiogroup", { name: "New folders" });
    expect(within(group).getByRole("radio", { name: "Allow without asking" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Add folder/ }));
    expect(ws.addFolder).toHaveBeenCalledWith("allow");
    // Choosing ask is still one click away and is what gets sent.
    fireEvent.click(within(group).getByRole("radio", { name: "Ask every time" }));
    fireEvent.click(screen.getByRole("button", { name: /Add folder/ }));
    expect(ws.addFolder).toHaveBeenLastCalledWith("ask");
  });
});
