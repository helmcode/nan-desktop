// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { ApprovalCardState } from "../chat/approvals";
import { ApprovalCard } from "./ApprovalCard";

afterEach(cleanup);

const base: ApprovalCardState = {
  id: "act-1",
  conversationId: 1,
  action: "delete",
  target: "/Users/ana/Proyecto/old.txt",
  destination: null,
  anchorIndex: 1,
  status: "pending",
  failed: false,
};

function renderCard(card: Partial<ApprovalCardState> = {}, onRespond = vi.fn()) {
  render(
    <I18nProvider initial="en">
      <ApprovalCard card={{ ...base, ...card }} onRespond={onRespond} />
    </I18nProvider>,
  );
  return onRespond;
}

describe("ApprovalCard (S14)", () => {
  it("shows the action summary, target and both choices while pending", () => {
    renderCard();
    expect(screen.getByText("Delete a file")).toBeTruthy();
    expect(screen.getByText(base.target)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("forwards Allow and Deny with the pending-action id", () => {
    const onRespond = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onRespond.mock.calls).toEqual([
      ["act-1", true],
      ["act-1", false],
    ]);
  });

  it("shows the destination of a move", () => {
    renderCard({ action: "move", destination: "/Users/ana/Proyecto/new.txt" });
    expect(screen.getByText("Move a file")).toBeTruthy();
    expect(screen.getByText("/Users/ana/Proyecto/new.txt")).toBeTruthy();
  });

  it("hides the buttons while the answer is being sent", () => {
    renderCard({ status: "sending" });
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByText("Sending…")).toBeTruthy();
  });

  it("shows a retryable error when sending failed", () => {
    renderCard({ failed: true });
    expect(screen.getByRole("alert").textContent).toContain("Could not send");
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  it("collapses to a one-line outcome once resolved", () => {
    renderCard({ status: "denied" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Denied: Delete a file");
  });

  it("labels unknown actions generically and in Spanish", () => {
    render(
      <I18nProvider initial="es">
        <ApprovalCard card={{ ...base, action: "teleport" }} onRespond={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByText("Usar tus archivos")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permitir" })).toBeTruthy();
  });
});
