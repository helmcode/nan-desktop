// @vitest-environment jsdom
// Image edits over the mocked Tauri IPC: the "Edit image" action on a chat
// image opens the composer in edit mode (reference tray + instruction), the
// tray is fed by that action and by the core's file picker, submit stays
// disabled while the tray or the instruction is empty and while the edit
// runs, and the result renders as an image row with an "Edited" badge and a
// link to its original.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { emit, invokedWith, resetTauri } from "./test/tauriMock";

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

const tray = () => screen.getByRole("group", { name: "Images to edit" });
const applyButton = () => screen.getByRole("button", { name: "Apply edit" }) as HTMLButtonElement;
const instructionBox = () => screen.getByRole("textbox", { name: "Edit instruction" }) as HTMLTextAreaElement;

async function openEditFromChat(): Promise<void> {
  await screen.findByText("a red fox");
  fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
  await screen.findByRole("group", { name: "Images to edit" });
}

beforeEach(() => {
  window.localStorage.clear();
  picks = 0;
  rows = [row(1, "user", "hola"), row(2, "assistant", "a red fox", { media_path: "/data/images/r.png" })];
});
afterEach(cleanup);

describe("Edit action opens the composer in edit mode", () => {
  it("every chat image offers Edit next to Download, tool images too", async () => {
    rows.push(row(3, "assistant", "Here it is.", { artifacts: [{ path: "/data/images/t.png", kind: "image" }] }));
    resetTauri(handlers());
    renderApp();
    await screen.findByText("Here it is.");
    expect(screen.getAllByRole("button", { name: "Edit image" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Download image" })).toHaveLength(2);
  });

  it("shows the image in the tray with the edit placeholder", async () => {
    resetTauri(handlers());
    renderApp();
    await openEditFromChat();
    const thumb = within(tray()).getByRole("img", { name: "a red fox" });
    expect(thumb.getAttribute("src")).toBe("asset://localhost//data/images/r.png");
    expect(instructionBox().getAttribute("placeholder")).toBe("Describe the edit…");
    expect(instructionBox().maxLength).toBe(2000);
    expect(instructionBox().closest(".composer-box")?.classList.contains("edit-mode")).toBe(true);
    expect(within(tray()).getByText("1 of 3")).toBeTruthy();
  });

  it("closing the tray returns to the normal composer", async () => {
    resetTauri(handlers());
    renderApp();
    await openEditFromChat();
    fireEvent.click(within(tray()).getByRole("button", { name: "Close edit" }));
    expect(screen.queryByRole("group", { name: "Images to edit" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });

  it("image mode and edit mode are exclusive", async () => {
    resetTauri(handlers());
    renderApp();
    await openEditFromChat();
    fireEvent.click(screen.getByRole("button", { name: "Create image" }));
    expect(screen.queryByRole("group", { name: "Images to edit" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Image description" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit image" }));
    expect(await screen.findByRole("group", { name: "Images to edit" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Image description" })).toBeNull();
  });

  it("is hidden for the enterprise profile (community-only surface)", async () => {
    resetTauri(handlers({}, "helmcode"));
    renderApp();
    await screen.findByText("a red fox");
    expect(screen.queryByRole("button", { name: "Edit image" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download image" })).toBeTruthy();
  });
});

describe("the reference tray", () => {
  it("adds picked files through the core and removes thumbnails", async () => {
    resetTauri(handlers());
    renderApp();
    await openEditFromChat();
    await act(async () => {
      fireEvent.click(within(tray()).getByRole("button", { name: "Add image" }));
    });
    expect(await within(tray()).findByRole("img", { name: "photo-1.jpg" })).toBeTruthy();
    expect(invokedWith("image_edit_pick")).toEqual([{ profileId: "nan" }]);
    expect(within(tray()).getByText("2 of 3")).toBeTruthy();

    fireEvent.click(within(tray()).getByRole("button", { name: "Remove image 1" }));
    expect(within(tray()).queryByRole("img", { name: "a red fox" })).toBeNull();
    expect(within(tray()).getByRole("img", { name: "photo-1.jpg" })).toBeTruthy();
  });

  it("stops at three images", async () => {
    resetTauri(handlers());
    renderApp();
    await openEditFromChat();
    const add = () => within(tray()).getByRole("button", { name: "Add image" }) as HTMLButtonElement;
    for (const n of [1, 2]) {
      await act(async () => {
        fireEvent.click(add());
      });
      await within(tray()).findByRole("img", { name: `photo-${n}.jpg` });
    }
    expect(within(tray()).getAllByRole("img")).toHaveLength(3);
    expect(add().disabled).toBe(true);
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
    await openEditFromChat();
    await act(async () => {
      fireEvent.click(within(tray()).getByRole("button", { name: "Add image" }));
    });
    expect(
      await screen.findByText(
        "Only images inside your working folders can be used. Add the folder in Settings first.",
      ),
    ).toBeTruthy();
    expect(within(tray()).getAllByRole("img")).toHaveLength(1);
  });
});

describe("submitting an edit", () => {
  it("is disabled while the tray or the instruction is empty", async () => {
    resetTauri(handlers());
    renderApp();
    await openEditFromChat();
    expect(applyButton().disabled).toBe(true);
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    expect(applyButton().disabled).toBe(false);
    fireEvent.click(within(tray()).getByRole("button", { name: "Remove image 1" }));
    expect(applyButton().disabled).toBe(true);
    fireEvent.change(instructionBox(), { target: { value: "   " } });
    expect(applyButton().disabled).toBe(true);
  });

  it("sends the tray to the core, then runs, then renders the edited result", async () => {
    resetTauri(handlers());
    renderApp();
    await openEditFromChat();
    await act(async () => {
      fireEvent.click(within(tray()).getByRole("button", { name: "Add image" }));
    });
    await within(tray()).findByRole("img", { name: "photo-1.jpg" });
    fireEvent.change(instructionBox(), { target: { value: "  make it snowy " } });
    await act(async () => {
      fireEvent.click(applyButton());
    });

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
    // Dispatched: the tray closes and the composer is busy until the end.
    expect(screen.queryByRole("group", { name: "Images to edit" })).toBeNull();
    await act(async () => emit("images://started", { conversation_id: 7 }));
    expect(screen.getByText("Editing the image. It usually takes about a minute.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();

    rows = [
      ...rows,
      row(3, "assistant", "make it snowy", {
        model: "qwen-image-3.0-pro",
        media_path: "/data/images/e.png",
        parent_message_id: 2,
      }),
    ];
    await act(async () => emit("images://done", { conversation_id: 7, media_path: "/data/images/e.png" }));

    const caption = await screen.findByText("make it snowy", { selector: ".image-caption" });
    const article = caption.closest("article") as HTMLElement;
    expect(within(article).getByText("Edited")).toBeTruthy();
    expect(within(article).getByRole("img", { name: "make it snowy" }).getAttribute("src")).toBe(
      "asset://localhost//data/images/e.png",
    );
    // The lineage link brings the original into view.
    const original = document.getElementById("msg-2") as HTMLElement;
    const scroll = vi.fn();
    original.scrollIntoView = scroll;
    fireEvent.click(within(article).getByRole("button", { name: "View original" }));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Editing the image. It usually takes about a minute.")).toBeNull();
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

  it("a plan without editing shows the tier message", async () => {
    resetTauri(handlers());
    renderApp();
    await openEditFromChat();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await act(async () => {
      fireEvent.click(applyButton());
    });
    await waitFor(() => expect(invokedWith("edit_images")).toHaveLength(1));
    await act(async () => emit("images://started", { conversation_id: 7 }));
    await act(async () => emit("images://error", { conversation_id: 7, kind: "tier_restricted" }));
    expect(await screen.findByText("Your plan does not include image editing.")).toBeTruthy();
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
    await openEditFromChat();
    fireEvent.change(instructionBox(), { target: { value: "make it snowy" } });
    await act(async () => {
      fireEvent.click(applyButton());
    });
    expect(await screen.findByText("That image is larger than 20 MB.")).toBeTruthy();
    expect(instructionBox().value).toBe("make it snowy");
    expect(within(tray()).getAllByRole("img")).toHaveLength(1);
    expect(applyButton().disabled).toBe(false);
  });
});

describe("Spanish", () => {
  it("names the edit surface in Spanish", async () => {
    resetTauri(handlers());
    renderApp("es");
    await screen.findByText("a red fox");
    fireEvent.click(screen.getByRole("button", { name: "Editar imagen" }));
    const group = await screen.findByRole("group", { name: "Imágenes para editar" });
    expect(within(group).getByRole("button", { name: "Añadir imagen" })).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Instrucción de edición" }).getAttribute("placeholder"),
    ).toBe("Describe el cambio…");
    expect(screen.getByRole("button", { name: "Aplicar edición" })).toBeTruthy();
  });
});
