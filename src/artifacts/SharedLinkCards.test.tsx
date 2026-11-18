// @vitest-environment jsdom
// share_artifact link cards under a reply: copy, open, scope, expiry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invokedWith, resetTauri } from "../test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());

import { I18nProvider } from "../i18n";
import type { Locale } from "../i18n/locale";
import type { SharedLink } from "../types";
import { formatExpiry, isExpired, isOpenableLink, SharedLinkCards } from "./SharedLinkCards";

const LINK: SharedLink = {
  url: "https://artifacts.helmcode.com/a/tok-1",
  title: "Calculadora de hipoteca",
  scope: "emails",
  recipients: ["ana@acme.com", "bo@acme.com"],
  expires_at: "2026-12-18T10:00:00Z",
};

function renderCards(links: SharedLink[], locale: Locale = "en") {
  return render(
    <I18nProvider initial={locale}>
      <SharedLinkCards links={links} />
    </I18nProvider>,
  );
}

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  resetTauri();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SharedLinkCards", () => {
  it("renders nothing without links", () => {
    const { container } = renderCards([]);
    expect(container.innerHTML).toBe("");
  });

  it("shows the title, the recipients, the expiry and the link", () => {
    renderCards([LINK]);
    expect(screen.getByRole("list", { name: "Links shared in this reply" })).toBeTruthy();
    expect(screen.getByText("Calculadora de hipoteca")).toBeTruthy();
    expect(screen.getByText(/2 people/)).toBeTruthy();
    expect(screen.getByText(/ana@acme.com, bo@acme.com/)).toBeTruthy();
    expect(screen.getByText(/Expires Dec 18, 2026/)).toBeTruthy();
    expect(screen.getByText(LINK.url)).toBeTruthy();
  });

  it("labels public and organization links, in Spanish too", () => {
    renderCards(
      [
        { ...LINK, url: "https://a.example/a/1", scope: "public", recipients: [], title: "Web" },
        { ...LINK, url: "https://a.example/a/2", scope: "org", recipients: [], expires_at: null, title: "Informe" },
      ],
      "es",
    );
    expect(screen.getByText(/Enlace público/)).toBeTruthy();
    expect(screen.getByText("Organización")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Copiar el enlace de/ })).toHaveLength(2);
  });

  it("copies the link and confirms it", async () => {
    renderCards([LINK]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Copy the link to ${LINK.title}` }));
    });
    expect(writeText).toHaveBeenCalledWith(LINK.url);
    // Announced through a persistent polite live region (the button's
    // aria-label would hide its text from screen readers).
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe("Link copied");
  });

  it("says so when the clipboard refuses", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    renderCards([LINK]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: `Copy the link to ${LINK.title}` }));
    });
    expect(screen.getByRole("alert").textContent).toContain("Could not copy the link");
  });

  it("opens the link in the system browser through the core", () => {
    renderCards([LINK]);
    fireEvent.click(screen.getByRole("button", { name: `Open ${LINK.title} in the browser` }));
    expect(invokedWith("open_external")).toEqual([{ url: LINK.url }]);
  });

  it("never shows or opens a link that is not plain https", () => {
    renderCards([
      { ...LINK, url: "javascript:alert(1)" },
      { ...LINK, url: "http://artifacts.helmcode.com/a/x" },
    ]);
    expect(screen.queryByRole("list")).toBeNull();
    expect(isOpenableLink("https://a.example/a/t")).toBe(true);
    expect(isOpenableLink("https://a.example/a b")).toBe(false);
  });

  it("marks an expired link", () => {
    renderCards([{ ...LINK, expires_at: "2020-01-01T00:00:00Z" }], "es");
    expect(screen.getByText("Caducado")).toBeTruthy();
    expect(screen.queryByText(/Caduca el/)).toBeNull();
    expect(isExpired("2020-01-01T00:00:00Z")).toBe(true);
    expect(isExpired("2999-01-01T00:00:00Z")).toBe(false);
    expect(isExpired(null)).toBe(false);
    expect(isExpired("soon")).toBe(false);
  });

  it("formats the expiry per locale and ignores bad dates", () => {
    expect(formatExpiry("2026-12-18T10:00:00Z", "en")).toBe("Dec 18, 2026");
    expect(formatExpiry(null, "en")).toBeNull();
    expect(formatExpiry("soon", "en")).toBeNull();
  });
});
