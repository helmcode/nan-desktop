// Document text extraction that may run inside a Web Worker
// (extractWorker.ts): DOCX through mammoth, spreadsheets through SheetJS,
// plain text through a UTF-8 / Windows-1252 decoder. No DOM access here.

import mammothModule from "mammoth";
import * as XLSX from "xlsx";

/// Rows and columns read per sheet (bounds the work a huge or crafted
/// workbook can cause before the per-file character cap applies).
export const MAX_SHEET_ROWS = 5_000;
export const MAX_SHEET_COLS = 100;

interface MammothRaw {
  extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/// Text bytes as a string: UTF-8 (BOM dropped) when the bytes are valid
/// UTF-8, otherwise Windows-1252 (Excel's "CSV" on Windows), so accents
/// never turn into mojibake or replacement characters.
export function decodeText(bytes: Uint8Array): string {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/// A ZIP (xlsx, ods) or legacy OLE (xls) container, read as binary.
function isBinaryWorkbook(bytes: Uint8Array): boolean {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  return zip || ole;
}

export async function docxText(bytes: Uint8Array): Promise<string> {
  const mod = mammothModule as unknown as MammothRaw & { default?: MammothRaw };
  const mammoth = mod.default ?? mod;
  const result = await mammoth.extractRawText({ arrayBuffer: toArrayBuffer(bytes) });
  return result.value;
}

export function sheetText(bytes: Uint8Array, max: number): string {
  const workbook = isBinaryWorkbook(bytes)
    ? XLSX.read(bytes, { type: "array", sheetRows: MAX_SHEET_ROWS })
    : XLSX.read(decodeText(bytes), { type: "string", sheetRows: MAX_SHEET_ROWS });
  const blocks: string[] = [];
  let length = 0;
  for (const name of workbook.SheetNames) {
    if (length > max) break;
    const sheet = workbook.Sheets[name];
    const ref = sheet["!ref"];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      range.e.r = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1);
      range.e.c = Math.min(range.e.c, range.s.c + MAX_SHEET_COLS - 1);
      sheet["!ref"] = XLSX.utils.encode_range(range);
    }
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    const block = workbook.SheetNames.length > 1 ? `## Sheet: ${name}\n${csv}` : csv;
    blocks.push(block);
    length += block.length + 2;
  }
  return blocks.join("\n\n");
}

/// Extraction of the kinds the worker handles.
export async function extractInWorkerKinds(kind: "docx" | "sheet", bytes: Uint8Array, max: number): Promise<string> {
  return kind === "docx" ? docxText(bytes) : sheetText(bytes, max);
}
