// Minimal dependency-free mock of the OpenAI-compatible inference endpoints
// (T4), mirroring what the Rust chat core (src-tauri/src/chat.rs) consumes:
//
//   GET  /v1/models             → {object:"list", data:[{id}…]} with 12 models:
//                                 6 chat + 6 non-chat (to prove filtering).
//                                 401 without/with a wrong Bearer.
//   POST /v1/chat/completions   → checks `Authorization: Bearer
//                                 sk-test-1234567890abcdef` (the same mock key
//                                 the device mock issues), then streams 9 SSE
//                                 events: 1 role-only delta (empty content —
//                                 must be ignored by the client), 8 content
//                                 deltas of a markdown reply (incl. a fenced
//                                 code block and a multi-byte char that is
//                                 deliberately split across two TCP writes),
//                                 then `data: [DONE]`.
//                                 model "trigger-429" → 429, "trigger-500" → 500.
//                                 model "trigger-slow-stream" (T4b) → one small
//                                 content delta every 200 ms, forever — no
//                                 [DONE], no end: the client must disconnect
//                                 to stop it (the transport contract the stop
//                                 button relies on).
//                                 stream:false → a plain (non-streaming) reply.
//   GET  /__stats__             → { deltasSent, clientDisconnects } recorded
//                                 since the last /reset (T4b check).
//   GET  /reset                 → clears the recorded stats.
//   GET  /__probe__             → 200, readiness probe for the checks.
//
// Usage: node test/mock-chat.mjs

import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 14323;
const BASE = `http://${HOST}:${PORT}`;

// Same fixture key as test/mock-device.mjs (what the Rust core stores in the
// keychain during the mock login and then sends as the chat Bearer).
const MOCK_KEY = "sk-test-1234567890abcdef";

// 6 chat + 6 non-chat models — keep in sync with the Rust test fixture
// (`full_catalog` in src-tauri/src/chat.rs) and test/t4-check.mjs.
const CHAT_MODELS = [
  "deepseek-v4-flash",
  "glm5.3-flash",
  "mimo-v2.6-flash",
  "qwen3.8-flash",
  "gemma4",
  "qwen3.6",
];
const NON_CHAT_MODELS = [
  "kokoro",
  "whisper",
  "qwen3-embedding",
  "rerank",
  "qwen-image-2.1",
  "flux-2-klein",
];

// The full assistant reply the 8 content chunks reassemble into. Keep in sync
// with test/t4-check.mjs (EXPECTED_REPLY).
const REPLY = [
  "## Streaming check",
  "",
  "A **markdown** reply with a list:",
  "",
  "- item one",
  "- item two",
  "",
  "And a fenced code block:",
  "",
  "```rust",
  "fn main() {",
  '    println!("hello from the mock");',
  "}",
  "```",
  "",
  "Café ☕ — done.",
].join("\n");

// Split the reply into 8 content chunks at roughly even char boundaries.
function splitReply(text, parts) {
  const chars = [...text];
  const size = Math.ceil(chars.length / parts);
  const chunks = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}
const CONTENT_CHUNKS = splitReply(REPLY, 8);

// The chunk carrying the multi-byte emoji ☕ (3 bytes: E2 98 95) is written in
// two TCP writes with its bytes split mid-character, exercising the client's
// incremental UTF-8 decoder.
const EMOJI = "☕";
const EMOJI_CHUNK_INDEX = CONTENT_CHUNKS.findIndex((chunk) => chunk.includes(EMOJI));

const STREAM_EVENT_DELAY_MS = 15;

// T4b slow-stream trigger: one delta every 200 ms, never ending.
const SLOW_EVENT_DELAY_MS = 200;

// Recorded since the last /reset: how many content deltas were written and
// how many clients disconnected mid-stream (closed before the response
// finished) — the T4b check asserts both.
const stats = { deltasSent: 0, clientDisconnects: 0 };

// Track premature client disconnects: `close` fires on normal completion
// too, so only count it when the response never finished.
function trackDisconnect(res) {
  let finished = false;
  res.on("finish", () => {
    finished = true;
  });
  res.on("close", () => {
    if (!finished) stats.clientDisconnects += 1;
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${MOCK_KEY}`;
}

function chunkEvent(delta) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1730000000,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stream the SSE reply: role-only delta → 8 content deltas → [DONE].
async function streamReply(res, requestedModel) {
  trackDisconnect(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  // Role preamble: no content — the client must ignore it.
  res.write(chunkEvent({ role: "assistant", content: "" }));
  await sleep(STREAM_EVENT_DELAY_MS);

  for (let i = 0; i < CONTENT_CHUNKS.length; i += 1) {
    const line = Buffer.from(chunkEvent({ content: CONTENT_CHUNKS[i] }));
    stats.deltasSent += 1;
    if (i === EMOJI_CHUNK_INDEX) {
      // Split the bytes mid-emoji across two writes.
      const before = Buffer.byteLength(
        CONTENT_CHUNKS[i].slice(0, CONTENT_CHUNKS[i].indexOf(EMOJI)),
        "utf8",
      );
      const splitAt = before + 1; // middle byte of the 3-byte emoji
      res.write(line.slice(0, splitAt));
      await sleep(STREAM_EVENT_DELAY_MS);
      res.write(line.slice(splitAt));
    } else {
      res.write(line);
    }
    await sleep(STREAM_EVENT_DELAY_MS);
  }

  res.write("data: [DONE]\n\n");
  // The requested model is echoed in a final usage-style event only when it
  // is a trigger name, so the wire check can assert pass-through.
  void requestedModel;
  res.end();
}

// T4b slow-stream trigger: one small content delta every SLOW_EVENT_DELAY_MS
// forever — no [DONE], no end. Only the client going away stops it, which is
// exactly what the stop button does to a live stream (abort the read). The
// writes are guarded: once the client is gone, res.write can throw.
function streamSlowReply(res) {
  trackDisconnect(res);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  let index = 0;
  const timer = setInterval(() => {
    index += 1;
    stats.deltasSent += 1;
    try {
      res.write(chunkEvent({ content: `chunk ${index} ` }));
    } catch {
      // Client gone — the close handler below stops this interval.
    }
  }, SLOW_EVENT_DELAY_MS);
  res.on("close", () => clearInterval(timer));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);

  if (req.method === "GET" && url.pathname === "/__probe__") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/reset") {
    stats.deltasSent = 0;
    stats.clientDisconnects = 0;
    sendJson(res, 200, { ok: true, note: "recorded stats cleared" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/__stats__") {
    sendJson(res, 200, { ...stats });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (!authorized(req)) {
      sendJson(res, 401, { error: { message: "invalid api key", type: "auth" } });
      return;
    }
    sendJson(res, 200, {
      object: "list",
      data: [...CHAT_MODELS, ...NON_CHAT_MODELS].map((id) => ({
        id,
        object: "model",
        created: 1730000000,
        owned_by: "mock",
      })),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (!authorized(req)) {
      sendJson(res, 401, { error: { message: "invalid api key", type: "auth" } });
      return;
    }
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: { message: "invalid JSON body" } });
      return;
    }
    if (body.model === "trigger-429") {
      sendJson(res, 429, { error: { message: "rate limited", type: "rate_limit" } });
      return;
    }
    if (body.model === "trigger-500") {
      sendJson(res, 500, { error: { message: "internal error" } });
      return;
    }
    if (body.model === "trigger-slow-stream") {
      streamSlowReply(res);
      return;
    }
    if (body.stream === true) {
      await streamReply(res, body.model);
      return;
    }
    // Non-streaming fallback (the app always streams; kept for completeness).
    sendJson(res, 200, {
      id: "chatcmpl-mock",
      object: "chat.completion",
      model: body.model ?? "mock-model",
      choices: [
        { index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" },
      ],
    });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`mock chat inference listening on ${BASE}/v1/*`);
});
