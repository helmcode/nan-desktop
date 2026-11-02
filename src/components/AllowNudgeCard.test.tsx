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
  const handlers = { onAllow: vi.fn(), onOpenSettings: vi.fn(), onDismiss: vi.fn() };
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

  it("points to Settings for whole-computer access (it can never be allow)", () => {
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
});
