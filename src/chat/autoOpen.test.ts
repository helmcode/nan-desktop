import { describe, expect, it } from "vitest";
import { lastProducedTarget } from "./autoOpen";
import type { ChatMessageRow } from "../types";

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

describe("lastProducedTarget (round 4 auto-open)", () => {
  it("opens the last artifact of the newest reply; later artifacts replace earlier ones", () => {
    expect(
      lastProducedTarget([
        row(1, "user"),
        row(2, "assistant", {
          artifacts: [
            { path: "/u/p/draft.md", kind: "file" },
            { path: "/u/p/report.pdf", kind: "file" },
          ],
        }),
      ]),
    ).toEqual({ kind: "file", ref: "/u/p/report.pdf" });
  });

  it("opens a generated image (tool artifact) as media", () => {
    expect(
      lastProducedTarget([row(1, "user"), row(2, "assistant", { artifacts: [{ path: "/d/images/a.png", kind: "image" }] })]),
    ).toEqual({ kind: "media", ref: "/d/images/a.png" });
  });

  it("opens the composer's image row (media_path) as media", () => {
    expect(lastProducedTarget([row(1, "assistant", { media_path: "/d/images/b.png" })])).toEqual({
      kind: "media",
      ref: "/d/images/b.png",
    });
  });

  it("only the reply that just finished counts: an older artifact never re-opens", () => {
    expect(
      lastProducedTarget([
        row(1, "assistant", { artifacts: [{ path: "/u/p/old.pdf", kind: "file" }] }),
        row(2, "user"),
        row(3, "assistant", { artifacts: [] }),
      ]),
    ).toBeNull();
  });

  it("nothing produced → null (pane stays as the user left it)", () => {
    expect(lastProducedTarget([])).toBeNull();
    expect(lastProducedTarget([row(1, "user")])).toBeNull();
    expect(lastProducedTarget([row(1, "assistant")])).toBeNull();
    expect(lastProducedTarget([row(1, "assistant", { artifacts: [{ path: "", kind: "file" }] })])).toBeNull();
  });
});
