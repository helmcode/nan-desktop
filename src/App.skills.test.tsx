// @vitest-environment jsdom
// Local skills (T14/S1) over the mocked Tauri IPC: the Skills view (empty
// state, create, edit, delete), the composer's "Use skill" button and "/"
// picker, the "Using: ..." pill (on/off changes the NEXT chat_send), "Save as
// skill" preloading the chat's first message, and the size cap.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider, type Locale } from "./i18n";
import type { Skill, SkillInput } from "./skills/skills";
import type { ChatMessageRow } from "./types";

const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";

function row(id: number, role: string, content: string): ChatMessageRow {
  return {
    id,
    conversation_id: 7,
    role,
    content,
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
  };
}

function skill(id: string, title: string, description: string, instructions = `${title} steps`): Skill {
  return { id, name: "x", title, description, instructions, references: [], created_at: 1, updated_at: 1 };
}

/// Chat handlers plus an in-memory skills store behind the four commands.
function handlers(initial: Skill[], messages: ChatMessageRow[] = [row(1, "user", "Summarize my notes weekly")]) {
  let store = [...initial];
  let next = 0;
  return {
    profiles_load: () => ({
      profiles: [{ id: "nan", name: "NaN", has_key: true, key_mask: "sk-…abcd" }],
      active_profile: "nan",
    }),
    conversation_list: () => [{ id: 7, title: "Notes", updated_at: "", last_message: null }],
    messages_list: () => messages,
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    chat_send: () => undefined,
    skills_list: () => store,
    skills_create: (args: Record<string, unknown> | undefined) => {
      const input = args?.input as SkillInput;
      next += 1;
      const created = skill(`${"c".repeat(31)}${next}`, input.title.trim(), input.description.trim(), input.instructions);
      store = [created, ...store];
      return created;
    },
    skills_update: (args: Record<string, unknown> | undefined) => {
      const input = args?.input as SkillInput;
      const updated = skill(String(args?.id), input.title.trim(), input.description.trim(), input.instructions);
      store = store.map((s) => (s.id === updated.id ? updated : s));
      return updated;
    },
    skills_delete: (args: Record<string, unknown> | undefined) => {
      store = store.filter((s) => s.id !== args?.id);
      return undefined;
    },
  };
}

function renderApp(locale: Locale = "en") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

async function composer(): Promise<HTMLElement> {
  return screen.findByRole("textbox", { name: "Message" });
}

async function sendMessage(text: string): Promise<void> {
  const box = await composer();
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: "Enter" });
  });
}

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("The update button (round 14/S1)", () => {
  const newerVersion = () => ({ version: "0.2.3", current_version: "0.2.2" });

  it("lives in the account section while a newer version exists, even after the banner is dismissed", async () => {
    resetTauri({ ...handlers([]), update_check: newerVersion, update_install: () => undefined });
    renderApp();
    // The banner offers the update first; dismissing it must not hide it.
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    const update = await screen.findByRole("menuitem", { name: "Update" });
    await act(async () => {
      fireEvent.click(update);
    });
    expect(invokedWith("update_install")).toHaveLength(1);
  });

  it("is hidden on the latest version", async () => {
    resetTauri({ ...handlers([]), update_check: () => null });
    renderApp();
    await waitFor(() => expect(invokedWith("update_check").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Update" })).toBeNull();
  });

  it("is hidden while the updater cannot check", async () => {
    resetTauri({
      ...handlers([]),
      update_check: () => {
        throw new Error("no release feed");
      },
    });
    renderApp();
    await waitFor(() => expect(invokedWith("update_check").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Update" })).toBeNull();
  });
});

describe("Skills view", () => {
  it("is in the sidebar and shows an empty state with a way to create one", async () => {
    resetTauri(handlers([]));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
    expect(screen.getByText("You have no skills yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a skill" })).toBeTruthy();
  });

  it("creates a skill from the three fields; the user never sees frontmatter", async () => {
    resetTauri(handlers([]));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create a skill" }));
    expect(screen.queryByText(/name:|description:|---/)).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Weekly report" } });
    fireEvent.change(screen.getByRole("textbox", { name: "What it is for" }), {
      target: { value: "Writes the weekly report" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Use bullets." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    });
    expect(invokedWith("skills_create")).toEqual([
      {
        input: {
          title: "Weekly report",
          description: "Writes the weekly report",
          instructions: "Use bullets.",
          references: [],
        },
      },
    ]);
    expect(await screen.findByText("Weekly report")).toBeTruthy();
    expect(screen.getByText("Writes the weekly report")).toBeTruthy();
  });

  it("asks for the missing fields before saving", async () => {
    resetTauri(handlers([]));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create a skill" }));
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Give the skill a name.");
    expect(invokedWith("skills_create")).toEqual([]);
  });

  it("rejects 100 KiB of instructions without calling the core", async () => {
    resetTauri(handlers([]));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create a skill" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Big" } });
    fireEvent.change(screen.getByRole("textbox", { name: "What it is for" }), { target: { value: "Too big" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
      target: { value: "a".repeat(100 * 1024) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The instructions are too long (64 KB at most).");
    expect(invokedWith("skills_create")).toEqual([]);
  });

  it("shows the core's refusal when it rejects the bundle", async () => {
    const table = handlers([]);
    resetTauri({
      ...table,
      skills_create: () => {
        throw { code: "bundle_too_large" };
      },
    });
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create a skill" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "X" } });
    fireEvent.change(screen.getByRole("textbox", { name: "What it is for" }), { target: { value: "Y" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Z" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The skill is too large with its files (256 KB at most).",
    );
  });

  it("edits (regenerates) and deletes with a second click", async () => {
    resetTauri(handlers([skill(ID_A, "Tone", "Formal tone")]));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: 'Edit skill "Tone"' }));
    expect(await screen.findByRole("heading", { name: "Edit skill" })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Tone steps");
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Tone v2" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    });
    expect(invokedWith("skills_update")).toEqual([
      { id: ID_A, input: { title: "Tone v2", description: "Formal tone", instructions: "Tone steps", references: [] } },
    ]);
    expect(await screen.findByText("Tone v2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: 'Delete skill "Tone v2"' }));
    expect(invokedWith("skills_delete")).toEqual([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: 'Click again to delete "Tone v2" forever' }));
    });
    expect(invokedWith("skills_delete")).toEqual([{ id: ID_A }]);
    expect(await screen.findByText("You have no skills yet")).toBeTruthy();
  });

  it("is translated to Spanish", async () => {
    resetTauri(handlers([]));
    renderApp("es");
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    expect(await screen.findByText("Todavía no tienes skills")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Crear una skill" }));
    expect(screen.getByRole("textbox", { name: "Para qué sirve" })).toBeTruthy();
  });
});

describe("Using a skill in the chat", () => {
  it("the Use skill button lists the skills; picking one shows the pill and sends its id", async () => {
    resetTauri(handlers([skill(ID_A, "Tone", "Formal tone"), skill(ID_B, "Report", "Weekly report")]));
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    fireEvent.click(screen.getByRole("button", { name: "Use skill" }));
    const list = await screen.findByRole("listbox", { name: "Your skills" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "ToneFormal tone",
      "ReportWeekly report",
    ]);
    fireEvent.click(within(list).getByText("Report"));
    expect(await screen.findByText("Using: Report")).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();

    await sendMessage("go");
    await waitFor(() =>
      expect(invokedWith("chat_send")).toEqual([
        { conversationId: 7, model: "deepseek-v4-flash", content: "go", grantIds: [], skillId: ID_B },
      ]),
    );
  });

  it("turning the pill off removes the skill from the NEXT message", async () => {
    resetTauri(handlers([skill(ID_A, "Tone", "Formal tone")]));
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    fireEvent.click(screen.getByRole("button", { name: "Use skill" }));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("Tone"));
    await sendMessage("first");
    await waitFor(() => expect(invokedWith("chat_send")[0]?.skillId).toBe(ID_A));
    // The mock never streams a reply; finish the turn so the composer is
    // enabled again for the second message.
    await act(async () => emit("chat://done", { conversation_id: 7 }));

    fireEvent.click(screen.getByRole("button", { name: "Stop using Tone" }));
    expect(screen.queryByText("Using: Tone")).toBeNull();
    await sendMessage("second");
    await waitFor(() => expect(invokedWith("chat_send")).toHaveLength(2));
    expect(invokedWith("chat_send")[1]).toEqual({
      conversationId: 7,
      model: "deepseek-v4-flash",
      content: "second",
      grantIds: [],
    });
    expect(invokedWith("chat_send")[1]).not.toHaveProperty("skillId");
  });

  it("typing / opens the picker, filters it and Enter picks without sending", async () => {
    resetTauri(handlers([skill(ID_A, "Tone", "Formal tone"), skill(ID_B, "Revisión", "Code review")]));
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    const box = await composer();
    fireEvent.change(box, { target: { value: "/" } });
    const list = await screen.findByRole("listbox", { name: "Your skills" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    fireEvent.change(box, { target: { value: "/revision" } });
    await waitFor(() => expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1));
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(await screen.findByText("Using: Revisión")).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("");
    expect(invokedWith("chat_send")).toEqual([]);
  });

  it("arrow keys move the highlight and Escape closes the / picker", async () => {
    resetTauri(handlers([skill(ID_A, "Tone", "Formal tone"), skill(ID_B, "Report", "Weekly report")]));
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    const box = await composer();
    fireEvent.change(box, { target: { value: "/" } });
    const options = within(await screen.findByRole("listbox")).getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    await waitFor(() =>
      expect(within(screen.getByRole("listbox")).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true"),
    );
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.queryByText(/Using:/)).toBeNull();
  });

  it("a / with no skills offers to create one", async () => {
    resetTauri(handlers([]));
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    fireEvent.change(await composer(), { target: { value: "/" } });
    expect(await screen.findByText("You have no skills yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create a skill" }));
    expect(await screen.findByRole("heading", { name: "New skill" })).toBeTruthy();
  });

  it("Use in chat from the list turns it on and returns to the chat", async () => {
    resetTauri(handlers([skill(ID_A, "Tone", "Formal tone")]));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: 'Use "Tone" in the chat' }));
    expect(await screen.findByText("Using: Tone")).toBeTruthy();
    expect(await composer()).toBeTruthy();
  });

  it("a skill deleted elsewhere is turned off and nothing is sent twice", async () => {
    const table = handlers([skill(ID_A, "Tone", "Formal tone")]);
    resetTauri({
      ...table,
      chat_send: () => {
        throw "skill:NotFound";
      },
    });
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    fireEvent.click(screen.getByRole("button", { name: "Use skill" }));
    fireEvent.click(within(await screen.findByRole("listbox")).getByText("Tone"));
    await sendMessage("hello");
    expect(
      await screen.findByText("The skill in use no longer exists, so it was turned off. Send the message again."),
    ).toBeTruthy();
    expect(screen.queryByText("Using: Tone")).toBeNull();
    expect(((await composer()) as HTMLTextAreaElement).value).toBe("hello");
  });
});

describe("Save as skill", () => {
  it("preloads the chat's first user message for review before saving", async () => {
    resetTauri(
      handlers(
        [],
        [row(1, "assistant", "Hi"), row(2, "user", "Summarize my notes weekly"), row(3, "user", "later")],
      ),
    );
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    fireEvent.click(screen.getByRole("button", { name: "Save as skill" }));
    expect(await screen.findByRole("heading", { name: "New skill" })).toBeTruthy();
    expect(screen.getByText("We copied the start of this chat. Review the text before saving.")).toBeTruthy();
    const instructions = screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement;
    expect(instructions.value).toBe("Summarize my notes weekly");
    expect(invokedWith("skills_create")).toEqual([]);

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Weekly" } });
    fireEvent.change(screen.getByRole("textbox", { name: "What it is for" }), { target: { value: "Weekly notes" } });
    fireEvent.change(instructions, { target: { value: "Summarize my notes weekly, in bullets." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save skill" }));
    });
    expect(invokedWith("skills_create")[0]).toEqual({
      input: {
        title: "Weekly",
        description: "Weekly notes",
        instructions: "Summarize my notes weekly, in bullets.",
        references: [],
      },
    });
  });

  it("is not offered on an empty chat", async () => {
    resetTauri({ ...handlers([], []), conversation_list: () => [] });
    renderApp();
    await composer();
    expect(screen.queryByRole("button", { name: "Save as skill" })).toBeNull();
  });
});
