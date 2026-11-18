// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { Locale } from "../i18n/locale";
import type { Nudge } from "../chat/allowNudge";
import { AllowNudgeCard } from "./AllowNudgeCard";

afterEach(cleanup);

const folderNudge: Nudge = {
  conversationId: 7,
  target: { kind: "folder", grantId: "g1", path: "/Users/ana/Proyecto" },
  anchorIndex: 2,
  status: "open",
};

function renderNudge(nudge: Nudge, locale: Locale = "en") {
  const handlers = { onAllow: vi.fn(), onAllowBrowser: vi.fn(), onOpenSettings: vi.fn(), onDismiss: vi.fn() };
  render(
    <I18nProvider initial={locale}>
      <AllowNudgeCard nudge={nudge} folderName="Proyecto" {...handlers} />
    </I18nProvider>,
  );
  return handlers;
}

describe("AllowNudgeCard", () => {
  it("suggests always allowing the folder, in Spanish", () => {
    renderNudge(folderNudge, "es");
    expect(
      screen.getByText("Estás aprobando muchas acciones en Proyecto. ¿Quieres permitir siempre en esta carpeta?"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permitir siempre" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Descartar sugerencia" })).toBeTruthy();
  });

  it("switches with one click and dismisses with the X", () => {
    const handlers = renderNudge(folderNudge);
    fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
    expect(handlers.onAllow).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
    expect(handlers.onOpenSettings).not.toHaveBeenCalled();
  });

  it("points to Settings for whole-computer access (allow is chosen there, never in the chat)", () => {
    const handlers = renderNudge({ ...folderNudge, target: { kind: "computer_wide" } });
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(handlers.onOpenSettings).toHaveBeenCalledTimes(1);
    expect(handlers.onAllow).not.toHaveBeenCalled();
  });

  it("waits for the native confirmation, then collapses to the outcome", () => {
    renderNudge({ ...folderNudge, status: "switching" });
    expect(screen.queryByRole("button", { name: "Always allow" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Waiting for your confirmation");
    cleanup();
    renderNudge({ ...folderNudge, status: "allowed" });
    expect(screen.getByRole("status").textContent).toContain("Actions in Proyecto are now always allowed.");
  });

  describe("browser suggestion", () => {
    const browserNudge: Nudge = { ...folderNudge, target: { kind: "browser" } };

    it("asks whether to stop asking, in Spanish, with both choices and the X", () => {
      renderNudge(browserNudge, "es");
      expect(
        screen.getByText("Estás aprobando muchas acciones del navegador. ¿Quieres que deje de preguntar?"),
      ).toBeTruthy();
      expect(screen.getByRole("button", { name: "Permitir siempre" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Solo en esta sesión" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Descartar sugerencia" })).toBeTruthy();
    });

    it("forwards the chosen scope and dismisses with the X", () => {
      const handlers = renderNudge(browserNudge);
      fireEvent.click(screen.getByRole("button", { name: "Always allow" }));
      expect(handlers.onAllowBrowser).toHaveBeenLastCalledWith("always");
      fireEvent.click(screen.getByRole("button", { name: "Only this session" }));
      expect(handlers.onAllowBrowser).toHaveBeenLastCalledWith("session");
      fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
      expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
      expect(handlers.onAllow).not.toHaveBeenCalled();
      expect(handlers.onOpenSettings).not.toHaveBeenCalled();
    });

    it("waits for the native confirmation, then says what was allowed", () => {
      renderNudge({ ...browserNudge, status: "switching" });
      expect(screen.queryByRole("button", { name: "Only this session" })).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("Waiting for your confirmation");
      cleanup();
      renderNudge({ ...browserNudge, status: "allowed", scope: "always" }, "es");
      expect(screen.getByRole("status").textContent).toContain("El navegador ya no pregunta.");
      cleanup();
      renderNudge({ ...browserNudge, status: "allowed", scope: "session" }, "es");
      expect(screen.getByRole("status").textContent).toContain(
        "El navegador no preguntará hasta que cierres la aplicación.",
      );
    });
  });
});
