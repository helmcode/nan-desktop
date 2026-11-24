// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { GrantView } from "../types";
import type { Workspace } from "../workspace";
import { FolderPicker } from "./FolderPicker";

afterEach(cleanup);

function grant(id: string, path: string, overrides: Partial<GrantView> = {}): GrantView {
  return { id, canonical_path: path, granted_at: "", profile_id: "nan", scope: "folder", mode: "ask", ...overrides };
}

const PROYECTO = grant("g1", "/Users/ana/Proyecto");
const FOTOS = grant("g2", "/Users/ana/Fotos");

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    folders: [PROYECTO, FOTOS],
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
    ...overrides,
  };
}

function renderPicker(ws: Workspace, selected: string[], locale: "en" | "es" = "en", locked = false) {
  const onChange = vi.fn();
  const onAskComputerWide = vi.fn();
  render(
    <I18nProvider initial={locale}>
      <FolderPicker
        workspace={ws}
        selected={selected}
        onChange={onChange}
        onAskComputerWide={onAskComputerWide}
        onOpenSettings={vi.fn()}
        locked={locked}
      />
    </I18nProvider>,
  );
  return { onChange, onAskComputerWide };
}

const chip = () => screen.getByTitle("Where the assistant can work");

describe("FolderPicker", () => {
  it("shows no folder selected by default (not all of them)", () => {
    renderPicker(workspace(), []);
    expect(chip().textContent).toBe("No folder");
    fireEvent.click(chip());
    expect(screen.getByRole("menuitemcheckbox", { name: "None" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemcheckbox", { name: "All" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Proyecto" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/asks where to save, or uses a temporary folder/)).toBeTruthy();
  });

  it("labels the selection and ignores folders that no longer exist", () => {
    renderPicker(workspace(), ["g2", "gone"]);
    expect(chip().textContent).toBe("Fotos");
    cleanup();
    renderPicker(workspace(), ["g1", "g2"]);
    expect(chip().textContent).toBe("Proyecto +1");
  });

  it("toggles single folders, keeping the menu open for more", () => {
    const { onChange } = renderPicker(workspace(), ["g1"]);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Fotos" }));
    expect(onChange).toHaveBeenLastCalledWith(["g1", "g2"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Proyecto" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("offers None and All shortcuts", () => {
    const { onChange } = renderPicker(workspace(), ["g1"]);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "All" }));
    expect(onChange).toHaveBeenLastCalledWith(["g1", "g2"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "None" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("selects a folder added from the chat", async () => {
    const added = grant("g9", "/Users/ana/Nueva");
    const ws = workspace({ pickFolder: vi.fn(async () => added) });
    const { onChange } = renderPicker(ws, ["g1"]);
    fireEvent.click(chip());
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Add folder…" }));
    });
    expect(ws.pickFolder).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(["g1", "g9"]);
  });

  it("with no folders at all, the chip opens the native folder picker", async () => {
    const ws = workspace({ folders: [], pickFolder: vi.fn(async () => PROYECTO) });
    const { onChange } = renderPicker(ws, []);
    expect(chip().textContent).toBe("Choose a working folder");
    await act(async () => {
      fireEvent.click(chip());
    });
    expect(onChange).toHaveBeenLastCalledWith(["g1"]);
  });

  it("keeps the whole-computer mode visible and asks before enabling it", () => {
    const { onAskComputerWide } = renderPicker(workspace(), []);
    fireEvent.click(chip());
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Whole computer, at your own risk" }));
    expect(onAskComputerWide).toHaveBeenCalledTimes(1);
    cleanup();
    const wide = grant("cw", "/Users/ana", { scope: "computer_wide" });
    renderPicker(workspace({ computerWide: wide }), []);
    expect(chip().textContent).toBe("Whole computer, at your own risk");
  });

  it("speaks Spanish", () => {
    renderPicker(workspace(), [], "es");
    fireEvent.click(screen.getByTitle("Dónde puede trabajar el asistente"));
    expect(screen.getByRole("menuitemcheckbox", { name: "Ninguna" })).toBeTruthy();
    expect(screen.getByRole("menuitemcheckbox", { name: "Todas" })).toBeTruthy();
    expect(screen.getByText("Carpetas de este chat")).toBeTruthy();
  });

  // R24: the running reply uses the selection it was sent with (the core
  // takes it with chat_send), so the chip must never show a change the reply
  // is not using.
  it("is locked while the conversation replies: shows its selection and cannot change it", () => {
    const pickFolder = vi.fn(async () => null);
    const { onChange } = renderPicker(workspace({ pickFolder }), ["g1"], "en", true);
    const locked = screen.getByTitle("You can change the folders when the reply ends");
    expect(locked.textContent).toBe("Proyecto");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(locked);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    // Not even the add-a-folder shortcut of a profile without folders.
    cleanup();
    renderPicker(workspace({ folders: [], pickFolder }), [], "en", true);
    fireEvent.click(screen.getByTitle("You can change the folders when the reply ends"));
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("closes an open menu when a reply starts", () => {
    const ws = workspace();
    const props = { workspace: ws, selected: ["g1"], onChange: vi.fn(), onAskComputerWide: vi.fn(), onOpenSettings: vi.fn() };
    const { rerender } = render(
      <I18nProvider initial="en">
        <FolderPicker {...props} />
      </I18nProvider>,
    );
    fireEvent.click(chip());
    expect(screen.getByRole("menu")).toBeTruthy();
    rerender(
      <I18nProvider initial="en">
        <FolderPicker {...props} locked />
      </I18nProvider>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(
      <I18nProvider initial="en">
        <FolderPicker {...props} />
      </I18nProvider>,
    );
    expect(chip().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(chip());
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("explains the lock in Spanish", () => {
    renderPicker(workspace(), ["g1"], "es", true);
    expect(screen.getByTitle("Podrás cambiar las carpetas cuando termine la respuesta")).toBeTruthy();
  });
});
