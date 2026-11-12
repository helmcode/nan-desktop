// @vitest-environment jsdom
// Round 15 (F6): the composer's "In progress" line while a turn runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emit, resetTauri } from "../test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import App from "../App";
import { I18nProvider, type Locale } from "../i18n";
import { en } from "../i18n/en";
import { es } from "../i18n/es";
import { elapsedSeconds, trackTurnStarts } from "./TurnIndicator";

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
    expect(es.chat.turnWorking).toBe("En curso");
    expect(en.chat.turnWorking).toBe("In progress");
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

describe("the Working indicator in the composer", () => {
  it("is absent when idle, appears on send, ticks with no stream chunks, and clears on done", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Notes"));
    expect(indicator()).toBeNull();
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "Date"] });
    await send("Build the report");
    const line = indicator();
    expect(line).not.toBeNull();
    expect(line?.closest("footer.composer")).not.toBeNull();
    expect(line?.textContent).toContain("In progress");
    expect(line?.querySelector(".turn-elapsed")?.textContent).toBe("0s");
    // A long tool call: nothing streams, the clock still moves.
    await act(async () => {
      vi.advanceTimersByTime(12_000);
    });
    expect(indicator()?.querySelector(".turn-elapsed")?.textContent).toBe("12s");
    expect(indicator()?.querySelector(".turn-dots")?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    expect(indicator()).toBeNull();
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

  it("speaks Spanish", async () => {
    renderApp("es");
    fireEvent.click(await screen.findByText("Notes"));
    await send("Hola");
    expect(indicator()?.textContent).toContain("En curso");
    expect(indicator()?.querySelector(".turn-elapsed")?.textContent).toBe("0 s");
  });

  it("never reads like the bubble's working line during a tool call (round 15 D5)", async () => {
    renderApp("es");
    fireEvent.click(await screen.findByText("Notes"));
    await send("Haz el informe");
    await act(async () => emit("chat://activity", { conversation_id: 7, activity: "working" }));
    // The streaming bubble says what the assistant does; the composer only
    // says the turn is still running and for how long.
    expect(screen.getAllByText(/Trabajando/)).toHaveLength(1);
    expect(screen.getByText("Trabajando…").closest("article.streaming")).not.toBeNull();
    expect(indicator()?.textContent).not.toContain("Trabajando");
    expect(indicator()?.textContent).toContain("En curso");
  });
});
