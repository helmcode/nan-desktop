// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("has no Skills entry: Skills is a section of the Settings surface (S2)", () => {
    const { onOpenSettings } = renderMenu();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.queryByRole("menuitem", { name: "Skills" })).toBeNull();
    // "Settings" opens the first section (Account); the surface's own sidebar
    // is what leads to Skills from there.
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

describe("UserMenu update button states (round 14 QA)", () => {
  function renderWithUpdate(update: {
    version: string;
    onUpdate: () => Promise<void>;
    busy: boolean;
  }): void {
    render(
      <I18nProvider initial="en">
        <UserMenu
          accountName="cristian"
          accountDetail="Max"
          update={update}
          onOpenSettings={vi.fn()}
          onSignOut={vi.fn()}
          signingOut={false}
        />
      </I18nProvider>,
    );
  }

  it("a failed install shows the alert and re-enables the button", async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error("boom"));
    const { rerender } = render(
      <I18nProvider initial="en">
        <UserMenu
          accountName="cristian"
          accountDetail="Max"
          update={{ version: "0.2.3", onUpdate, busy: false }}
          onOpenSettings={vi.fn()}
          onSignOut={vi.fn()}
          signingOut={false}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    const button = await screen.findByRole("menuitem", { name: "Update" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toBeTruthy();
    // The rerender mirrors the parent passing the non-busy state again.
    rerender(
      <I18nProvider initial="en">
        <UserMenu
          accountName="cristian"
          accountDetail="Max"
          update={{ version: "0.2.3", onUpdate, busy: false }}
          onOpenSettings={vi.fn()}
          onSignOut={vi.fn()}
          signingOut={false}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("menuitem", { name: "Update" }).getAttribute("aria-disabled")).toBe("false");
  });

  it("round 14 QA: while another surface installs, the item is busy and inert", () => {
    const onUpdate = vi.fn(async () => {});
    renderWithUpdate({ version: "0.2.3", onUpdate, busy: true });
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    // Round 14 (C8): the same copy key as the banner, with the version.
    expect(screen.getByText("A new version is available: 0.2.3")).toBeTruthy();
    const item = screen.getByRole("menuitem", { name: "Updating…" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(item);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("round 14 (C7): a failure does not survive closing and reopening the menu", async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error("boom"));
    renderWithUpdate({ version: "0.2.3", onUpdate, busy: false });
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Update" }));
    });
    expect(await screen.findByRole("alert")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Update" })).toBeTruthy();
  });

  it("while installing the button is busy and cannot fire twice", async () => {
    let release: (() => void) | null = null;
    const onUpdate = vi.fn(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );
    const { rerender } = render(
      <I18nProvider initial="en">
        <UserMenu
          accountName="cristian"
          accountDetail="Max"
          update={{ version: "0.2.3", onUpdate, busy: false }}
          onOpenSettings={vi.fn()}
          onSignOut={vi.fn()}
          signingOut={false}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    const button = await screen.findByRole("menuitem", { name: "Update" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole("menuitem", { name: "Updating…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Updating…" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Updating…" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    // Once the install settles, the component's own busy state clears.
    await act(async () => {
      release?.();
    });
    expect(screen.getByRole("menuitem", { name: "Update" }).getAttribute("aria-disabled")).toBe("false");
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });
});
