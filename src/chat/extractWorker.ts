// Web Worker for DOCX and spreadsheet text extraction: a zip bomb or a
// pathological workbook can only hang this worker, which the page
// terminates after EXTRACTION_TIMEOUT_MS (see attachments.ts).

import { extractInWorkerKinds } from "./extractCore";

interface Request {
  kind: "docx" | "sheet";
  bytes: Uint8Array;
  max: number;
}

const scope = globalThis as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<Request>) => void) => void;
  postMessage: (message: unknown) => void;
};

scope.addEventListener("message", (event) => {
  const { kind, bytes, max } = event.data;
  extractInWorkerKinds(kind, bytes, max).then(
    (text) => scope.postMessage({ ok: true, text }),
    () => scope.postMessage({ ok: false }),
  );
});
