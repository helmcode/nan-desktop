// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { LOCALE_STORAGE_KEY } from "../i18n/locale";
import { UserMenu } from "./UserMenu";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderMenu() {
  const onOpenSettings = vi.fn();
  const onSignOut = vi.fn();
  render(
    <I18nProvider initial="en">
      <UserMenu
        accountName="cristian"
        accountDetail="Max"
        onOpenSettings={onOpenSettings}
        onSignOut={onSignOut}
        signingOut={false}
      />
    </I18nProvider>,
  );
  return { onOpenSettings, onSignOut };
}

describe("UserMenu (S20)", () => {
  it("renders the chip with avatar initial, name and a closed menu", () => {
    renderMenu();
    const chip = screen.getByRole("button", { name: /Account menu/ });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.textContent).toContain("C");
    expect(chip.textContent).toContain("cristian");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the menu with folders, memory, language, settings and sign out", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    for (const label of ["Working folders", "Memory", "Settings", "Sign out"]) {
      expect(screen.getByRole("menuitem", { name: label })).toBeTruthy();
    }
    expect(screen.getByRole("menuitemradio", { name: "English" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Español" }).getAttribute("aria-checked")).toBe("false");
  });

  it("routes entries to the right settings section", () => {
    const { onOpenSettings } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Working folders" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith("folders");
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Memory" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith("memory");
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenLastCalledWith(null);
  });

  it("switches language in place and persists it", () => {
    renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Español" }));
    expect(screen.getByRole("menuitem", { name: "Cerrar sesión" })).toBeTruthy();
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("es");
  });

  it("signs out and closes on Escape", () => {
    const { onSignOut } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
