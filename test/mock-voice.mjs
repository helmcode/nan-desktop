// Minimal dependency-free mock of the OpenAI-compatible voice endpoints
// (T6), mirroring what the Rust audio cores (src-tauri/src/tts.rs and
// src-tauri/src/stt.rs) consume:
//
//   POST /v1/audio/speech          → checks `Authorization: Bearer
//                                    sk-test-1234567890abcdef` (the same mock
//                                    key the device/chat mocks issue), then
//                                    validates the JSON body
//                                    {model:"kokoro", voice, input,
//                                    response_format:"wav"} and answers with
//                                    a synthesized PCM16 mono 22050 Hz WAV
//                                    (audio/wav). Invalid body → 400.
//                                    model "trigger-429" → 429,
//                                    "trigger-500" → 500.
//   POST /v1/audio/transcriptions  → same Bearer check, then parses the
//                                    multipart body (boundary + parts parsed
//                                    by hand — no dependencies) and requires
//                                    a `model` field ("whisper"; values
//                                    "trigger-429"/"trigger-500" answer
//                                    429/500 for classification tests) and a
//                                    non-empty `file` part. Files over 25 MiB
//                                    → 413 (the server-side guard; the Rust
//                                    core rejects them locally first). Valid
//                                    uploads answer {text}.
//   GET  /record                   → the last recorded speech request and
//                                    transcription upload shape (used by
//                                    test/t6-check.mjs to assert the wire
//                                    contract the Rust cores are tested
//                                    against). Audio bytes are never stored —
//                                    only sizes and metadata.
//   GET  /reset                    → clears the recorded state.
//   GET  /__probe__                → 200, readiness probe for the checks.
//
// Usage: node test/mock-voice.mjs

import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 14324;
const BASE = `http://${HOST}:${PORT}`;

// Same fixture key as test/mock-chat.mjs / test/mock-device.mjs.
const MOCK_KEY = "sk-test-1234567890abcdef";

// Keep in sync with src-tauri/src/tts.rs (VOICES/TTS_MODEL/RESPONSE_FORMAT)
// and src-tauri/src/stt.rs (STT_MODEL/MAX_AUDIO_BYTES).
const VOICES = ["ef_dora", "em_alex", "af_heart"];
const SPEECH_SAMPLES = 2205; // 0.1 s at 22050 Hz — enough to decode + play
const SAMPLE_RATE = 22050;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// The last recorded requests (metadata only — never the audio bytes).
const recorded = {
  speech: null,
  transcription: null,
};

function reset() {
  recorded.speech = null;
  recorded.transcription = null;
}

// Synthesize a tiny valid PCM16 mono WAV — byte-for-byte the same shape the
// Rust unit tests (`tiny_wav` in src-tauri/src/tts.rs) build.
function synthWav(samples = SPEECH_SAMPLES) {
  const dataLen = samples * 2;
  const wav = Buffer.alloc(44 + dataLen);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16); // fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  wav.writeUInt16LE(2, 32); // block align
  wav.writeUInt16LE(16, 34); // bits per sample
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i += 1) {
    wav.writeInt16LE((((i % 64) - 32) * 512) | 0, 44 + i * 2);
  }
  return wav;
}

function authorized(req) {
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${MOCK_KEY}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// Dependency-free multipart/form-data parser: split the raw body on the
// boundary, take each part's headers and bytes.
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  if (!match) return null;
  const boundary = (match[1] ?? match[2]).trim();
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let idx = buffer.indexOf(delimiter);
  while (idx !== -1) {
    const after = idx + delimiter.length;
    if (buffer.slice(after, after + 2).toString("utf8") === "--") break; // closing delimiter
    const headStart = after + 2; // skip CRLF
    const headEnd = buffer.indexOf("\r\n\r\n", headStart);
    if (headEnd === -1) break;
    const headerBlock = buffer.slice(headStart, headEnd).toString("utf8");
    const next = buffer.indexOf(delimiter, headEnd + 4);
    if (next === -1) break;
    const body = buffer.slice(headEnd + 4, next - 2); // strip trailing CRLF
    const headers = {};
    for (const line of headerBlock.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }
    const disposition = headers["content-disposition"] ?? "";
    const name = /name="([^"]*)"/i.exec(disposition)?.[1] ?? "";
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1] ?? null;
    parts.push({
      name,
      filename,
      contentType: headers["content-type"] ?? null,
      size: body.length,
      body,
    });
    idx = next;
  }
  return parts;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function handleSpeech(req, res, body) {
  if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "malformed json" });
  }
  const { model, voice, input, response_format: format } = parsed;
  if (model === "trigger-429") return sendJson(res, 429, { error: "rate_limited" });
  if (model === "trigger-500") return sendJson(res, 500, { error: "server" });
  if (model !== "kokoro") return sendJson(res, 400, { error: "unknown model" });
  if (!VOICES.includes(voice)) return sendJson(res, 400, { error: "unknown voice" });
  if (typeof input !== "string" || input.length === 0) {
    return sendJson(res, 400, { error: "empty input" });
  }
  if (format !== "wav") return sendJson(res, 400, { error: "only wav is served" });
  recorded.speech = { model, voice, input, response_format: format };
  const wav = synthWav();
  res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length });
  res.end(wav);
}

function handleTranscriptions(req, res, body) {
  if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
  const parts = parseMultipart(body, req.headers["content-type"]);
  if (!parts || parts.length === 0) {
    return sendJson(res, 400, { error: "malformed multipart" });
  }
  const model = parts.find((p) => p.name === "model")?.body.toString("utf8") ?? "";
  const file = parts.find((p) => p.name === "file");
  if (model === "trigger-429") return sendJson(res, 429, { error: "rate_limited" });
  if (model === "trigger-500") return sendJson(res, 500, { error: "server" });
  if (model !== "whisper") return sendJson(res, 400, { error: "unknown model" });
  if (!file || file.size === 0) return sendJson(res, 400, { error: "missing file part" });
  if (file.size > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: "file too large" });
  // Record the upload shape only — never the audio bytes themselves.
  recorded.transcription = {
    model,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    extraParts: parts.filter((p) => p.name !== "model" && p.name !== "file").map((p) => p.name),
  };
  sendJson(res, 200, { text: `Mock transcription of ${file.size} bytes` });
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
  if (req.method === "POST" && url.pathname === "/v1/audio/speech") {
    return void readBody(req).then((body) => handleSpeech(req, res, body));
  }
  if (req.method === "POST" && url.pathname === "/v1/audio/transcriptions") {
    return void readBody(req).then((body) => handleTranscriptions(req, res, body));
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`mock voice inference listening on ${BASE}`);
});
