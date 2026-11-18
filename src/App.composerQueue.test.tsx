// @vitest-environment jsdom
// Composer queue (user feedback: "I can't type while the model runs"). The
// composer stays enabled while a reply streams; sending then queues the
// message for that conversation. When the turn ends the queue goes out in
// order, one message per turn. A user stop holds it (nothing goes out by
// itself; "Send now" releases it). A queued message wins over the
// automatic continuation of a cut reply. Each queued message can be edited
// (back into the composer) or removed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { ChatMessageRow, ConversationView } from "./types";

const SIGNED_IN = {
  profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
  active_profile: "nan",
};

function row(id: number, role: string, content: string, endReason: string | null = null, conv = 8): ChatMessageRow {
  return {
    id,
    conversation_id: conv,
    role,
    content,
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
    end_reason: endReason,
  };
}

let conversations: ConversationView[];
let rows: ChatMessageRow[];
let otherRows: ChatMessageRow[];
let failSend: boolean;

function handlers() {
  return {
    profiles_load: () => SIGNED_IN,
    conversation_list: () => conversations.map((c) => ({ ...c })),
    messages_list: (args: Record<string, unknown> | undefined) =>
      (Number(args?.conversationId) === 8 ? rows : otherRows).map((r) => ({ ...r })),
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    chat_send: () => {
      if (failSend) throw new Error("network");
      return undefined;
    },
    chat_stop: () => undefined,
    tts_stop: () => undefined,
  };
}

function renderApp(locale: "en" | "es" = "es") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

const sent = () => invokedWith("chat_send").map((args) => args?.content);
const composer = () => screen.getByRole("textbox", { name: "Mensaje" }) as HTMLTextAreaElement;
const queueRegion = () => screen.queryByRole("region", { name: "Mensajes en cola" });

async function type(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(composer(), { target: { value: text } });
  });
}

async function pressEnter(): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(composer(), { key: "Enter" });
  });
}

/** Open conversation 8 and start a reply (it streams until a done event). */
async function startStreaming(): Promise<void> {
  resetTauri(handlers());
  renderApp();
  await screen.findByText("hola");
  await type("primera");
  await pressEnter();
  await waitFor(() => expect(sent()).toEqual(["primera"]));
  await screen.findByRole("button", { name: "Detener" });
}

async function endTurn(reason: string, content = "Respuesta."): Promise<void> {
  rows = [...rows, row(100 + rows.length, "assistant", content, reason)];
  await act(async () => emit("chat://done", { conversation_id: 8, reason }));
}

beforeEach(() => {
  window.localStorage.clear();
  conversations = [{ id: 8, title: "Informe", updated_at: "", last_message: null }];
  rows = [row(1, "user", "hola")];
  otherRows = [];
  failSend = false;
});

afterEach(cleanup);

describe("composer queue while a reply runs", () => {
  it("keeps the composer usable and queues instead of sending", async () => {
    await startStreaming();
    expect(composer().disabled).toBe(false);

    await type("segunda");
    // Stop still works while the user types; the send button now queues.
    expect(screen.getByRole("button", { name: "Detener" })).toBeTruthy();
    const queueButton = screen.getByRole("button", { name: "Enviar cuando termine" });
    await act(async () => {
      fireEvent.click(queueButton);
    });
    await type("tercera");
    await pressEnter();

    expect(sent()).toEqual(["primera"]);
    expect(composer().value).toBe("");
    const region = queueRegion();
    expect(region).toBeTruthy();
    const items = within(region as HTMLElement).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector(".queued-text")?.textContent)).toEqual(["segunda", "tercera"]);
    expect(within(region as HTMLElement).getByText("Se enviarán en orden cuando termine la respuesta.")).toBeTruthy();

    // Stop keeps working with text in the composer.
    await type("borrador");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Detener" }));
    });
    expect(invokedWith("chat_stop")).toEqual([{ conversationId: 8 }]);
  });

  it("sends the queue in order, one message per turn", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    await type("tercera");
    await pressEnter();

    await endTurn("completed");
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda"]));
    // The next one waits for the reply to "segunda".
    expect(within(queueRegion() as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
    expect(within(queueRegion() as HTMLElement).getByText("Se enviará cuando termine la respuesta.")).toBeTruthy();

    await endTurn("tool_cap");
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda", "tercera"]));
    await waitFor(() => expect(queueRegion()).toBeNull());

    await endTurn("completed");
    expect(sent()).toHaveLength(3);
  });

  it("holds the queue after Stop and sends it only on request", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();

    rows = [...rows, row(150, "assistant", "Parado.", "user_stop")];
    await act(async () => emit("chat://stopped", { conversation_id: 8, reason: "user_stop" }));
    const region = await waitFor(() => {
      const r = queueRegion();
      if (!r) throw new Error("queue not shown");
      return r;
    });
    expect(within(region).getByText(/Has detenido la respuesta\./)).toBeTruthy();
    expect(sent()).toEqual(["primera"]);

    await act(async () => {
      fireEvent.click(within(region).getByRole("button", { name: "Enviar ahora" }));
    });
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda"]));
  });

  it("a new message releases a held queue and keeps the order", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    await act(async () => emit("chat://stopped", { conversation_id: 8, reason: "user_stop" }));
    await waitFor(() => expect(within(queueRegion() as HTMLElement).getByText(/Has detenido la respuesta\./)).toBeTruthy());

    await type("tercera");
    await pressEnter();
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda"]));
    await endTurn("completed");
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda", "tercera"]));
  });

  it("edits a queued message back into the composer, or removes it", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    await type("tercera");
    await pressEnter();

    const region = queueRegion() as HTMLElement;
    const [first, second] = within(region).getAllByRole("listitem");
    await act(async () => {
      fireEvent.click(within(first as HTMLElement).getByRole("button", { name: "Editar" }));
    });
    expect(composer().value).toBe("segunda");
    expect(document.activeElement).toBe(composer());
    await act(async () => {
      fireEvent.click(within(second as HTMLElement).getByRole("button", { name: "Quitar" }));
    });
    expect(queueRegion()).toBeNull();

    await endTurn("completed");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent()).toEqual(["primera"]);
  });

  it("describes each action with the message it applies to", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    const edit = within(queueRegion() as HTMLElement).getByRole("button", { name: "Editar" });
    const describedBy = edit.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe("segunda");
  });

  it("keeps the queue per conversation across switches", async () => {
    conversations = [
      { id: 8, title: "Informe", updated_at: "", last_message: null },
      { id: 5, title: "Notas", updated_at: "", last_message: null },
    ];
    otherRows = [row(60, "user", "apuntes", null, 5)];
    await startStreaming();
    await type("segunda");
    await pressEnter();

    const notes = Array.from(document.querySelectorAll<HTMLButtonElement>(".conv-main")).find(
      (b) => b.getAttribute("title") === "Notas",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(notes);
    });
    await screen.findByText("apuntes");
    expect(queueRegion()).toBeNull();

    // The turn ends while another chat is on screen: nothing is sent there.
    await endTurn("completed");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent()).toEqual(["primera"]);

    // Back to the chat: its queue goes out.
    const report = Array.from(document.querySelectorAll<HTMLButtonElement>(".conv-main")).find(
      (b) => b.getAttribute("title") === "Informe",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(report);
    });
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda"]));
    expect(invokedWith("chat_send")[1]?.conversationId).toBe(8);
  });

  it("holds the queue when the session expired, without a Send now that cannot work", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    await act(async () => emit("chat://error", { conversation_id: 8, kind: "unauthorized" }));
    await screen.findByText(/Tu sesión ha caducado/);
    const region = queueRegion() as HTMLElement;
    expect(within(region).getByText("segunda")).toBeTruthy();
    expect(within(region).getByText("No se ha podido enviar. Tu mensaje espera aquí.")).toBeTruthy();
    expect(within(region).queryByRole("button", { name: "Enviar ahora" })).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent()).toEqual(["primera"]);
  });

  it("holds the queue after any error and keeps the error on screen", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    await type("tercera");
    await pressEnter();
    await act(async () => emit("chat://error", { conversation_id: 8, kind: "network" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("No hemos podido conectar");
    const region = queueRegion() as HTMLElement;
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
    expect(within(region).getByText("No se ha podido enviar. Tus mensajes esperan aquí.")).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent()).toEqual(["primera"]);

    // Send now: the first goes out, the next waits for its reply.
    await act(async () => {
      fireEvent.click(within(region).getByRole("button", { name: "Enviar ahora" }));
    });
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda"]));
    await endTurn("completed");
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda", "tercera"]));
  });

  it("holds the queue after a busy interruption (sending now would fail the same way)", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    rows = [...rows, row(140, "assistant", "Mitad.", "interrupted")];
    await act(async () =>
      emit("chat://done", { conversation_id: 8, reason: "interrupted", error_kind: "rate_limited" }),
    );
    expect(await screen.findByText(/Hay mucha demanda ahora mismo\./)).toBeTruthy();
    const region = queueRegion() as HTMLElement;
    expect(within(region).getByRole("button", { name: "Enviar ahora" })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent()).toEqual(["primera"]);
  });

  it("Stop holds the queue even if the turn ends on its own first", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Detener" }));
    });
    // The reply finished just before the stop reached the core: no stopped event.
    await endTurn("completed");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent()).toEqual(["primera"]);
    expect(within(queueRegion() as HTMLElement).getByText(/Has detenido la respuesta\./)).toBeTruthy();
  });

  it("Send now puts the keyboard back in the composer", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    await act(async () => emit("chat://stopped", { conversation_id: 8, reason: "user_stop" }));
    const sendNow = await screen.findByRole("button", { name: "Enviar ahora" });
    sendNow.focus();
    await act(async () => {
      fireEvent.click(sendNow);
    });
    expect(document.activeElement).toBe(composer());
  });

  it("announces the first queued message through a live region that is always there", async () => {
    await startStreaming();
    const live = document.querySelector(".queued-live");
    expect(live?.getAttribute("role")).toBe("status");
    expect(live?.textContent).toBe("");
    await type("segunda");
    await pressEnter();
    expect(document.querySelector(".queued-live")).toBe(live);
    expect(live?.textContent).toBe("Se enviará cuando termine la respuesta.");
  });

  it("shows the full text of a long queued message on hover", async () => {
    await startStreaming();
    const long = "una pregunta muy larga ".repeat(10).trim();
    await type(long);
    await pressEnter();
    const text = (queueRegion() as HTMLElement).querySelector(".queued-text");
    expect(text?.getAttribute("title")).toBe(long);
  });

  it("puts a message that failed to send back, held", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();
    failSend = true;
    await endTurn("completed");
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda"]));
    const region = await waitFor(() => {
      const r = queueRegion();
      if (!r) throw new Error("queue not shown");
      return r;
    });
    expect(within(region).getByText("segunda")).toBeTruthy();
    expect(within(region).getByText("No se ha podido enviar. Tu mensaje espera aquí.")).toBeTruthy();
    expect(within(region).getByRole("button", { name: "Enviar ahora" })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent()).toHaveLength(2);
  });

  it("keeps image mode and skills unavailable while a reply runs", async () => {
    await startStreaming();
    expect((screen.getByRole("button", { name: "Crear imagen" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Usar skill" }) as HTMLButtonElement).disabled).toBe(true);
    // A leading "/" while busy is plain text: no picker opens.
    await type("/resumen");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("queue vs the automatic continuation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a queued message replaces the automatic continuation of a cut reply", async () => {
    await startStreaming();
    await type("segunda");
    await pressEnter();

    await endTurn("stream_cut", "Mitad.");
    await waitFor(() => expect(sent()).toEqual(["primera", "segunda"]));
    expect(screen.queryByText(/Retomando en un momento/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continuar" })).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(invokedWith("chat_send").filter((args) => args?.continuation === true)).toHaveLength(0);
  });
});

describe("queue lifetime", () => {
  it("is dropped on sign-out: signing in again starts with an empty queue", async () => {
    let signedIn = true;
    resetTauri({
      ...handlers(),
      profiles_load: () =>
        signedIn
          ? { ...SIGNED_IN, active_user: { email: "ana@example.com", realm: "realm-a" } }
          : {
              profiles: [{ id: "nan", name: "NaN", has_key: false, key_mask: null }],
              active_profile: null,
              active_user: null,
            },
      conversation_list: () => (signedIn ? conversations.map((c) => ({ ...c })) : []),
      device_login_start: () => undefined,
      device_logout: () => {
        signedIn = false;
      },
      skills_list: () => [],
    });
    renderApp("en");
    await screen.findByText("hola");
    const box = () => screen.getByRole("textbox", { name: "Message" });
    await act(async () => {
      fireEvent.change(box(), { target: { value: "primera" } });
    });
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    await screen.findByRole("button", { name: "Stop" });
    await act(async () => {
      fireEvent.change(box(), { target: { value: "segunda" } });
    });
    await act(async () => {
      fireEvent.keyDown(box(), { key: "Enter" });
    });
    expect(screen.getByRole("region", { name: "Queued messages" })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /Account menu/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await screen.findByText("Choose how to sign in:");

    fireEvent.click(await screen.findByRole("button", { name: /NaN/ }));
    await waitFor(() => expect(invokedWith("device_login_start").length).toBeGreaterThan(0));
    signedIn = true;
    await act(async () => {
      emit("device://approved", { key_alias: "desktop", profile_id: "nan", fresh_realm: false });
    });
    await screen.findByText("hola");
    expect(screen.queryByRole("region", { name: "Queued messages" })).toBeNull();
    expect(screen.queryByText("segunda")).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(sent()).toEqual(["primera"]);
  });
});
