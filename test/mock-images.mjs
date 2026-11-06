// Minimal dependency-free mock of the OpenAI-compatible image-generation
// endpoint (T5), mirroring what the Rust core (src-tauri/src/images.rs)
// consumes:
//
//   POST /v1/images/generations → checks `Authorization: Bearer
//                                 sk-test-1234567890abcdef` (the same mock
//                                 key the device/chat mocks issue), then
//                                 validates the JSON body
//                                 {model:"qwen-image-2.1", prompt, size}
//                                 and answers the OpenAI images shape
//                                 {"created":…, "data":[{"b64_json": <tiny
//                                 valid 1x1 PNG base64>}]}.
//                                 Invalid size → 400 (sizes must be
//                                 WIDTHxHEIGHT with both dimensions in
//                                 512..1280 and multiples of 16 — mirrored
//                                 from the Rust `validate_size`).
//                                 model "trigger-429" → 429 (the monthly
//                                 image quota), "trigger-500" → 500,
//                                 header `x-nan-test-429: 1` → 429.
//                                 Reply shape: `b64_json` by default; the
//                                 LIVE community shape `{"data":[{"url"}]}`
//                                 (a presigned storage URL) when started
//                                 with MOCK_IMAGES_SHAPE=url or when the
//                                 request carries `x-nan-test-shape: url`.
//                                 The url points at /storage/<id>.png on
//                                 this server (plain http on 127.0.0.1 —
//                                 debug builds with NAN_DESKTOP_MOCK_INFERENCE
//                                 accept loopback http; release: https only).
//   POST /v1/images/edits       → the desktop-only edit surface (served by
//                                 the platform API in production). Checks
//                                 `Authorization: Bearer fake-jwt` (the
//                                 mock-device session token), then parses
//                                 the multipart body: `prompt` (the
//                                 instruction, 1..2000 chars — the OpenAI
//                                 field name the platform reads),
//                                 `image[]` (1..3 files,
//                                 PNG/JPEG/WebP magic), `n` = 1. Answers
//                                 ALWAYS {"created":…, "data":[{"b64_json"}]}.
//                                 Errors mirror the platform: 400 generic,
//                                 401, instruction "trigger-403" → 403
//                                 tier_restricted, "trigger-404" → 404,
//                                 "trigger-502" → 502.
//   POST /v1/desktop/images/edits → the enterprise desktop twin of the
//                                 edit route: same contract, but ONE image
//                                 (FLUX edits the base only; 2+ → 400).
//   POST /v1/desktop/images/generations → the desktop-only FLUX generate
//                                 route the app calls on BOTH tenants:
//                                 session bearer `fake-jwt`, multipart
//                                 `prompt`, `size`, `n=1` (model forced
//                                 server-side). Answers {"data":[{"b64_json":
//                                 <tiny JPEG>, "media_type":"image/jpeg"}]};
//                                 prompt "trigger-403" / "trigger-404" /
//                                 "trigger-429" → that status.
//                                 Point the app at this server with
//                                 NAN_DESKTOP_MOCK_IMAGES=
//                                 http://127.0.0.1:14325/v1 (debug builds;
//                                 the older NAN_DESKTOP_MOCK_IMAGE_EDITS
//                                 still works).
//   GET  /storage/<id>.png      → the PNG bytes, NO auth required (it is
//                                 "presigned"). Records whether any
//                                 Authorization header arrived — the app
//                                 must never send one there.
//   GET  /record                → the last recorded generation request
//                                 (metadata only — never the key) and the
//                                 last storage download.
//   GET  /reset                 → clears the recorded state.
//   GET  /__probe__             → 200, readiness probe for the checks.
//
// Usage: node test/mock-images.mjs

import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 14325;
const BASE = `http://${HOST}:${PORT}`;

// Same fixture key as test/mock-chat.mjs / test/mock-device.mjs.
const MOCK_KEY = "sk-test-1234567890abcdef";

// Keep in sync with src-tauri/src/images.rs (IMAGE_MODEL / size bounds).
const IMAGE_MODEL = "qwen-image-2.1";
const MIN_DIM = 512;
const MAX_DIM = 1280;
const DIM_STEP = 16;

// A tiny valid 1x1 PNG — exactly what the Rust unit tests parse
// (`TINY_PNG_B64` in src-tauri/src/images.rs). Keep both in sync.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// Same fixture session token as test/mock-device.mjs.
const MOCK_SESSION = "fake-jwt";

// Edit contract caps (keep in sync with src-tauri/src/image_edit.rs).
const MAX_EDIT_IMAGES = 3;
const MAX_INSTRUCTION_CHARS = 2000;

// The last recorded request (metadata only — never the key).
let recorded = { generation: null, storage: null, edit: null };

function reset() {
  recorded = { generation: null, storage: null, edit: null };
}

const DEFAULT_SHAPE = process.env.MOCK_IMAGES_SHAPE === "url" ? "url" : "b64";

function authorized(req) {
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${MOCK_KEY}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Mirror of the Rust `validate_size`: strict "WIDTHxHEIGHT", digits only,
// both dimensions in [MIN_DIM, MAX_DIM] and multiples of DIM_STEP.
function validSize(size) {
  if (typeof size !== "string") return false;
  const [w, h, ...rest] = size.split("x");
  if (rest.length > 0 || w === undefined || h === undefined) return false;
  const parseDim = (dim) =>
    /^[0-9]+$/.test(dim) ? Number.parseInt(dim, 10) : NaN;
  const width = parseDim(w);
  const height = parseDim(h);
  const ok = (d) => d >= MIN_DIM && d <= MAX_DIM && d % DIM_STEP === 0;
  return Number.isFinite(width) && Number.isFinite(height) && ok(width) && ok(height);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function handleGenerations(req, res, body) {
  if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
  if (req.headers["x-nan-test-429"] === "1") {
    return sendJson(res, 429, { error: "monthly image quota reached" });
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "malformed json" });
  }
  const { model, prompt, size } = parsed;
  if (model === "trigger-429") return sendJson(res, 429, { error: "quota exceeded" });
  if (model === "trigger-500") return sendJson(res, 500, { error: "server" });
  if (model !== IMAGE_MODEL) return sendJson(res, 400, { error: "unknown model" });
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return sendJson(res, 400, { error: "empty prompt" });
  }
  if (!validSize(size)) return sendJson(res, 400, { error: "invalid size" });
  const shape = req.headers["x-nan-test-shape"] === "url" ? "url" : DEFAULT_SHAPE;
  recorded.generation = { model, prompt, size, shape };
  if (shape === "url") {
    const id = `${Date.now()}`;
    return sendJson(res, 200, {
      created: 1730000000,
      data: [{ url: `${BASE}/storage/${id}.png?X-Amz-Signature=mock` }],
    });
  }
  sendJson(res, 200, { created: 1730000000, data: [{ b64_json: TINY_PNG_B64 }] });
}

// Minimal multipart/form-data parser: [{name, filename, type, data}].
function parseMultipart(contentType, body) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  if (!match) return null;
  const delimiter = Buffer.from(`--${match[1] ?? match[2]}`);
  const parts = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    // Skip the CRLF after the delimiter; drop the CRLF before the next one.
    const chunk = body.subarray(start + delimiter.length + 2, next - 2);
    const headEnd = chunk.indexOf("\r\n\r\n");
    if (headEnd !== -1) {
      const head = chunk.subarray(0, headEnd).toString("utf8");
      const name = /name="([^"]*)"/i.exec(head)?.[1];
      const filename = /filename="([^"]*)"/i.exec(head)?.[1] ?? null;
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? null;
      if (name !== undefined) parts.push({ name, filename, type, data: chunk.subarray(headEnd + 4) });
    }
    start = next;
  }
  return parts;
}

function isImage(data) {
  const png = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  const webp = data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP";
  return png || jpeg || webp;
}

// `maxImages`: 3 on the community route (qwen), 1 on the enterprise
// desktop twin (FLUX edits the base only; more is a 400).
function handleEdits(req, res, body, maxImages = MAX_EDIT_IMAGES) {
  if ((req.headers.authorization ?? "") !== `Bearer ${MOCK_SESSION}`) {
    return sendJson(res, 401, { error: "unauthorized" });
  }
  const parts = parseMultipart(req.headers["content-type"], body);
  if (!parts) return sendJson(res, 400, { error: "invalid request" });
  const instruction = parts.find((p) => p.name === "prompt")?.data.toString("utf8") ?? "";
  const images = parts.filter((p) => p.name === "image[]");
  const n = parts.find((p) => p.name === "n")?.data.toString("utf8") ?? "1";
  if (instruction === "trigger-403") return sendJson(res, 403, { error: "tier_restricted" });
  if (instruction === "trigger-404") return sendJson(res, 404, { error: "not_found" });
  if (instruction === "trigger-502") return sendJson(res, 502, { error: "upstream" });
  const chars = [...instruction].length;
  if (
    chars === 0 ||
    chars > MAX_INSTRUCTION_CHARS ||
    images.length === 0 ||
    images.length > maxImages ||
    n !== "1" ||
    !images.every((img) => isImage(img.data))
  ) {
    return sendJson(res, 400, { error: "invalid request" });
  }
  // Metadata only: the instruction LENGTH, never its text or the bytes.
  recorded.edit = {
    instruction_chars: chars,
    images: images.map((img) => ({ filename: img.filename, type: img.type, bytes: img.data.length })),
    n,
  };
  sendJson(res, 200, { created: 1730000000, data: [{ b64_json: TINY_PNG_B64 }] });
}

// A tiny JPEG header: what FLUX answers (`media_type: image/jpeg`); the app
// names it `.jpg` by its magic bytes.
const TINY_JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString("base64");

// POST /v1/desktop/images/generations: the desktop-only FLUX route (both
// tenants). Session bearer, multipart `prompt`, `size`, `n=1`; the model is
// forced server-side (a `model` field is ignored, like the platform).
function handleDesktopGenerations(req, res, body) {
  if ((req.headers.authorization ?? "") !== `Bearer ${MOCK_SESSION}`) {
    return sendJson(res, 401, { error: "unauthorized" });
  }
  const parts = parseMultipart(req.headers["content-type"], body);
  if (!parts) return sendJson(res, 400, { error: "invalid request" });
  const field = (name) => parts.find((p) => p.name === name)?.data.toString("utf8");
  const prompt = field("prompt") ?? "";
  const size = field("size") ?? "1024x1024";
  const n = field("n") ?? "1";
  if (prompt === "trigger-403") return sendJson(res, 403, { error: "tier_restricted" });
  if (prompt === "trigger-404") return sendJson(res, 404, { error: "not_found" });
  if (prompt === "trigger-429") return sendJson(res, 429, { error: "monthly image quota reached" });
  if (prompt.trim().length === 0 || n !== "1" || !validSize(size)) {
    return sendJson(res, 400, { error: "invalid request" });
  }
  recorded.generation = { model: "flux-3-image-klein", prompt_chars: [...prompt].length, size, shape: "b64" };
  sendJson(res, 200, { created: 1730000000, data: [{ b64_json: TINY_JPEG_B64, media_type: "image/jpeg" }] });
}

function handleStorage(req, res, pathname) {
  recorded.storage = { path: pathname, authorization_present: req.headers.authorization !== undefined };
  const png = Buffer.from(TINY_PNG_B64, "base64");
  res.writeHead(200, { "content-type": "image/png", "content-length": png.length });
  res.end(png);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (req.method === "GET" && url.pathname === "/__probe__") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/reset") {
    reset();
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "GET" && url.pathname === "/record") {
    return sendJson(res, 200, recorded);
  }
  if (req.method === "GET" && /^\/storage\/[0-9]+\.png$/.test(url.pathname)) {
    return handleStorage(req, res, url.pathname);
  }
  if (req.method === "POST" && url.pathname === "/v1/images/generations") {
    return void readBody(req).then((body) => handleGenerations(req, res, body));
  }
  if (req.method === "POST" && url.pathname === "/v1/images/edits") {
    return void readBody(req).then((body) => handleEdits(req, res, body));
  }
  if (req.method === "POST" && url.pathname === "/v1/desktop/images/generations") {
    return void readBody(req).then((body) => handleDesktopGenerations(req, res, body));
  }
  if (req.method === "POST" && url.pathname === "/v1/desktop/images/edits") {
    return void readBody(req).then((body) => handleEdits(req, res, body, 1));
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`mock image inference listening on ${BASE}`);
});
