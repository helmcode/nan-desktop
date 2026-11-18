// @vitest-environment jsdom
// In-app browser permission mode (owner feedback: one simple selector like
// "Carpetas nuevas"): the "Carpetas de trabajo" section shows a "Navegador"
// row with "Preguntar siempre" / "Permitir sin preguntar", a one-line hint
// (warn-colored in allow), reflects the stored mode, forwards changes to
// the core (which confirms `allow` natively and keeps the mode when
// declined) and notes a session allow with a way back to ask.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import { I18nProvider } from "./i18n";
import type { Locale } from "./i18n/locale";
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

async function mount(
  settings: Record<string, unknown>,
  setMode: (args: Record<string, unknown> | undefined) => unknown = (args) => args?.mode,
  locale: Locale = "es",
) {
  resetTauri({
    tools_settings_get: () => settings,
    tools_set_browser_mode: setMode,
    memory_settings_get: () => ({ mode: "remote" }),
    app_info: () => ({ version: "0.2.14" }),
  });
  render(
    <I18nProvider initial={locale}>
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
  return screen.getByRole("radiogroup", { name: locale === "es" ? "Navegador" : "Browser" });
}

const radio = (group: HTMLElement, name: string) => within(group).getByRole("radio", { name }) as HTMLButtonElement;

describe("browser permission mode setting", () => {
  it("defaults to ask (also when an older core does not report it) with a calm hint", async () => {
    const group = await mount({ tools_allow_run_command: true });
    expect(screen.getByText("Navegador")).toBeTruthy();
    expect(radio(group, "Preguntar siempre").getAttribute("aria-checked")).toBe("true");
    expect(radio(group, "Permitir sin preguntar").getAttribute("aria-checked")).toBe("false");
    const hint = document.querySelector(".browser-mode-hint");
    expect(hint?.textContent).toMatch(/Pregunta antes de usar cada web nueva/);
    expect(hint?.classList.contains("warn")).toBe(false);
    // The old guard switch is gone.
    expect(screen.queryByRole("switch", { name: /después de navegar/ })).toBeNull();
  });

  it("switches to allow through the core and shows the warn hint", async () => {
    const group = await mount({ tools_allow_run_command: true, browser_mode: "ask" });
    await act(async () => {
      fireEvent.click(radio(group, "Permitir sin preguntar"));
    });
    expect(invokedWith("tools_set_browser_mode")).toEqual([{ mode: "allow" }]);
    expect(radio(group, "Permitir sin preguntar").getAttribute("aria-checked")).toBe("true");
    const hint = document.querySelector(".browser-mode-hint");
    expect(hint?.classList.contains("warn")).toBe(true);
    expect(hint?.textContent).toMatch(/Entrar en cuentas, pagar y tu red local siguen preguntando/);
  });

  it("stays on ask when the user declines the native confirmation", async () => {
    const group = await mount({ tools_allow_run_command: true, browser_mode: "ask" }, () => {
      throw new Error("declined");
    });
    await act(async () => {
      fireEvent.click(radio(group, "Permitir sin preguntar"));
    });
    expect(invokedWith("tools_set_browser_mode")).toEqual([{ mode: "allow" }]);
    expect(radio(group, "Preguntar siempre").getAttribute("aria-checked")).toBe("true");
  });

  it("shows the stored allow and goes back to ask", async () => {
    const group = await mount({ tools_allow_run_command: true, browser_mode: "allow" });
    expect(radio(group, "Permitir sin preguntar").getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(radio(group, "Preguntar siempre"));
    });
    expect(invokedWith("tools_set_browser_mode")).toEqual([{ mode: "ask" }]);
    expect(radio(group, "Preguntar siempre").getAttribute("aria-checked")).toBe("true");
  });

  it("notes a session allow and offers to ask again", async () => {
    await mount({ tools_allow_run_command: true, browser_mode: "ask", browser_session_allow: true });
    const note = screen.getByRole("status");
    expect(note.textContent).toMatch(/Permitido sin preguntar en esta sesión/);
    await act(async () => {
      fireEvent.click(within(note).getByRole("button", { name: "Volver a preguntar" }));
    });
    expect(invokedWith("tools_set_browser_mode")).toEqual([{ mode: "ask" }]);
    expect(screen.queryByText(/Permitido sin preguntar en esta sesión/)).toBeNull();
  });

  it("has the English copy", async () => {
    const group = await mount({ tools_allow_run_command: true, browser_mode: "allow" }, undefined, "en");
    expect(radio(group, "Allow without asking").getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".browser-mode-hint")?.textContent).toMatch(
      /Signing in, paying and your local network still ask/,
    );
  });
});
