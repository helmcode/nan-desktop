// R-V1: a video the reply created or changed is what opens in the pane,
// and its chip appears once even when the turn edited it twice.
import { describe, expect, it } from "vitest";
import { lastProducedTarget } from "../chat/autoOpen";
import { messageFiles } from "../chat/filePaths";
import type { ChatMessageRow } from "../types";

const ID = "0123456789abcdef0123456789abcdef";

function row(id: number, role: string, extra: Partial<ChatMessageRow> = {}): ChatMessageRow {
  return {
    id,
    conversation_id: 1,
    role,
    content: "x",
    model: null,
    created_at: "",
    partial: false,
    media_path: null,
    sources: [],
    ...extra,
  };
}

describe("videos in a reply", () => {
  it("open as the video target, ahead of the images that went into them", () => {
    expect(
      lastProducedTarget([
        row(1, "user", { content: "hazme un vídeo" }),
        row(2, "assistant", {
          artifacts: [
            { path: "/d/images/a.png", kind: "image" },
            { path: ID, kind: "video" },
            { path: "/d/images/b.png", kind: "image" },
          ],
        }),
      ]),
    ).toEqual({ kind: "video", ref: ID });
  });

  it("show one chip per project, never as a file chip", () => {
    const files = messageFiles("Listo", "any", [
      { path: ID, kind: "video" },
      { path: ID, kind: "video" },
    ]);
    expect(files.videos).toEqual([ID]);
    expect(files.chips).toEqual([]);
    expect(files.images).toEqual([]);
  });
});
