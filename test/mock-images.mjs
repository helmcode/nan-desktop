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
//                                 The `url` reply variant is NEVER served —
//                                 the app rejects it with kind `protocol`
//                                 (S12: no third-party endpoints), and that
//                                 behavior is pinned by Rust unit tests.
//   GET  /record                → the last recorded generation request
//                                 (metadata only — never the key).
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

// The last recorded request (metadata only — never the key).
let recorded = { generation: null };

function reset() {
  recorded = { generation: null };
}

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
  recorded.generation = { model, prompt, size };
  sendJson(res, 200, { created: 1730000000, data: [{ b64_json: TINY_PNG_B64 }] });
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
  if (req.method === "POST" && url.pathname === "/v1/images/generations") {
    return void readBody(req).then((body) => handleGenerations(req, res, body));
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`mock image inference listening on ${BASE}`);
});
