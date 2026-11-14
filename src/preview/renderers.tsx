// Preview renderers (S21). This module is itself lazy-loaded with the pane;
// the heavy libraries (pdf.js, SheetJS, mammoth) load on first use only.
//
// CSP notes: images and PDF pages are painted on a <canvas> from bytes the
// core returned, so no data:/blob: URL is ever created. HTML (files and
// docx output) goes through SafeHtml; markdown/text through Markdown.

import { useCallback, useEffect, useRef, useState } from "react";
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

/// Widest a PDF page is drawn on screen (CSS px). Pages fill the pane
/// width up to this cap; the cap only bites on very wide panes.
export const PDF_MAX_PAGE_WIDTH = 1100;
/// Narrowest render width (CSS px), so a page shown in a narrow pane
/// stays sharp if the pane is widened afterwards.
const PDF_MIN_RENDER_WIDTH = 480;
/// Device pixel ratio ceiling: sharp on retina, bounded canvas memory.
const PDF_MAX_DPR = 2;
/// Pages this far (px) outside the visible area are already rendered, so
/// scrolling rarely meets a blank page.
const PDF_RENDER_MARGIN = "1200px 0px";

/// pdf.js scale that draws a page `pageWidth` points wide at the pane's
/// width (clamped to [PDF_MIN_RENDER_WIDTH, PDF_MAX_PAGE_WIDTH] CSS px)
/// times the device pixel ratio (capped at PDF_MAX_DPR).
export function pdfRenderScale(pageWidth: number, paneWidth: number, dpr: number): number {
  if (!(pageWidth > 0)) return 1;
  const css = Math.min(PDF_MAX_PAGE_WIDTH, Math.max(PDF_MIN_RENDER_WIDTH, paneWidth || 0));
  const ratio = Math.min(PDF_MAX_DPR, Math.max(1, dpr || 1));
  return (css * ratio) / pageWidth;
}

/// The page whose top has crossed 40% of the scroll area's height is the
/// current one (1-based); before the first page, it is page 1.
export function currentPdfPage(pageTops: number[], viewTop: number, viewHeight: number): number {
  const line = viewTop + viewHeight * 0.4;
  let current = 1;
  pageTops.forEach((top, i) => {
    if (top <= line) current = i + 1;
  });
  return current;
}

function scrollAreaOf(el: HTMLElement | null): HTMLElement | null {
  return (el?.closest(".preview-body") as HTMLElement | null) ?? el?.parentElement ?? null;
}

/// One page of the continuous PDF view. Its box keeps the page's aspect
/// ratio before it is drawn (stable scroll height), and it is painted the
/// first time it comes near the visible area.
function PdfPageView({
  doc,
  number,
  total,
  ratio: initialRatio,
  onFailed,
}: {
  doc: PdfDoc;
  number: number;
  total: number;
  ratio: number;
  onFailed: () => void;
}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [near, setNear] = useState(false);
  const [ratio, setRatio] = useState(initialRatio);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { root: scrollAreaOf(box), rootMargin: PDF_RENDER_MARGIN },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    (async () => {
      const page = await doc.getPage(number);
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const base = page.getViewport({ scale: 1 });
      if (base.width > 0 && base.height > 0) setRatio(base.width / base.height);
      const paneWidth = boxRef.current?.clientWidth ?? 0;
      const viewport = page.getViewport({ scale: pdfRenderScale(base.width, paneWidth, window.devicePixelRatio) });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    })().catch(() => {
      if (!cancelled) onFailed();
    });
    return () => {
      cancelled = true;
    };
  }, [doc, number, near, onFailed]);

  return (
    <div ref={boxRef} className="preview-pdf-page" data-page={number} style={{ aspectRatio: String(ratio) }}>
      <canvas ref={canvasRef} className="preview-pdf-canvas" role="img" aria-label={t.preview.page(number, total)} />
    </div>
  );
}

/// The whole PDF as one vertical scroll: every page stacked at the pane's
/// width (capped at PDF_MAX_PAGE_WIDTH), painted lazily as it nears the
/// visible area. A small sticky label tracks the current page.
export function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<{ pdf: PdfDoc; ratio: number } | null>(null);
  const [current, setCurrent] = useState(1);
  const [failed, setFailed] = useState(false);
  const onFailed = useCallback(() => setFailed(true), []);

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
      // Page 1 sizes every placeholder until each page reports its own.
      const first = (await loaded.getPage(1)).getViewport({ scale: 1 });
      if (cancelled) {
        void loaded.destroy();
        return;
      }
      setDoc({ pdf: loaded, ratio: first.width > 0 && first.height > 0 ? first.width / first.height : 1 / Math.SQRT2 });
      setCurrent(1);
    })().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    if (!doc || doc.pdf.numPages < 2) return;
    const area = scrollAreaOf(rootRef.current);
    if (!area) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const view = area.getBoundingClientRect();
      const tops = Array.from(area.querySelectorAll<HTMLElement>(".preview-pdf-page"), (el) => el.getBoundingClientRect().top);
      setCurrent(currentPdfPage(tops, view.top, view.height));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    area.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      area.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [doc]);

  if (failed) return <p className="preview-note">{t.preview.failed}</p>;
  if (!doc) return <p className="preview-note">{t.preview.loading}</p>;
  const total = doc.pdf.numPages;
  return (
    <div ref={rootRef} className="preview-pdf" role="group" aria-label={t.preview.pdfPages(total)}>
      {total > 1 && (
        // Visual only: every page canvas already carries "Page n of N".
        <div className="preview-pdf-indicator" aria-hidden="true">
          {t.preview.page(current, total)}
        </div>
      )}
      {Array.from({ length: total }, (_, i) => (
        <PdfPageView key={i + 1} doc={doc.pdf} number={i + 1} total={total} ratio={doc.ratio} onFailed={onFailed} />
      ))}
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
