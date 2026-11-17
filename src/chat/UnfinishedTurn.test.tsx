// @vitest-environment jsdom
// Turn continuity: a reply whose turn ended before the work was done
// (tool_cap, stream_cut, length) shows a calm notice with a plain reason and
// a "Continue" button. Finished or user-stopped replies show nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { es } from "../i18n/es";
import { isContinuable, shouldAutoRetry, UnfinishedTurn } from "./UnfinishedTurn";

afterEach(cleanup);

describe("isContinuable", () => {
  it("is true only for work left unfinished by something other than the user", () => {
    expect(isContinuable("tool_cap")).toBe(true);
    expect(isContinuable("stream_cut")).toBe(true);
    expect(isContinuable("length")).toBe(true);
    expect(isContinuable("completed")).toBe(false);
    expect(isContinuable("user_stop")).toBe(false);
    expect(isContinuable("error")).toBe(false);
    expect(isContinuable(null)).toBe(false);
    expect(isContinuable(undefined)).toBe(false);
    expect(isContinuable("something_new")).toBe(false);
  });
});

describe("shouldAutoRetry", () => {
  it("resumes a cut or too-long reply once, never the step cap", () => {
    expect(shouldAutoRetry("stream_cut", false)).toBe(true);
    expect(shouldAutoRetry("length", false)).toBe(true);
    expect(shouldAutoRetry("tool_cap", false)).toBe(false);
    expect(shouldAutoRetry("completed", false)).toBe(false);
    expect(shouldAutoRetry("user_stop", false)).toBe(false);
    expect(shouldAutoRetry(undefined, false)).toBe(false);
  });

  it("never resumes the automatic continuation itself (no loop)", () => {
    expect(shouldAutoRetry("stream_cut", true)).toBe(false);
    expect(shouldAutoRetry("length", true)).toBe(false);
  });
});

describe("UnfinishedTurn", () => {
  it("while resuming by itself, says so and offers Cancel instead of Continue", () => {
    const onCancel = vi.fn();
    render(
      <I18nProvider initial="es">
        <UnfinishedTurn reason="stream_cut" onContinue={() => {}} autoRetrying onCancelAutoRetry={onCancel} />
      </I18nProvider>,
    );
    const status = screen.getByRole("status");
    expect(status.textContent).toContain(es.chat.autoRetrying.stream_cut);
    expect(screen.queryByRole("button", { name: "Continuar" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("never shows the resuming line for the step cap", () => {
    render(
      <I18nProvider initial="en">
        <UnfinishedTurn reason="tool_cap" onContinue={() => {}} autoRetrying onCancelAutoRetry={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("says it stopped, why, and continues on click", () => {
    const onContinue = vi.fn();
    render(
      <I18nProvider initial="es">
        <UnfinishedTurn reason="tool_cap" onContinue={onContinue} />
      </I18nProvider>,
    );
    const note = screen.getByRole("status");
    expect(note.textContent).toContain("Me he detenido antes de terminar.");
    expect(note.textContent).toContain(es.chat.unfinishedReason.tool_cap);
    const button = screen.getByRole("button", { name: "Continuar" });
    // The notice is announced (status) and describes the button.
    const text = note.querySelector("p") as HTMLParagraphElement;
    expect(button.getAttribute("aria-describedby")).toBe(text.id);
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("gives each reason its own plain-language line", () => {
    for (const reason of ["tool_cap", "stream_cut", "length"] as const) {
      render(
        <I18nProvider initial="en">
          <UnfinishedTurn reason={reason} onContinue={() => {}} />
        </I18nProvider>,
      );
      expect(screen.getByRole("status").textContent).toContain(en.chat.unfinishedReason[reason]);
      cleanup();
    }
  });

  it("is a native button, so Enter and Space work from the keyboard", () => {
    render(
      <I18nProvider initial="en">
        <UnfinishedTurn reason="length" onContinue={() => {}} />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("can be disabled while another reply is running", () => {
    const onContinue = vi.fn();
    render(
      <I18nProvider initial="en">
        <UnfinishedTurn reason="stream_cut" onContinue={onContinue} disabled />
      </I18nProvider>,
    );
    const button = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("renders nothing for finished or stopped turns", () => {
    for (const reason of ["completed", "user_stop", null]) {
      const { container } = render(
        <I18nProvider initial="en">
          <UnfinishedTurn reason={reason} onContinue={() => {}} />
        </I18nProvider>,
      );
      expect(container.textContent).toBe("");
      cleanup();
    }
  });

  it("uses plain words, no technical terms", () => {
    const copy = [
      es.chat.unfinished,
      ...Object.values(es.chat.unfinishedReason),
      ...Object.values(es.chat.autoRetrying),
      es.chat.continueTurn,
      es.chat.continuePrompt,
      es.chat.cancelAutoRetry,
    ];
    for (const line of copy) {
      expect(line).not.toMatch(/token|stream|tool|cap|length|error|API|ronda/i);
    }
  });
});
