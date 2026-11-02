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
  action: "delete_path",
  target: "/Users/ana/Proyecto/old.txt",
  destination: null,
  cwd: null,
  diffPreview: null,
  permanent: false,
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
    renderCard({ action: "move_path", destination: "/Users/ana/Proyecto/new.txt" });
    expect(screen.getByText("Move a file")).toBeTruthy();
    expect(screen.getByText("/Users/ana/Proyecto/new.txt")).toBeTruthy();
  });

  it("labels every core action kind", () => {
    for (const [action, label] of [
      ["read_file", "Read a file"],
      ["list_files", "List a folder"],
      ["write_file", "Write a file"],
      ["replace_file", "Change a file"],
      ["run_command", "Run a command"],
    ]) {
      cleanup();
      renderCard({ action });
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows the command folder, the permanent-delete warning and the diff", () => {
    renderCard({ action: "run_command", target: "ls", cwd: "/Users/ana/Proyecto" });
    expect(screen.getByText("/Users/ana/Proyecto")).toBeTruthy();
    cleanup();
    renderCard({ permanent: true });
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    cleanup();
    renderCard({ action: "write_file", diffPreview: "+new line" });
    expect(screen.getByText("See the changes")).toBeTruthy();
    expect(screen.getByText("+new line")).toBeTruthy();
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
