// Preview renderers (S21). This module is itself lazy-loaded with the pane;
// the heavy libraries (pdf.js, SheetJS, mammoth) load on first use only.
//
// CSP notes: images and PDF pages are painted on a <canvas> from bytes the
// core returned, so no data:/blob: URL is ever created. HTML (files and
// docx output) goes through SafeHtml; markdown/text through Markdown.

import { useEffect, useRef, useState } from "react";
import { Markdown } from "../Markdown";
import { useT } from "../i18n";
import { codeLanguage } from "./kind";
import { SafeHtml } from "./safeHtml";

const MAX_SHEET_ROWS = 500;
const MAX_SHEET_COLS = 50;

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/// A fence longer than any backtick run inside, so text can never escape it.
export function fenced(text: string, language: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function ImagePreview({ bytes, alt }: { bytes: Uint8Array; alt: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    createImageBitmap(new Blob([toArrayBuffer(bytes)]))
      .then((bitmap) => {
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (failed) return <p className="preview-note">{t.preview.failed}</p>;
  return <canvas ref={canvasRef} className="preview-image" role="img" aria-label={alt} />;
}

interface PdfDoc {
  numPages: number;
  getPage: (n: number) => Promise<PdfPage>;
  destroy: () => Promise<void>;
}
interface PdfPage {
  getViewport: (opts: { scale: number }) => { width: number; height: number };
  render: (params: unknown) => { promise: Promise<void> };
}

export function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [page, setPage] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    (async () => {
      const pdfjs = await import("pdfjs-dist");
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      // pdf.js may transfer the buffer: hand it a copy. (pdfjs-dist 5 moved
      // isEvalSupported out of DocumentInitParameters; the worker is a
      // bundled same-origin asset, so the default is fine.)
      const task = pdfjs.getDocument({ data: bytes.slice() });
      loaded = (await task.promise) as unknown as PdfDoc;
      if (cancelled) {
        void loaded.destroy();
        return;
      }
      setDoc(loaded);
      setPage(1);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      const pdfPage = await doc.getPage(page);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const viewport = pdfPage.getViewport({ scale: 1.5 });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [doc, page]);

  if (failed) return <p className="preview-note">{t.preview.failed}</p>;
  if (!doc) return <p className="preview-note">{t.preview.loading}</p>;
  return (
    <div className="preview-pdf">
      <canvas ref={canvasRef} className="preview-image" />
      {doc.numPages > 1 && (
        <div className="preview-pager">
          <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            {t.preview.previous}
          </button>
          <span className="preview-pager-label">{t.preview.page(page, doc.numPages)}</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={page >= doc.numPages}
            onClick={() => setPage((p) => p + 1)}
          >
            {t.preview.next}
          </button>
        </div>
      )}
    </div>
  );
}

export function TextPreview({ bytes, path, markdown }: { bytes: Uint8Array; path: string; markdown: boolean }) {
  const text = decodeText(bytes);
  return <Markdown text={markdown ? text : fenced(text, codeLanguage(path))} />;
}

export function HtmlPreview({ bytes, onOpenLink }: { bytes: Uint8Array; onOpenLink?: (url: string) => void }) {
  return <SafeHtml html={decodeText(bytes)} onOpenLink={onOpenLink} />;
}

type Cell = string | number | boolean | null | undefined;

export function SheetPreview({ bytes }: { bytes: Uint8Array }) {
  const t = useT();
  const [sheets, setSheets] = useState<{ name: string; rows: Cell[][] }[] | null>(null);
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(bytes, { type: "array" });
      const parsed = workbook.SheetNames.map((name) => ({
        name,
        rows: (XLSX.utils.sheet_to_json<Cell[]>(workbook.Sheets[name], { header: 1, blankrows: false }) ?? [])
          .slice(0, MAX_SHEET_ROWS)
          .map((row) => row.slice(0, MAX_SHEET_COLS)),
      }));
      if (!cancelled) setSheets(parsed);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (failed) return <p className="preview-note">{t.preview.failed}</p>;
  if (!sheets) return <p className="preview-note">{t.preview.loading}</p>;
  const current = sheets[active] ?? sheets[0];
  return (
    <div className="preview-sheet">
      {sheets.length > 1 && (
        <div className="preview-tabs" role="tablist" aria-label={t.preview.sheet}>
          {sheets.map((sheet, i) => (
            <button
              key={sheet.name}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={`preview-tab${i === active ? " active" : ""}`}
              onClick={() => setActive(i)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      <div className="md md-table-wrap">
        <table>
          <tbody>
            {(current?.rows ?? []).map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) =>
                  r === 0 ? <th key={c}>{cell == null ? "" : String(cell)}</th> : <td key={c}>{cell == null ? "" : String(cell)}</td>,
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface MammothLike {
  convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
}

export function DocxPreview({ bytes, onOpenLink }: { bytes: Uint8Array; onOpenLink?: (url: string) => void }) {
  const t = useT();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const mod = (await import("mammoth")) as unknown as MammothLike & { default?: MammothLike };
      const mammoth = mod.default ?? mod;
      const result = await mammoth.convertToHtml({ arrayBuffer: toArrayBuffer(bytes) });
      if (!cancelled) setHtml(result.value);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (failed) return <p className="preview-note">{t.preview.failed}</p>;
  if (html === null) return <p className="preview-note">{t.preview.loading}</p>;
  return <SafeHtml html={html} onOpenLink={onOpenLink} />;
}
