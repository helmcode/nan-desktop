// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { emit, invokedWith, resetTauri } from "../test/tauriMock";
import { I18nProvider } from "../i18n";
import {
  BROWSER_DOWNLOAD_BLOCKED_EVENT,
  BROWSER_STATE_EVENT,
  CLOSED_BROWSER,
  browserHost,
  displayAddress,
  normalizeBrowserView,
  type BrowserView,
} from "../core";
import { BrowserBar, useBrowserView } from "./BrowserBar";

afterEach(cleanup);

const open: BrowserView = {
  open: true,
  url: "https://www.example.com/products/shoes?ref=1",
  title: "Shoes",
  loading: false,
  agent_conversation: null,
};

/// The bar wired exactly like App.tsx does it.
function Harness({ onStop, active = 7 }: { onStop: (id: number) => void; active?: number | null }) {
  const browser = useBrowserView();
  return (
    <BrowserBar
      view={browser.view}
      activeConversationId={active}
      downloadBlocked={browser.downloadBlocked}
      onDismissDownload={browser.dismissDownload}
      onStopAssistant={onStop}
    />
  );
}

async function mount(initial: BrowserView, locale: "en" | "es" = "en") {
  resetTauri({
    browser_state: () => initial,
    browser_control: () => undefined,
    browser_set_language: () => undefined,
  });
  const onStop = vi.fn();
  render(
    <I18nProvider initial={locale}>
      <Harness onStop={onStop} />
    </I18nProvider>,
  );
  await act(async () => {});
  return onStop;
}

describe("browserHost", () => {
  it("names the host for the turn indicator", () => {
    expect(browserHost("https://shop.example.com/a")).toBe("shop.example.com");
    expect(browserHost("about:blank")).toBeNull();
    expect(browserHost(null)).toBeNull();
  });
});

describe("displayAddress", () => {
  it("shows host and path only, never other schemes or credentials", () => {
    expect(displayAddress("https://www.example.com/a/b?q=1#x")).toBe("www.example.com/a/b");
    expect(displayAddress("https://example.com/")).toBe("example.com");
    expect(displayAddress("https://user:pw@example.com/x")).toBe("example.com/x");
    expect(displayAddress("file:///etc/passwd")).toBe("");
    expect(displayAddress("javascript:alert(1)")).toBe("");
    expect(displayAddress(null)).toBe("");
    expect(displayAddress("not a url")).toBe("");
    expect(displayAddress(`https://e.com/${"a".repeat(200)}`).length).toBeLessThanOrEqual(90);
  });
});

describe("normalizeBrowserView", () => {
  it("reads anything malformed as a closed browser", () => {
    expect(normalizeBrowserView(undefined)).toEqual(CLOSED_BROWSER);
    expect(normalizeBrowserView("x")).toEqual(CLOSED_BROWSER);
    expect(normalizeBrowserView({ open: "yes", url: 3, agent_conversation: "7" })).toEqual(CLOSED_BROWSER);
    expect(normalizeBrowserView(open)).toEqual(open);
  });
});

describe("BrowserBar", () => {
  beforeEach(() => resetTauri());

  it("renders nothing while the browser is closed", async () => {
    await mount(CLOSED_BROWSER);
    expect(screen.queryByRole("region", { name: "Assistant browser" })).toBeNull();
  });

  it("shows the read-only address and the user's own controls", async () => {
    await mount(open);
    expect(screen.getByRole("region", { name: "Assistant browser" })).toBeTruthy();
    const address = screen.getByLabelText("Page address") as HTMLInputElement;
    // Read-only, and not a live region (navigations are not announced).
    expect(address.tagName).toBe("INPUT");
    expect(address.readOnly).toBe(true);
    expect(address.getAttribute("aria-live")).toBeNull();
    expect(address.closest("[aria-live]")).toBeNull();
    expect(address.value).toBe("www.example.com/products/shoes");
    // Idle: no second status line.
    expect(document.querySelector(".browser-bar-status")).toBeNull();
    // The window language reaches the core (window title).
    expect(invokedWith("browser_set_language")).toEqual([{ language: "en" }]);
    // No stop button while no reply drives the browser.
    expect(screen.queryByRole("button", { name: /Stop the assistant/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: /Show window/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close browser" }));
    expect(invokedWith("browser_control")).toEqual([
      { action: "back" },
      { action: "forward" },
      { action: "reload" },
      { action: "show" },
      { action: "close" },
    ]);
  });

  it("follows the core's state events and lets the user stop the assistant", async () => {
    const onStop = await mount(CLOSED_BROWSER, "es");
    await act(async () => emit(BROWSER_STATE_EVENT, { ...open, loading: true, agent_conversation: 7 }));
    expect(screen.getByText("El asistente está usando el navegador. Puedes mirar o usarlo tú también.")).toBeTruthy();
    expect(screen.getByText(/Cargando/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Parar al asistente/ }));
    expect(onStop).toHaveBeenCalledWith(7);
    await act(async () => emit(BROWSER_STATE_EVENT, { ...open, agent_conversation: 3 }));
    expect(screen.getByRole("button", { name: /Parar al asistente \(otra conversación\)/ })).toBeTruthy();
    await act(async () => emit(BROWSER_STATE_EVENT, CLOSED_BROWSER));
    expect(screen.queryByRole("region", { name: "Navegador del asistente" })).toBeNull();
  });

  it("tells the user a download was blocked until dismissed", async () => {
    await mount(open);
    await act(async () => emit(BROWSER_DOWNLOAD_BLOCKED_EVENT, null));
    expect(screen.getByText(/A download was blocked/).textContent).toContain("download it from your usual browser");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/A download was blocked/)).toBeNull();
  });

  it("says so when a control fails", async () => {
    resetTauri({
      browser_state: () => open,
      browser_control: () => {
        throw new Error("the browser is closed");
      },
      browser_set_language: () => undefined,
    });
    render(
      <I18nProvider initial="en">
        <Harness onStop={vi.fn()} />
      </I18nProvider>,
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("That did not work. Try again.");
    // The alert clears on the next browser change.
    await act(async () => emit(BROWSER_STATE_EVENT, { ...open, url: "https://example.com/next" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closing from the bar removes only the bar: the chat around it stays usable", async () => {
    // Windows report (0.2.16): closing the browser from this bar left the
    // chat window white. The renderer side must never be the cause: the
    // bar unmounts cleanly on every shape of "closed" the core may send.
    let closed = false;
    resetTauri({
      browser_state: () => (closed ? CLOSED_BROWSER : open),
      browser_control: (args) => {
        if ((args as { action?: string } | undefined)?.action === "close") closed = true;
        return undefined;
      },
      browser_set_language: () => undefined,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const typed = vi.fn();
    render(
      <I18nProvider initial="es">
        <main>
          <p>chat</p>
          <Harness onStop={vi.fn()} />
          <textarea aria-label="composer" onChange={typed} />
        </main>
      </I18nProvider>,
    );
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cerrar navegador" }));
    });
    expect(invokedWith("browser_control")).toEqual([{ action: "close" }]);
    // The Destroyed handler's state, then late or malformed duplicates.
    await act(async () => emit(BROWSER_STATE_EVENT, CLOSED_BROWSER));
    await act(async () => emit(BROWSER_STATE_EVENT, CLOSED_BROWSER));
    await act(async () => emit(BROWSER_STATE_EVENT, null));
    await act(async () => emit(BROWSER_STATE_EVENT, { open: "no" }));
    expect(screen.queryByRole("region", { name: "Navegador del asistente" })).toBeNull();
    expect(screen.getByText("chat")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("composer"), { target: { value: "hola" } });
    expect(typed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    // The browser can open again afterwards.
    await act(async () => emit(BROWSER_STATE_EVENT, open));
    expect(screen.getByRole("region", { name: "Navegador del asistente" })).toBeTruthy();
  });
});
