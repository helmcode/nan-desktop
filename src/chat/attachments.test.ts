import { describe, expect, it, vi } from "vitest";

const pdf = vi.hoisted(() => ({ destroy: vi.fn(async () => {}) }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (n: number) => ({
        getTextContent: async () => ({
          items: [{ str: `Page ${n} line`, hasEOL: true }, { str: "end" }],
        }),
      }),
    }),
    destroy: pdf.destroy,
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.js" }));
vi.mock("mammoth", () => {
  const api = { extractRawText: async () => ({ value: "Word body text" }) };
  return { ...api, default: api };
});

import * as XLSX from "xlsx";
import {
  MAX_DOC_CHARS,
  capForCore,
  withTimeout,
  clipboardImages,
  extractText,
  fileToBase64,
  formatSize,
  pastedName,
} from "./attachments";

describe("attachment helpers", () => {
  it("formats sizes in plain units with the locale's decimal separator", () => {
    expect(formatSize(512, "es")).toBe("512 B");
    expect(formatSize(820 * 1024, "es")).toBe("820 KB");
    expect(formatSize(3.4 * 1024 * 1024, "es")).toBe("3,4 MB");
    expect(formatSize(3.4 * 1024 * 1024, "en")).toBe("3.4 MB");
  });

  it("hands the core at most one character past the cap", () => {
    expect(capForCore("abc", 5)).toBe("abc");
    expect(capForCore("abcdefgh", 5)).toBe("abcdef");
  });

  it("extracts plain text, PDF pages, Word text and every sheet locally", async () => {
    const enc = new TextEncoder();
    expect(await extractText("text", enc.encode("hola\u0000 mundo"))).toBe("hola mundo");
    expect(await extractText("other", enc.encode("{\"a\":1}"))).toBe('{"a":1}');
    expect(await extractText("pdf", new Uint8Array([1]))).toBe("Page 1 line\nend\n\nPage 2 line\nend");
    expect(pdf.destroy).toHaveBeenCalled();
    expect(await extractText("docx", new Uint8Array([1]))).toBe("Word body text");
    expect(await extractText("image", new Uint8Array([1]))).toBe("");

    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["Mes", "Total"], ["Enero", 10]]), "Ventas");
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["x"]]), "Notas");
    const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    expect(await extractText("sheet", bytes)).toBe("## Sheet: Ventas\nMes,Total\nEnero,10\n\n## Sheet: Notas\nx");
    expect(await extractText("sheet", enc.encode("a,b\n1,2"))).toBe("a,b\n1,2");
  });

  it("caps long documents for the core", async () => {
    const long = new TextEncoder().encode("z".repeat(MAX_DOC_CHARS * 2));
    expect((await extractText("text", long)).length).toBe(MAX_DOC_CHARS + 1);
  });

  it("finds pasted images and names them when the clipboard gives no name", async () => {
    const png = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    const txt = new File(["hi"], "a.txt", { type: "text/plain" });
    const data = { files: [png, txt] } as unknown as DataTransfer;
    expect(clipboardImages(data)).toEqual([png]);
    expect(clipboardImages(null)).toEqual([]);
    expect(pastedName(png, "Imagen pegada")).toBe("Imagen pegada.png");
    const jpeg = new File([new Uint8Array([1])], "", { type: "image/jpeg" });
    expect(pastedName(jpeg, "Pasted image")).toBe("Pasted image.jpg");
    const named = new File([new Uint8Array([1])], "captura.png", { type: "image/png" });
    expect(pastedName(named, "x")).toBe("captura.png");
    expect(await fileToBase64(png)).toBe(btoa(String.fromCharCode(137, 80, 78, 71)));
  });

  it("gives up on an extraction that takes too long", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<string>(() => {});
      const raced = withTimeout(never, 30_000);
      vi.advanceTimersByTime(30_001);
      await expect(raced).rejects.toThrow("timeout");
      await expect(withTimeout(Promise.resolve("ok"), 30_000)).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("decodes CSV and text as UTF-8 without a BOM, or Windows-1252, never mojibake", async () => {
    const utf8 = new TextEncoder().encode("Nombre;Ciudad\nJosé;Cádiz\n");
    expect(await extractText("sheet", utf8)).toBe("Nombre,Ciudad\nJosé,Cádiz");
    // "José;Cádiz" in Windows-1252 (é = 0xE9, á = 0xE1).
    const cp1252 = new Uint8Array([0x4a, 0x6f, 0x73, 0xe9, 0x3b, 0x43, 0xe1, 0x64, 0x69, 0x7a]);
    expect(await extractText("sheet", cp1252)).toBe("José,Cádiz");
    expect(await extractText("text", cp1252)).toBe("José;Cádiz");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("añadir")]);
    expect(await extractText("text", bom)).toBe("añadir");
  });

  it("reads only the first rows and columns of a huge sheet", async () => {
    // Small caps on a small fixture: the same code path, deterministic and
    // fast (the real caps are pinned below).
    const { MAX_SHEET_ROWS, MAX_SHEET_COLS, sheetText } = await import("./extractCore");
    expect([MAX_SHEET_ROWS, MAX_SHEET_COLS]).toEqual([5_000, 100]);
    const rows = Array.from({ length: 12 }, (_, r) => Array.from({ length: 6 }, (_, c) => (c === 0 ? `r${r}` : c)));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Big");
    const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    const lines = sheetText(bytes, 1_000_000, 5, 3).split("\n");
    expect(lines).toEqual(["r0,1,2", "r1,1,2", "r2,1,2", "r3,1,2", "r4,1,2"]);
    // The same caps apply to CSV.
    const csv = new TextEncoder().encode(rows.map((r) => r.join(",")).join("\n"));
    expect(sheetText(csv, 1_000_000, 2, 2).split("\n")).toEqual(["r0,1", "r1,1"]);
  });
});
