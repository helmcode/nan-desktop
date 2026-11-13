import { describe, expect, it } from "vitest";
import { baseName, isScratchFile, lastProducedTarget, mentionsFile, requestedExtensions, type DeclaredOutput } from "./autoOpen";
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

describe("page renders and the kind the user asked for (round 16)", () => {
  const file = (path: string) => ({ path, kind: "file" as const });
  const ownerTurn = [
    "gs.html",
    "home.html",
    "docs.html",
    "fonts.css",
    "nan-builders.html",
    "NaN-builders.pdf",
    ...Array.from({ length: 9 }, (_, i) => `p${i + 1}.png`),
    "probe.html",
  ].map((name) => file(`/u/nan/${name}`));

  it("owner case: p1..p9.png and probe.html never win over the requested PDF", () => {
    const rows = [
      row(1, "user", { content: "Genera un PDF con la web de nan.builders" }),
      row(2, "assistant", { content: "Listo, ya lo tienes.", artifacts: ownerTurn }),
    ];
    expect(lastProducedTarget(rows)).toEqual({ kind: "file", ref: "/u/nan/NaN-builders.pdf" });
  });

  it("owner case with the PDF NOT last among real files: the asked kind still wins", () => {
    const shuffled = [file("/u/nan/NaN-builders.pdf"), ...ownerTurn.filter((a) => !a.path.endsWith(".pdf"))];
    const rows = [
      row(1, "user", { content: "Make me a pdf of the landing" }),
      row(2, "assistant", { content: "Done.", artifacts: shuffled }),
    ];
    expect(lastProducedTarget(rows)).toEqual({ kind: "file", ref: "/u/nan/NaN-builders.pdf" });
  });

  it("Spanish keywords pick the asked kind over a later real file", () => {
    const artifacts = [file("/u/p/ventas.xlsx"), file("/u/p/resumen.md")];
    const asked = (content: string) =>
      lastProducedTarget([row(1, "user", { content }), row(2, "assistant", { content: "Hecho.", artifacts })]);
    expect(asked("Prepárame una hoja de cálculo con las ventas")).toEqual({ kind: "file", ref: "/u/p/ventas.xlsx" });
    expect(asked("Pásalo a Excel")).toEqual({ kind: "file", ref: "/u/p/ventas.xlsx" });
    const deck = [file("/u/p/charla.pptx"), file("/u/p/notas.md")];
    expect(
      lastProducedTarget([
        row(1, "user", { content: "Hazme unas diapositivas para la presentación" }),
        row(2, "assistant", { content: "Hecho.", artifacts: deck }),
      ]),
    ).toEqual({ kind: "file", ref: "/u/p/charla.pptx" });
  });

  it("no keyword: falls back to the last non-scratch artifact", () => {
    const rows = [
      row(1, "user", { content: "Hazlo" }),
      row(2, "assistant", { content: "Hecho.", artifacts: [file("/u/p/a.pdf"), file("/u/p/b.md"), file("/u/p/p3.png")] }),
    ];
    expect(lastProducedTarget(rows)).toEqual({ kind: "file", ref: "/u/p/b.md" });
  });

  it("a file the final message names still beats the asked kind", () => {
    const rows = [
      row(1, "user", { content: "Quiero un PDF" }),
      row(2, "assistant", {
        content: "He dejado el borrador en borrador.docx",
        artifacts: [file("/u/p/informe.pdf"), file("/u/p/borrador.docx")],
      }),
    ];
    expect(lastProducedTarget(rows)).toEqual({ kind: "file", ref: "/u/p/borrador.docx" });
  });

  it("the asked kind never reaches scratch: a requested PNG ignores page renders", () => {
    const rows = [
      row(1, "user", { content: "Dame una imagen del logo" }),
      row(2, "assistant", { content: "Ok.", artifacts: [file("/u/p/logo.png"), file("/u/p/p1.png"), file("/u/p/notes.md")] }),
    ];
    expect(lastProducedTarget(rows)).toEqual({ kind: "file", ref: "/u/p/logo.png" });
  });

  it("only the user message of THIS turn counts", () => {
    const rows = [
      row(1, "user", { content: "Hazme un PDF" }),
      row(2, "assistant", { content: "Ok.", artifacts: [] }),
      row(3, "user", { content: "Ahora otra cosa" }),
      row(4, "assistant", { content: "Ok.", artifacts: [file("/u/p/x.pdf"), file("/u/p/y.md")] }),
    ];
    expect(lastProducedTarget(rows)).toEqual({ kind: "file", ref: "/u/p/y.md" });
  });

  it.each(["/u/p/p1.png", "/u/p/p9.png", "/u/p/p12.jpg", "/u/p/P3.PNG", "/u/p/pg2.svg", "/u/p/page4.html", "/u/p/slide-2.png", "/u/p/probe.html", "/u/p/probe-fonts.html", "/u/p/layout-probe.html", "/u/p/fonts.css"])(
    "%s is scratch",
    (path) => {
      expect(isScratchFile(path)).toBe(true);
    },
  );

  it.each(["/u/p/NaN-builders.pdf", "/u/p/nan-builders.html", "/u/p/plan.png", "/u/p/p1-report.pdf", "/u/p/gs.html"])(
    "%s is not scratch",
    (path) => {
      expect(isScratchFile(path)).toBe(false);
    },
  );

  it("maps Spanish and English keywords to extension groups, specific before generic", () => {
    expect(requestedExtensions("")).toEqual([]);
    expect(requestedExtensions("hola")).toEqual([]);
    expect(requestedExtensions("un documento PDF")[0]).toEqual(["pdf"]);
    expect(requestedExtensions("un documento PDF")).toHaveLength(2);
    expect(requestedExtensions("an Excel sheet")).toEqual([["xlsx", "xls", "csv", "ods"]]);
    expect(requestedExtensions("en Word")).toEqual([["docx", "doc", "odt"]]);
    expect(requestedExtensions("una imagen")[0]).toContain("png");
    expect(requestedExtensions("PRESENTACIÓN")[0]).toContain("pptx");
  });
});

describe("tool-declared deliverables win over name heuristics (round 17/S1)", () => {
  const file = (path: string) => ({ path, kind: "file" as const });
  const deliverable = (path: string, kind: "document" | "image" = "document"): DeclaredOutput => ({
    path,
    role: "deliverable",
    kind,
  });
  const byproduct = (path: string): DeclaredOutput => ({ path, role: "byproduct", kind: null });
  const W = "/u/w";
  const slides = Array.from({ length: 11 }, (_, i) => `${W}/s${i}.png`);
  // The owner's turn, in production order: fonts, the page, the render, the
  // slide checks, the helper scripts, a preview page and finally the cover
  // rasterisation named after the PDF (the file the old heuristics opened).
  const ownerArtifacts = [
    file(`${W}/fonts/Inter-Regular.ttf`),
    file(`${W}/fonts/Inter-Bold.ttf`),
    file(`${W}/index.html`),
    file(`${W}/Cristian-Cordova-Helmcode.pdf`),
    ...slides.map(file),
    file(`${W}/check.js`),
    file(`${W}/check-slides.js`),
    file(`${W}/preview.html`),
    file(`${W}/Cristian-Cordova-Helmcode.pdf.png`),
  ];
  const ownerDeclared: DeclaredOutput[] = [
    byproduct(`${W}/fonts/Inter-Regular.ttf`),
    byproduct(`${W}/fonts/Inter-Bold.ttf`),
    deliverable(`${W}/Cristian-Cordova-Helmcode.pdf`),
    ...slides.map(byproduct),
    byproduct(`${W}/Cristian-Cordova-Helmcode.pdf.png`),
  ];
  const turn = (artifacts: ReturnType<typeof file>[], content = "Listo.") => [
    row(1, "user", { content: "crea una presentacion" }),
    row(2, "assistant", { content, artifacts }),
  ];

  it("owner case: 'crea una presentacion' with fonts, html, slide renders, scripts and a cover opens the PDF", () => {
    expect(lastProducedTarget(turn(ownerArtifacts), ownerDeclared)).toEqual({
      kind: "file",
      ref: `${W}/Cristian-Cordova-Helmcode.pdf`,
    });
  });

  it("owner case without declarations (legacy core): the cover render of the PDF is not the deliverable", () => {
    expect(lastProducedTarget(turn(ownerArtifacts))).not.toEqual({
      kind: "file",
      ref: `${W}/Cristian-Cordova-Helmcode.pdf.png`,
    });
  });

  it("the LAST declared deliverable wins when a turn renders twice", () => {
    const artifacts = [file(`${W}/draft.pdf`), file(`${W}/final.pdf`), file(`${W}/notes.md`)];
    const declared = [deliverable(`${W}/draft.pdf`), deliverable(`${W}/final.pdf`)];
    expect(lastProducedTarget(turn(artifacts), declared)).toEqual({ kind: "file", ref: `${W}/final.pdf` });
  });

  it("a declared deliverable beats a file the final message names", () => {
    const artifacts = [file(`${W}/deck.pdf`), file(`${W}/index.html`)];
    const reply = turn(artifacts, "He generado index.html y lo he renderizado.");
    expect(lastProducedTarget(reply, [deliverable(`${W}/deck.pdf`)])).toEqual({ kind: "file", ref: `${W}/deck.pdf` });
  });

  it("image generation: the declared image opens as media among other files", () => {
    const artifacts = [file(`${W}/prompt.txt`), { path: "/d/images/9a.png", kind: "image" as const }, file(`${W}/9a.png`)];
    expect(lastProducedTarget(turn(artifacts), [deliverable("/d/images/9a.png", "image")])).toEqual({
      kind: "media",
      ref: "/d/images/9a.png",
    });
  });

  it("a byproduct-only turn opens nothing", () => {
    const artifacts = [file(`${W}/cover.png`), file(`${W}/fonts/A.ttf`), file(`${W}/thumb-wide.webp`)];
    const declared = artifacts.map((a) => byproduct(a.path));
    expect(lastProducedTarget(turn(artifacts, "Done."), declared)).toBeNull();
  });

  it("a byproduct still opens when the final message names it (the user asked for it)", () => {
    const artifacts = [file(`${W}/cover.png`), file(`${W}/fonts/A.ttf`)];
    const declared = artifacts.map((a) => byproduct(a.path));
    expect(lastProducedTarget(turn(artifacts, "Aquí tienes cover.png"), declared)).toEqual({
      kind: "file",
      ref: `${W}/cover.png`,
    });
  });

  it("model-written files are undeclared: the file the final message names wins over the heuristics", () => {
    const artifacts = [file(`${W}/informe.md`), file(`${W}/datos.csv`)];
    expect(lastProducedTarget(turn(artifacts, "Te dejo el resumen en informe.md"), [])).toEqual({
      kind: "file",
      ref: `${W}/informe.md`,
    });
  });

  it("a single produced file still opens first, even when declared a byproduct", () => {
    expect(lastProducedTarget(turn([file(`${W}/shot.png`)]), [byproduct(`${W}/shot.png`)])).toEqual({
      kind: "file",
      ref: `${W}/shot.png`,
    });
  });
});
