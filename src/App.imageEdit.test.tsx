// @vitest-environment jsdom
// Image Studio over the mocked Tauri IPC. Editing lives in its own view:
// - entry points: the "Edit image" action on a chat image, a VISIBLE
//   "Edit image" button in the preview pane (app images and editable user
//   files), and the sidebar "Image Studio" entry (start from a picked file);
// - the Studio opens pre-loaded (canvas, locked base, history), focuses the
//   instruction, caps the references per edit model (2 extra on qwen, none
//   on FLUX, on both profiles), keeps Apply disabled while
//   empty or running, records the lineage and lets a node become the base;
// - Esc returns to the previous view; tool slots are visible but inert;
// - results still land in the chat with the "Edited" badge.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, invoke, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider } from "./i18n";
import type { Locale } from "./i18n/locale";
import type { ChatMessageRow } from "./types";

function signedIn(profile = "nan") {
  return {
    profiles: [{ id: profile, name: profile, has_key: true, key_mask: "sk-…abcd" }],
    active_profile: profile,
  };
}

function row(id: number, role: string, content: string, extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
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
    ...extra,
  };
}

let rows: ChatMessageRow[];
let picks: number;

function handlers(
  extra: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {},
  profile = "nan",
) {
  return {
    profiles_load: () => signedIn(profile),
    conversation_list: () => [{ id: 7, title: "Fox", updated_at: "", last_message: null }],
    conversation_create: () => 8,
    messages_list: () => rows,
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    chat_send: () => undefined,
    image_generate: () => undefined,
    edit_images: () => undefined,
    image_cancel: () => undefined,
    image_edit_pick: () => {
      picks += 1;
      return { path: `/data/images/staged/p${picks}.jpg`, name: `photo-${picks}.jpg` };
    },
    image_edit_stage: (args: Record<string, unknown> | undefined) => ({
      path: "/data/images/staged/s1.png",
      name: String(args?.path).split("/").pop(),
    }),
    preview_read_file: () => {
      throw "unavailable";
    },
    tts_stop: () => undefined,
    update_check: () => null,
    ...extra,
  };
}

function renderApp(locale: Locale = "en") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

const studio = () => screen.findByRole("region", { name: "Image Studio" });
const queryStudio = () => screen.queryByRole("region", { name: "Image Studio" });
const canvasImage = () => within(screen.getByRole("region", { name: "Canvas" })).getByRole("img");
const instructionBox = () => screen.getByRole("textbox", { name: "What should change?" }) as HTMLTextAreaElement;
const applyButton = () => screen.getByRole("button", { name: "Apply edit" }) as HTMLButtonElement;
const history = () => screen.getByRole("navigation", { name: "Edit history" });
const addReferenceButton = () => screen.queryByRole("button", { name: "Add reference" }) as HTMLButtonElement | null;

async function openStudioFromChat(): Promise<HTMLElement> {
  await screen.findByText("a red fox");
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  const view = await studio();
  await screen.findByRole("region", { name: "Canvas" });
  return view;
}

async function apply(): Promise<void> {
  await act(async () => {
    fireEvent.click(applyButton());
  });
}

async function addReference(n: number): Promise<void> {
  await act(async () => {
    fireEvent.click(addReferenceButton() as HTMLButtonElement);
  });
  await screen.findByRole("img", { name: `photo-${n}.jpg` });
}

beforeEach(() => {
  window.localStorage.clear();
  picks = 0;
  rows = [row(1, "user", "hola"), row(2, "assistant", "a red fox", { media_path: "/data/images/r.png" })];
});
afterEach(cleanup);

describe("entry points", () => {
  it("every chat image offers Edit next to Download, tool images too", async () => {
    rows.push(row(3, "assistant", "Here it is.", { artifacts: [{ path: "/data/images/t.png", kind: "image" }] }));
    resetTauri(handlers());
    renderApp();
    await screen.findByText("Here it is.");
    expect(screen.getAllByRole("button", { name: "Edit image" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Download image" })).toHaveLength(2);
  });

  it("Edit on a chat image opens the Studio pre-loaded instead of a composer mode", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    expect(canvasImage().getAttribute("alt")).toBe("Image being edited: a red fox");
    expect(canvasImage().getAttribute("src")).toBe("asset://localhost//data/images/r.png");
    // The base is pinned first in the tray, locked (no remove button).
    expect(screen.getByRole("img", { name: "Base image (locked): a red fox" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove reference/ })).toBeNull();
    expect(within(history()).getByRole("button", { name: "Original: a red fox" })).toBeTruthy();
    // The chat (and its composer) is not on screen; focus is on the instruction.
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(instructionBox()));
    expect(instructionBox().maxLength).toBe(2000);
    // A chat image can be downloaded from the Studio.
    expect(screen.getByRole("button", { name: "Download the current image" })).toBeTruthy();
  });

  it("the preview pane shows a visible Edit image button on an app image", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("a red fox");
    // A finished reply auto-opens its image in the preview pane.
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    const pane = await screen.findByRole("complementary", { name: "Preview" });
    const edit = within(pane).getByRole("button", { name: "Edit image" });
    expect(edit.textContent).toBe("Edit image");
    fireEvent.click(edit);
    await studio();
    expect(canvasImage().getAttribute("src")).toBe("asset://localhost//data/images/r.png");
    // Linked to its chat message: the edit is a child of row 2.
    fireEvent.change(instructionBox(), { target: { value: "snow" } });
    await apply();
    await waitFor(() => expect(invokedWith("edit_images")[0]?.parentMessageId).toBe(2));
  });

  it("the preview pane stages an editable user file before opening it", async () => {
    rows.push(
      row(3, "assistant", "Saved.", { artifacts: [{ path: "/Users/ana/Photos/cat.png", kind: "file" }] }),
    );
    resetTauri(handlers());
    renderApp();
    await screen.findByText("Saved.");
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    const pane = await screen.findByRole("complementary", { name: "Preview" });
    fireEvent.click(within(pane).getByRole("button", { name: "Edit image" }));
    await studio();
    await waitFor(() => expect(canvasImage().getAttribute("src")).toBe("asset://localhost//data/images/staged/s1.png"));
    expect(invokedWith("image_edit_stage")).toEqual([{ profileId: "nan", path: "/Users/ana/Photos/cat.png" }]);
    expect(canvasImage().getAttribute("alt")).toBe("Image being edited: cat.png");
    // A staged copy of the user's own file offers no download.
    expect(screen.queryByRole("button", { name: "Download the current image" })).toBeNull();
  });

  it("the preview pane offers no edit for files the editor cannot take", async () => {
    rows.push(row(3, "assistant", "Saved.", { artifacts: [{ path: "/Users/ana/Photos/anim.gif", kind: "file" }] }));
    resetTauri(handlers());
    renderApp();
    await screen.findByText("Saved.");
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    const pane = await screen.findByRole("complementary", { name: "Preview" });
    expect(within(pane).queryByRole("button", { name: "Edit image" })).toBeNull();
  });

  it("a refused staging explains why and lets the user choose another image", async () => {
    rows.push(row(3, "assistant", "Saved.", { artifacts: [{ path: "/Users/ana/Photos/cat.png", kind: "file" }] }));
    resetTauri(
      handlers({
        image_edit_stage: () => {
          throw "source_not_allowed";
        },
      }),
    );
    renderApp();
    await screen.findByText("Saved.");
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    const pane = await screen.findByRole("complementary", { name: "Preview" });
    fireEvent.click(within(pane).getByRole("button", { name: "Edit image" }));
    await studio();
    expect(
      await screen.findByText("Only images inside your working folders can be used. Add the folder in Settings first."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose image" })).toBeTruthy();
  });

  it("the sidebar entry starts from a picked file in a conversation of its own", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("a red fox");
    fireEvent.click(screen.getByRole("button", { name: "Image Studio" }));
    await studio();
    expect(screen.getByText("Start from an image")).toBeTruthy();
    expect(applyButton().disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
    });
    await waitFor(() => expect(canvasImage().getAttribute("alt")).toBe("Image being edited: photo-1.jpg"));
    expect(invokedWith("image_edit_pick")).toEqual([{ profileId: "nan" }]);

    fireEvent.change(instructionBox(), { target: { value: "add a hat" } });
    await apply();
    await waitFor(() =>
      expect(invokedWith("edit_images")).toEqual([
        {
          conversationId: 8,
          parentMessageId: null,
          instruction: "add a hat",
          sourcePaths: ["/data/images/staged/p1.jpg"],
        },
      ]),
    );
    expect(invokedWith("conversation_create")).toEqual([{ profileId: "nan" }]);
  });

  it("is offered on both profiles (desktop-only server-side on both tenants)", async () => {
    for (const profile of ["nan", "helmcode"]) {
      resetTauri(handlers({}, profile));
      renderApp();
      await screen.findByText("a red fox");
      expect(screen.getByRole("button", { name: "Edit image" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Image Studio" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Download image" })).toBeTruthy();
      cleanup();
    }
  });

  it("the enterprise preview pane offers Edit image too", async () => {
    resetTauri(handlers({}, "helmcode"));
    renderApp();
    await screen.findByText("a red fox");
    await act(async () => emit("chat://done", { conversation_id: 7 }));
    const pane = await screen.findByRole("complementary", { name: "Preview" });
    expect(within(pane).getByRole("button", { name: "Edit image" })).toBeTruthy();
  });
});

describe("the reference tray", () => {
  it("adds picked files through the core, caps at 2 extra and removes them", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    expect(screen.getByText("0 of 2 references")).toBeTruthy();
    await addReference(1);
    await addReference(2);
    expect(screen.getByText("2 of 2 references")).toBeTruthy();
    expect(addReferenceButton()).toBeNull();
    expect(invokedWith("image_edit_pick")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Remove reference photo-1.jpg" }));
    expect(screen.queryByRole("img", { name: "photo-1.jpg" })).toBeNull();
    expect(screen.getByRole("img", { name: "photo-2.jpg" })).toBeTruthy();
    expect(addReferenceButton()).toBeTruthy();
  });

  it("on the enterprise profile (FLUX) the base is the only image and the edit sends it alone", async () => {
    resetTauri(handlers({}, "helmcode"));
    renderApp();
    await openStudioFromChat();
    // The base is pre-loaded, locked; no reference slot, no counter.
    expect(screen.getByRole("img", { name: "Base image (locked): a red fox" })).toBeTruthy();
    expect(addReferenceButton()).toBeNull();
    expect(screen.queryByText(/references$/)).toBeNull();
    expect(screen.getByText("This editor works on the base image only.")).toBeTruthy();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await apply();
    await waitFor(() =>
      expect(invokedWith("edit_images")).toEqual([
        { conversationId: 7, parentMessageId: 2, instruction: "make it snowy", sourcePaths: ["/data/images/r.png"] },
      ]),
    );
  });

  it("a refused pick shows the grant message and leaves the tray as it was", async () => {
    resetTauri(
      handlers({
        image_edit_pick: () => {
          throw "source_not_allowed";
        },
      }),
    );
    renderApp();
    await openStudioFromChat();
    await act(async () => {
      fireEvent.click(addReferenceButton() as HTMLButtonElement);
    });
    expect(
      await screen.findByText("Only images inside your working folders can be used. Add the folder in Settings first."),
    ).toBeTruthy();
    expect(screen.getByText("0 of 2 references")).toBeTruthy();
  });
});

describe("submitting an edit", () => {
  it("Apply is disabled while the instruction is empty and while the edit runs", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    expect(applyButton().disabled).toBe(true);
    fireEvent.change(instructionBox(), { target: { value: "   " } });
    expect(applyButton().disabled).toBe(true);
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    expect(applyButton().disabled).toBe(false);
    expect(screen.getByText("13 / 2000")).toBeTruthy();

    await apply();
    await act(async () => emit("images://started", { conversation_id: 7 }));
    const running = screen.getByRole("button", { name: "Editing…" }) as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    // A second submit while running is ignored.
    fireEvent.keyDown(instructionBox(), { key: "Enter", metaKey: true });
    expect(invokedWith("edit_images")).toHaveLength(1);
    await act(async () => emit("images://progress", { conversation_id: 7, stage: "uploading" }));
    expect(screen.getAllByText("Sending the images…").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("Cmd/Ctrl + Enter submits; plain Enter does not", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    fireEvent.keyDown(instructionBox(), { key: "Enter" });
    expect(invokedWith("edit_images")).toHaveLength(0);
    await act(async () => {
      fireEvent.keyDown(instructionBox(), { key: "Enter", ctrlKey: true });
    });
    await waitFor(() => expect(invokedWith("edit_images")).toHaveLength(1));
  });

  it("sends base + references, records the lineage and lets a node become the base", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    await addReference(1);
    fireEvent.change(instructionBox(), { target: { value: "  make it snowy " } });
    await apply();
    await waitFor(() =>
      expect(invokedWith("edit_images")).toEqual([
        {
          conversationId: 7,
          parentMessageId: 2,
          instruction: "make it snowy",
          sourcePaths: ["/data/images/r.png", "/data/images/staged/p1.jpg"],
        },
      ]),
    );
    await act(async () => emit("images://started", { conversation_id: 7 }));
    rows = [
      ...rows,
      row(3, "assistant", "make it snowy", {
        model: "qwen-image-3.0-pro",
        media_path: "/data/images/e.png",
        parent_message_id: 2,
      }),
    ];
    await act(async () => emit("images://done", { conversation_id: 7, media_path: "/data/images/e.png" }));

    // The result is the new base, the history shows original → edit 1.
    await waitFor(() => expect(canvasImage().getAttribute("src")).toBe("asset://localhost//data/images/e.png"));
    const edit1 = within(history()).getByRole("button", { name: "Edit 1: make it snowy" });
    expect(edit1.getAttribute("aria-current")).toBe("true");
    expect(within(history()).getAllByRole("button")).toHaveLength(2);
    // The instruction clears; the staged reference stays for the next edit.
    expect(instructionBox().value).toBe("");
    expect(screen.getByRole("img", { name: "photo-1.jpg" })).toBeTruthy();

    // Chaining: the next edit is a child of the result, same reference.
    fireEvent.change(instructionBox(), { target: { value: "add a moon" } });
    await apply();
    await waitFor(() => expect(invokedWith("edit_images")[1]?.parentMessageId).toBe(3));
    expect(invokedWith("edit_images")[1]?.sourcePaths).toEqual(["/data/images/e.png", "/data/images/staged/p1.jpg"]);
    await act(async () => emit("images://stopped", { conversation_id: 7 }));

    // Clicking the original makes it the base again.
    fireEvent.click(within(history()).getByRole("button", { name: "Original: a red fox" }));
    expect(canvasImage().getAttribute("src")).toBe("asset://localhost//data/images/r.png");
    fireEvent.change(instructionBox(), { target: { value: "make it night" } });
    await apply();
    await waitFor(() => expect(invokedWith("edit_images")[2]?.parentMessageId).toBe(2));
  });

  it("a staged original stays reusable for the whole Studio session", async () => {
    resetTauri(handlers());
    renderApp();
    await screen.findByText("a red fox");
    fireEvent.click(screen.getByRole("button", { name: "Image Studio" }));
    await studio();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose image" }));
    });
    await waitFor(() => expect(canvasImage()).toBeTruthy());
    fireEvent.change(instructionBox(), { target: { value: "add a hat" } });
    await apply();
    await waitFor(() => expect(invokedWith("edit_images")).toHaveLength(1));
    rows = [...rows, row(9, "assistant", "add a hat", { conversation_id: 8, media_path: "/data/images/h.png" })];
    await act(async () => emit("images://done", { conversation_id: 8, media_path: "/data/images/h.png" }));
    await within(history()).findByRole("button", { name: "Edit 1: add a hat" });
    // The download offers the (app-owned) result.
    expect(screen.getByRole("button", { name: "Download the current image" })).toBeTruthy();
    // The staged original is still a live node: it becomes the base again
    // and is sent as the source of the next edit (the core keeps the copy).
    const original = within(history()).getByRole("button", { name: "Original: photo-1.jpg" }) as HTMLButtonElement;
    expect(original.disabled).toBe(false);
    fireEvent.click(original);
    expect(canvasImage().getAttribute("src")).toBe("asset://localhost//data/images/staged/p1.jpg");
    fireEvent.change(instructionBox(), { target: { value: "add a scarf" } });
    await apply();
    await waitFor(() =>
      expect(invokedWith("edit_images")[1]).toEqual({
        conversationId: 8,
        parentMessageId: null,
        instruction: "add a scarf",
        sourcePaths: ["/data/images/staged/p1.jpg"],
      }),
    );
  });

  it("a platform error shows in the Studio, not twice in the chat", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await apply();
    await waitFor(() => expect(invokedWith("edit_images")).toHaveLength(1));
    await act(async () => emit("images://started", { conversation_id: 7 }));
    await act(async () => emit("images://error", { conversation_id: 7, kind: "tier_restricted" }));
    expect(await screen.findByText("Your plan does not include image editing.")).toBeTruthy();
    expect(instructionBox().value).toBe("make it snowy");
    expect(applyButton().disabled).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    await screen.findByRole("textbox", { name: "Message" });
    expect(screen.queryByText("Your plan does not include image editing.")).toBeNull();
  });

  it("a local validation refusal keeps the instruction and the tray", async () => {
    resetTauri(
      handlers({
        edit_images: () => {
          throw "image_too_large";
        },
      }),
    );
    renderApp();
    await openStudioFromChat();
    await addReference(1);
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await apply();
    expect(await screen.findByText("That image is larger than 20 MB.")).toBeTruthy();
    expect(instructionBox().value).toBe("make it snowy");
    expect(screen.getByRole("img", { name: "photo-1.jpg" })).toBeTruthy();
    expect(applyButton().disabled).toBe(false);
  });

  it("the edited result still renders in the chat with its lineage", async () => {
    rows.push(row(3, "assistant", "make it snowy", { media_path: "/data/images/e.png", parent_message_id: 2 }));
    resetTauri(handlers());
    renderApp();
    const caption = await screen.findByText("make it snowy", { selector: ".image-caption" });
    const article = caption.closest("article") as HTMLElement;
    expect(within(article).getByText("Edited")).toBeTruthy();
    const original = document.getElementById("msg-2") as HTMLElement;
    const scroll = vi.fn();
    original.scrollIntoView = scroll;
    fireEvent.click(within(article).getByRole("button", { name: "View original" }));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("an edited result whose original is gone keeps the badge without a link", async () => {
    rows = [row(5, "assistant", "brighter", { media_path: "/data/images/x.png", parent_message_id: 99 })];
    resetTauri(handlers());
    renderApp();
    const caption = await screen.findByText("brighter", { selector: ".image-caption" });
    const article = caption.closest("article") as HTMLElement;
    expect(within(article).getByText("Edited")).toBeTruthy();
    expect(within(article).queryByRole("button", { name: "View original" })).toBeNull();
  });
});

describe("leaving and coming back", () => {
  it("Esc returns to the chat; the sidebar entry resumes the session", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(queryStudio()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Image Studio" }));
    await studio();
    expect(instructionBox().value).toBe("make it snowy");
    expect(canvasImage().getAttribute("src")).toBe("asset://localhost//data/images/r.png");
  });

  it("the Back button returns too, and an edit left running shows in the chat", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await apply();
    await act(async () => emit("images://started", { conversation_id: 7 }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Editing the image. It usually takes about a minute.")).toBeTruthy();
  });
});

describe("while a Studio edit runs", () => {
  const twoChats = () =>
    handlers({
      conversation_list: () => [
        { id: 7, title: "Fox", updated_at: "", last_message: null },
        { id: 9, title: "Other", updated_at: "", last_message: null },
      ],
    });
  const chatSwitch = (title: string) => screen.getByRole("button", { name: title });
  const newChatButton = () => screen.getByRole("button", { name: "New chat" });
  const blocked = "Wait for the image edit to finish before switching chats";

  it("pauses chat switches with a tooltip, keeps the Studio, and re-enables them after", async () => {
    resetTauri(twoChats());
    renderApp();
    await openStudioFromChat();
    expect(chatSwitch("Other").getAttribute("aria-disabled")).toBeNull();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await apply();
    await act(async () => emit("images://started", { conversation_id: 7 }));

    // The running chat's own entry reads "Fox Replying" (live indicator).
    const fox = screen.getByRole("button", { name: /^Fox\b/ });
    for (const button of [chatSwitch("Other"), fox, newChatButton()]) {
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(blocked);
    }
    const loads = invokedWith("messages_list").length;
    fireEvent.click(chatSwitch("Other"));
    fireEvent.click(newChatButton());
    // Nothing switched: the Studio is still the view, with its edit running.
    expect(queryStudio()).toBeTruthy();
    expect(screen.getByRole("button", { name: "Editing…" })).toBeTruthy();
    expect(invokedWith("messages_list")).toHaveLength(loads);

    // The error lands in the open Studio, and switching works again.
    await act(async () => emit("images://error", { conversation_id: 7, kind: "server" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(chatSwitch("Other").getAttribute("aria-disabled")).toBeNull();
    expect(chatSwitch("Other").getAttribute("title")).toBe("Other");
    fireEvent.click(chatSwitch("Other"));
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(queryStudio()).toBeNull();
  });

  it("disables deleting the conversation the edit writes to, and re-enables it after", async () => {
    resetTauri(twoChats());
    renderApp();
    await openStudioFromChat();
    const deleteFox = () => screen.getByRole("button", { name: 'Delete chat "Fox"' });
    expect(deleteFox().getAttribute("aria-disabled")).toBeNull();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await apply();
    await act(async () => emit("images://started", { conversation_id: 7 }));

    expect(deleteFox().getAttribute("aria-disabled")).toBe("true");
    expect(deleteFox().getAttribute("title")).toBe(blocked);
    // Clicking does nothing: it neither arms nor deletes.
    fireEvent.click(deleteFox());
    fireEvent.click(deleteFox());
    expect(screen.getByRole("button", { name: 'Delete chat "Fox"' })).toBeTruthy();
    expect(invokedWith("conversation_delete")).toHaveLength(0);
    // Another conversation stays deletable.
    expect(screen.getByRole("button", { name: 'Delete chat "Other"' }).getAttribute("aria-disabled")).toBeNull();

    rows = [...rows, row(3, "assistant", "make it snowy", { media_path: "/data/images/e.png", parent_message_id: 2 })];
    await act(async () => emit("images://done", { conversation_id: 7, media_path: "/data/images/e.png" }));
    await within(history()).findByRole("button", { name: "Edit 1: make it snowy" });
    expect(deleteFox().getAttribute("aria-disabled")).toBeNull();
    expect(deleteFox().getAttribute("title")).toBe("Delete");
  });

  it("an Edit action elsewhere resumes the running session instead of replacing it", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await apply();
    await act(async () => emit("images://started", { conversation_id: 7 }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("textbox", { name: "Message" });
    fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
    await studio();
    // Same session: the edit is still running and its instruction is kept.
    expect(screen.getByRole("button", { name: "Editing…" })).toBeTruthy();
    expect(instructionBox().value).toBe("make it snowy");
    rows = [...rows, row(3, "assistant", "make it snowy", { media_path: "/data/images/e.png", parent_message_id: 2 })];
    await act(async () => emit("images://done", { conversation_id: 7, media_path: "/data/images/e.png" }));
    await within(history()).findByRole("button", { name: "Edit 1: make it snowy" });
    expect(newChatButton().getAttribute("aria-disabled")).toBeNull();
  });
});

describe("toolbar", () => {
  it("tool slots are visible, labelled as coming soon, and do nothing", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    const toolbar = screen.getByRole("toolbar", { name: "Editing tools" });
    const brush = within(toolbar).getByRole("button", { name: "Mask brush: coming soon" });
    const region = within(toolbar).getByRole("button", { name: "Region select: coming soon" });
    for (const tool of [brush, region]) {
      expect(tool.getAttribute("aria-disabled")).toBe("true");
      expect(tool.getAttribute("title")).toMatch(/coming soon$/);
    }
    // The state is visible without hovering: a "Soon" chip sits next to the
    // inert tools (hidden from AT — each tool's name already says it).
    const chip = within(toolbar).getByText("Soon");
    expect(chip.classList.contains("studio-soon-chip")).toBe(true);
    expect(chip.getAttribute("aria-hidden")).toBe("true");
    expect(chip.tagName).toBe("SPAN");
    expect(brush.nextElementSibling).toBe(region);
    expect(region.nextElementSibling).toBe(chip);
    const before = invoke.mock.calls.length;
    const canvas = screen.getByRole("region", { name: "Canvas" }).outerHTML;
    fireEvent.click(brush);
    fireEvent.click(region);
    expect(invoke.mock.calls.length).toBe(before);
    expect(screen.getByRole("region", { name: "Canvas" }).outerHTML).toBe(canvas);
    expect(brush.getAttribute("aria-pressed")).toBeNull();
  });

  it("zoom switches between fit and actual size", async () => {
    resetTauri(handlers());
    renderApp();
    await openStudioFromChat();
    const fit = screen.getByRole("button", { name: "Fit to view" });
    const actual = screen.getByRole("button", { name: "Actual size" });
    expect(fit.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(actual);
    expect(actual.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("region", { name: "Canvas" }).classList.contains("actual")).toBe(true);
  });
});

describe("Spanish", () => {
  it("names the Studio in Spanish", async () => {
    resetTauri(handlers());
    renderApp("es");
    await screen.findByText("a red fox");
    expect(screen.getByRole("button", { name: "Estudio de imagen" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Editar imagen" }));
    await screen.findByRole("region", { name: "Estudio de imagen" });
    expect(screen.getByRole("textbox", { name: "¿Qué quieres cambiar?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Aplicar edición" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Añadir referencia" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Historial de ediciones" })).toBeTruthy();
    const toolbar = screen.getByRole("toolbar", { name: "Herramientas de edición" });
    expect(within(toolbar).getByText("Próximamente").getAttribute("aria-hidden")).toBe("true");
    expect(within(toolbar).getByRole("button", { name: "Pincel de máscara: muy pronto" })).toBeTruthy();
  });
});
