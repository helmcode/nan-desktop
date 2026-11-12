import { describe, expect, it } from "vitest";
import { baseName, isScratchFile, lastProducedTarget, mentionsFile } from "./autoOpen";
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

describe("the final deliverable wins over intermediates (round 15/F5)", () => {
  const file = (path: string) => ({ path, kind: "file" as const });

  it("owner report: a PDF turn that left measure.js, debug.html and preview-p1.png opens the PDF", () => {
    const reply = row(2, "assistant", {
      content: "Listo. Tu documento está en `/u/p/informe.pdf`.",
      artifacts: [
        file("/u/p/measure.js"),
        file("/u/p/informe.pdf"),
        file("/u/p/debug.html"),
        file("/u/p/preview-p1.png"),
      ],
    });
    expect(lastProducedTarget([row(1, "user"), reply])).toEqual({ kind: "file", ref: "/u/p/informe.pdf" });
  });

  it("the file the final message names wins even when produced earlier than another real file", () => {
    const reply = row(2, "assistant", {
      content: "He creado [informe.pdf](informe.pdf) a partir de los datos.",
      artifacts: [file("/u/p/informe.pdf"), file("/u/p/datos-limpios.csv")],
    });
    expect(lastProducedTarget([reply])).toEqual({ kind: "file", ref: "/u/p/informe.pdf" });
  });

  it("with no mention, the last non-scratch artifact wins over a later scratch one", () => {
    const reply = row(2, "assistant", {
      content: "Hecho.",
      artifacts: [file("/u/p/report.docx"), file("/u/p/page-1.png"), file("/u/p/render.py")],
    });
    expect(lastProducedTarget([reply])).toEqual({ kind: "file", ref: "/u/p/report.docx" });
  });

  it("D2: a turn that produced exactly one file opens it even when it looks like scratch", () => {
    for (const path of ["/u/p/measure.js", "/u/p/test.html", "/u/p/debug.html", "/u/p/preview-p1.png", "/u/p/build.sh"]) {
      const reply = row(2, "assistant", { content: "Done.", artifacts: [file(path)] });
      expect(lastProducedTarget([reply])).toEqual({ kind: "file", ref: path });
    }
    // Rewritten several times, it is still one file.
    const rewritten = row(2, "assistant", {
      content: "Done.",
      artifacts: [file("/u/p/scrape.py"), file("/u/p/scrape.py")],
    });
    expect(lastProducedTarget([rewritten])).toEqual({ kind: "file", ref: "/u/p/scrape.py" });
  });

  it("D2: with two or more files a script is scratch again and a real file wins", () => {
    const reply = row(2, "assistant", {
      content: "Done.",
      artifacts: [file("/u/p/scrape.py"), file("/u/p/results.csv"), file("/u/p/scrape.py")],
    });
    expect(lastProducedTarget([reply])).toEqual({ kind: "file", ref: "/u/p/results.csv" });
  });

  it("pure intermediates never auto-open; a scratch-looking file opens only when the message names it", () => {
    const scratch = [file("/u/p/measure.js"), file("/u/p/preview-p2.png")];
    expect(lastProducedTarget([row(2, "assistant", { content: "Done.", artifacts: scratch })])).toBeNull();
    const asked = row(2, "assistant", { content: "Here is your script: /u/p/measure.js", artifacts: scratch });
    expect(lastProducedTarget([asked])).toEqual({ kind: "file", ref: "/u/p/measure.js" });
  });

  it("a generated image stays a media target", () => {
    const reply = row(2, "assistant", {
      content: "Aquí tienes la imagen.",
      artifacts: [{ path: "/d/images/3f2a.png", kind: "image" }],
    });
    expect(lastProducedTarget([reply])).toEqual({ kind: "media", ref: "/d/images/3f2a.png" });
  });
});

describe("scratch detection and mentions (round 15/F5)", () => {
  it.each([
    "/u/p/measure.js",
    "/u/p/debug.html",
    "/u/p/preview-p1.png",
    "/u/p/preview_p12.jpg",
    "/u/p/page-3.png",
    "/u/p/render.py",
    "/u/p/build.sh",
    "/u/p/check-layout.html",
    "/u/p/report-debug.html",
    "/u/p/.cache/x.pdf",
    "/u/p/_draft.md",
  ])("%s is scratch", (path) => {
    expect(isScratchFile(path)).toBe(true);
  });

  it.each(["/u/p/informe.pdf", "/u/p/report.docx", "/u/p/ventas.xlsx", "/u/tmp/notes.md", "/u/p/preview.pdf", "C:\\u\\informe.pdf"])(
    "%s is a deliverable",
    (path) => {
      expect(isScratchFile(path)).toBe(false);
    },
  );

  it("matches the full path or the file name as a whole token only", () => {
    expect(mentionsFile("Saved to /u/p/informe.pdf.", "/u/p/informe.pdf")).toBe(true);
    expect(mentionsFile("Abre informe.pdf para verlo", "/u/p/informe.pdf")).toBe(true);
    expect(mentionsFile("[Mi informe](Mi%20informe.pdf)", "/u/p/Mi informe.pdf")).toBe(true);
    expect(mentionsFile("old-informe.pdf is gone", "/u/p/informe.pdf")).toBe(false);
    expect(mentionsFile("informe.pdfx", "/u/p/informe.pdf")).toBe(false);
    expect(mentionsFile("", "/u/p/informe.pdf")).toBe(false);
    expect(mentionsFile("100% listo: informe.pdf", "/u/p/informe.pdf")).toBe(true);
  });

  it("baseName handles both separators", () => {
    expect(baseName("/a/b/c.pdf")).toBe("c.pdf");
    expect(baseName("C:\\a\\c.pdf")).toBe("c.pdf");
  });
});
