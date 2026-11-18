// @vitest-environment jsdom
// In-app browser protection (owner decision: ON by default, can be turned
// off): the "Carpetas de trabajo" section shows the switch with one calm
// explanatory line, reflects the stored state and forwards changes to the
// core (which confirms an OFF natively and keeps the switch as it was when
// declined).
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import { I18nProvider } from "./i18n";
import { Settings } from "./Settings";
import type { Workspace } from "./workspace";

afterEach(cleanup);

const workspace: Workspace = {
  folders: [],
  computerWide: null,
  modes: {},
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
};

const TITLE = "Pedir permiso para órdenes y cambios después de navegar por internet";

async function mount(settings: Record<string, unknown>, setGuard: () => unknown = () => undefined) {
  resetTauri({
    tools_settings_get: () => settings,
    tools_set_browser_guard: setGuard,
    memory_settings_get: () => ({ mode: "remote" }),
    app_info: () => ({ version: "0.2.13" }),
  });
  render(
    <I18nProvider initial="es">
      <Settings
        profile={{ id: "nan", name: "NaN", has_key: true, key_mask: null }}
        workspace={workspace}
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
  await act(async () => {});
  return screen.getByRole("switch", { name: TITLE }) as HTMLInputElement;
}

describe("browser protection setting", () => {
  it("is on by default (also when an older core does not report it) with a calm explanation", async () => {
    const toggle = await mount({ tools_allow_run_command: true });
    expect(toggle.checked).toBe(true);
    const note = document.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toMatch(/hasta tu siguiente mensaje/);
    expect(note?.textContent).toMatch(/Leer archivos sigue sin preguntar/);
  });

  it("shows the stored OFF state and turns it back on through the core", async () => {
    const toggle = await mount({ tools_allow_run_command: true, browser_guard: false });
    expect(toggle.checked).toBe(false);
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(invokedWith("tools_set_browser_guard")).toEqual([{ enabled: true }]);
    expect(toggle.checked).toBe(true);
  });

  it("stays on when the user declines the native confirmation to turn it off", async () => {
    const toggle = await mount({ tools_allow_run_command: true, browser_guard: true }, () => {
      throw new Error("declined");
    });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(invokedWith("tools_set_browser_guard")).toEqual([{ enabled: false }]);
    expect(toggle.checked).toBe(true);
  });
});
