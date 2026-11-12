// @vitest-environment jsdom
// Round 15 (F6) + round 16: the single in-chat activity line while a turn runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emit, resetTauri } from "../test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import App from "../App";
import { I18nProvider, type Locale } from "../i18n";
import { en } from "../i18n/en";
import { es } from "../i18n/es";
import { activityLabel, elapsedSeconds, trackTurnStarts } from "./TurnIndicator";

describe("the turn clock", () => {
  it("counts whole seconds and never goes negative", () => {
    expect(elapsedSeconds(1_000, 1_999)).toBe(0);
    expect(elapsedSeconds(1_000, 13_500)).toBe(12);
    expect(elapsedSeconds(5_000, 1_000)).toBe(0);
  });

  it("keeps the start of a running turn, starts new ones and forgets finished ones", () => {
    const first = trackTurnStarts(new Map(), new Set([7]), () => 100);
    expect([...first]).toEqual([[7, 100]]);
    const second = trackTurnStarts(first, new Set([7, 9]), () => 500);
    expect([...second]).toEqual([
      [7, 100],
      [9, 500],
    ]);
    expect([...trackTurnStarts(second, new Set([9]), () => 900)]).toEqual([[9, 500]]);
  });

  it("formats the elapsed time in both languages", () => {
    expect(en.chat.turnElapsed(0)).toBe("0s");
    expect(en.chat.turnElapsed(59)).toBe("59s");
    expect(en.chat.turnElapsed(65)).toBe("1m 05s");
    expect(es.chat.turnElapsed(12)).toBe("12 s");
    expect(es.chat.turnElapsed(125)).toBe("2 min 05 s");
  });

  it("drops the trailing ellipsis: the animated dots carry it", () => {
    expect(activityLabel("Pensando…")).toBe("Pensando");
    expect(activityLabel("Thinking...")).toBe("Thinking");
    expect(activityLabel("Working")).toBe("Working");
  });
});

function handlers() {
  return {
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [{ id: 7, title: "Notes", updated_at: "", last_message: null }],
    messages_list: () => [],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    chat_send: () => undefined,
    chat_stop: () => undefined,
    tts_stop: () => undefined,
  };
}

function renderApp(locale: Locale = "en") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

async function send(text: string): Promise<void> {
  const box = await screen.findByRole("textbox", { name: /Message|Mensaje/ });
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
}

const indicator = () => screen.queryByTestId("turn-indicator");

beforeEach(() => {
  window.localStorage.clear();
  resetTauri(handlers());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the in-chat activity line (round 16: one indicator, under the last message)", () => {
  const elapsed = () => indicator()?.querySelector(".turn-elapsed")?.textContent;

  it("is absent when idle, appears in the chat flow on send, ticks with no chunks, and clears on done", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Notes"));
    expect(indicator()).toBeNull();
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "Date"] });
    await send("Build the report");
    const line = indicator();
    expect(line).not.toBeNull();
    // Inside the streaming bubble in the messages list, never in the composer.
    expect(line?.closest("article.streaming")).not.toBeNull();
    expect(line?.closest(".messages")).not.toBeNull();
    expect(line?.closest("footer.composer")).toBeNull();
    expect(line?.querySelector(".turn-indicator-label")?.textContent).toBe("Thinking");
    expect(elapsed()).toBe("· 0s");
    // A long tool call: nothing streams, the same line keeps counting.
    await act(async () => emit("chat://activity", { conversation_id: 7, activity: "working" }));
    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(screen.getAllByTestId("turn-indicator")).toHaveLength(1);
    expect(indicator()?.querySelector(".turn-indicator-label")?.textContent).toBe("Working");
    expect(elapsed()).toBe("· 12s");
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    expect(indicator()).toBeNull();
  });

  it("is accessible: a polite status whose ticking clock and dots are hidden from assistive tech", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Notes"));
    await send("Build the report");
    const line = indicator();
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.querySelector(".turn-dots")?.getAttribute("aria-hidden")).toBe("true");
    expect(line?.querySelector(".turn-elapsed")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("gives way to the caret while text streams, and comes back for the next tool phase", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Notes"));
    await send("Build the report");
    await act(async () => emit("chat://delta", { conversation_id: 7, delta: "Sure, " }));
    expect(indicator()).toBeNull();
    expect(document.querySelector("article.streaming .caret")).not.toBeNull();
    await act(async () => emit("chat://activity", { conversation_id: 7, activity: "searching" }));
    expect(screen.getAllByTestId("turn-indicator")).toHaveLength(1);
    expect(indicator()?.textContent).toContain("Searching the web");
  });

  it("clears on error and on stop", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Notes"));
    await send("First");
    expect(indicator()).not.toBeNull();
    await act(async () => emit("chat://error", { conversation_id: 7, kind: "network" }));
    expect(indicator()).toBeNull();
    await send("Second");
    expect(indicator()).not.toBeNull();
    await act(async () => emit("chat://stopped", { conversation_id: 7 }));
    expect(indicator()).toBeNull();
  });

  it("speaks Spanish and never shows two activity lines during a tool call", async () => {
    renderApp("es");
    fireEvent.click(await screen.findByText("Notes"));
    await send("Haz el informe");
    expect(indicator()?.querySelector(".turn-indicator-label")?.textContent).toBe("Pensando");
    expect(elapsed()).toBe("· 0 s");
    await act(async () => emit("chat://activity", { conversation_id: 7, activity: "working" }));
    expect(screen.getAllByText(/Trabajando/)).toHaveLength(1);
    expect(screen.queryByText(/Pensando/)).toBeNull();
    expect(screen.queryByText(/En curso/)).toBeNull();
    expect(document.querySelectorAll("p.activity")).toHaveLength(1);
  });
});
