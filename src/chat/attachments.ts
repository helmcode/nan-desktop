// Composer attachments: pure helpers and LOCAL text extraction.
//
// The core stages every file (src-tauri/src/attachments.rs): images are
// prepared there (downscaled JPEG) and shown through the asset protocol;
// documents are read back once (`readAttachment`) and their TEXT is
// extracted here with the libraries the preview pane already ships (pdf.js,
// mammoth, SheetJS), loaded on first use. The extracted text goes to the
// core with `chat_send`, which caps it and stores it with the message, so
// history replays exactly what the model saw. Nothing leaves the computer
// except, later, inside the chat request itself.

import type { AttachmentKind, MessageAttachment } from "../types";

/// Most files per message (mirrors `MAX_FILES_PER_MESSAGE` in the core).
export const MAX_ATTACHMENTS = 10;
/// Extracted characters kept per document (mirrors `MAX_DOC_CHARS`); the
/// renderer stops one past it so the core can mark the cut.
export const MAX_DOC_CHARS = 50_000;
/// Largest sum of a message's original files (mirrors `MAX_TOTAL_BYTES`).
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/// Extracted characters kept per message (mirrors `MAX_TOTAL_DOC_CHARS`).
export const MAX_DOC_CHARS_PER_MESSAGE = 120_000;

/// A composer chip: a staged file and, for documents, its extracted text.
export interface PendingAttachment {
  id: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  previewPath: string | null;
  /// `reading` while a document's text is being extracted.
  status: "reading" | "ready";
  text?: string;
}

/// Longest a document's text extraction may take before it is given up.
export const EXTRACTION_TIMEOUT_MS = 30_000;

/// `promise`, or a rejection with "timeout" after `ms`.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/// The `chat_send` payload of composer chips: staged ids, plus the
/// extracted text of documents.
export function attachmentPayload(items: readonly PendingAttachment[]): { id: string; text?: string }[] {
  return items.map((item) => (item.kind === "image" ? { id: item.id } : { id: item.id, text: item.text ?? "" }));
}

/// Composer chips as message attachments (the just-sent bubble). Mirrors
/// the core's caps (per file, then per message) so the bubble already says
/// when only the beginning of a document is used.
export function pendingAsMessageAttachments(items: readonly PendingAttachment[]): MessageAttachment[] {
  let budget = MAX_DOC_CHARS_PER_MESSAGE;
  return items.map((item) => {
    let truncated = false;
    if (item.kind !== "image") {
      const length = (item.text ?? "").trimEnd().length;
      const limit = Math.min(MAX_DOC_CHARS, budget);
      truncated = length > limit;
      budget -= Math.min(length, limit);
    }
    return { id: item.id, kind: item.kind, name: item.name, size: item.size, path: item.previewPath, truncated };
  });
}

/// Human size, e.g. "820 KB", "3,4 MB" (locale decimal separator).
export function formatSize(bytes: number, locale: string): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString(locale, { maximumFractionDigits: 1 })} MB`;
}

/// Cut text to `max` + 1 characters at most (the core decides the cut).
export function capForCore(text: string, max = MAX_DOC_CHARS): string {
  return text.length > max + 1 ? text.slice(0, max + 1) : text;
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfPageLike {
  getTextContent: () => Promise<{ items: PdfTextItem[] }>;
}
interface PdfDocLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
}
interface PdfTaskLike {
  promise: Promise<PdfDocLike>;
  destroy: () => Promise<void>;
}

async function pdfText(bytes: Uint8Array, max: number): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes.slice() }) as unknown as PdfTaskLike;
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    let length = 0;
    for (let n = 1; n <= doc.numPages && length <= max; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : ""))
        .join("")
        .trim();
      pages.push(text);
      length += text.length + 2;
    }
    return pages.join("\n\n");
  } finally {
    void Promise.resolve(task.destroy()).catch(() => {});
  }
}

/// DOCX and spreadsheets are parsed in a Web Worker that is terminated
/// after `timeoutMs` (a zip bomb cannot hang the window). Without Worker
/// support (tests) they run inline.
async function inWorker(kind: "docx" | "sheet", bytes: Uint8Array, max: number, timeoutMs: number): Promise<string> {
  if (typeof Worker === "undefined") {
    const core = await import("./extractCore");
    return withTimeout(core.extractInWorkerKinds(kind, bytes, max), timeoutMs);
  }
  const worker = new Worker(new URL("./extractWorker.ts", import.meta.url), { type: "module" });
  try {
    const reply = new Promise<string>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ ok: boolean; text?: string }>) =>
        event.data.ok ? resolve(event.data.text ?? "") : reject(new Error("extract"));
      worker.onerror = () => reject(new Error("extract"));
    });
    worker.postMessage({ kind, bytes, max });
    return await withTimeout(reply, timeoutMs);
  } finally {
    worker.terminate();
  }
}

/// The text of a staged document, extracted locally and capped for the core.
export async function extractText(
  kind: AttachmentKind,
  bytes: Uint8Array,
  max = MAX_DOC_CHARS,
  timeoutMs = EXTRACTION_TIMEOUT_MS,
): Promise<string> {
  let text: string;
  switch (kind) {
    case "pdf":
      text = await withTimeout(pdfText(bytes, max), timeoutMs);
      break;
    case "docx":
    case "sheet":
      text = await inWorker(kind, bytes, max, timeoutMs);
      break;
    case "image":
      return "";
    default:
      text = (await import("./extractCore")).decodeText(bytes);
  }
  return capForCore(text.replace(/\u0000/g, ""), max);
}

/// Image files on the clipboard (pasting a screenshot into the composer).
/// Only when the clipboard carries no meaningful text: Office and Excel put
/// both the text and a picture of it, and the text is what the user means.
export function clipboardImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const text = typeof data.getData === "function" ? data.getData("text/plain") : "";
  if (text.trim().length > 0) return [];
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith("image/"));
}

function blobBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/// Base64 of a file's bytes (pasted images travel to the core this way).
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await blobBytes(file));
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/// A name for a pasted image without one ("Pasted image.png").
export function pastedName(file: File, fallback: string): string {
  const name = file.name?.trim();
  if (name && name !== "image.png") return name;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return `${fallback}.${ext}`;
}
