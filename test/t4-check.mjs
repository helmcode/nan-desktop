// T4 integration check (optional; the direct cargo/pnpm commands are the
// primary verification per the task).
//
// Starts the mock inference server (test/mock-chat.mjs) and proves the wire
// contract the Rust chat core (src-tauri/src/chat.rs) is unit-tested against:
//
//   1. GET /v1/models — 401 without a Bearer; with the mock Bearer, exactly
//      the 12-model fixture (6 chat + 6 non-chat). The Rust-side filtering of
//      that same fixture (only 6 chat models, deepseek-v4-flash first) is
//      pinned by `filter_chat_models` unit tests — run at the end.
//   2. POST /v1/chat/completions (stream:true) — the byte-level SSE
//      reassembly + accumulation contract: role-only preamble ignored, 8
//      content deltas accumulating to the exact full reply (including the
//      multi-byte char split across two TCP writes), final `data: [DONE]`.
//   3. Auth + status classification — 401 without/wrong Bearer, 429 and 500
//      on the trigger models (what the Rust core maps to unauthorized /
//      rate_limited / server error kinds).
//   4. Persistence round-trip — `cargo test` runs the full Rust suite,
//      including the chat_store round-trips (conversation → user + assistant
//      messages → list → delete) against temp SQLite files.
//
// Usage: node test/t4-check.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 14323;
const BASE = `http://${HOST}:${PORT}`;
const MODELS_URL = `${BASE}/v1/models`;
const CHAT_URL = `${BASE}/v1/chat/completions`;
const RESET_URL = `${BASE}/reset`;

const MOCK_KEY = "sk-test-1234567890abcdef"; // must match mock-chat.mjs / mock-device.mjs

// 6 chat + 6 non-chat — must match mock-chat.mjs and the Rust fixture
// `full_catalog` in src-tauri/src/chat.rs.
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
const EXPECTED_REPLY = [
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
const EXPECTED_CONTENT_CHUNKS = 8; // must match mock-chat.mjs splitReply(REPLY, 8)

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForServer(attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      // Any HTTP response (even our 404) proves the server is listening.
      await fetch(`${BASE}/__probe__`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`mock chat inference did not come up at ${CHAT_URL}`);
}

async function expectModelsContract() {
  const unauth = await fetch(MODELS_URL);
  assert(unauth.status === 401, `models without Bearer: expected 401, got ${unauth.status}`);

  const res = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${MOCK_KEY}` } });
  assert(res.status === 200, `models with Bearer: expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.object === "list", "models: expected object=list");
  const ids = body.data.map((m) => m.id);
  const expected = [...CHAT_MODELS, ...NON_CHAT_MODELS].sort();
  assert(
    JSON.stringify([...ids].sort()) === JSON.stringify(expected),
    `models: raw catalog must be exactly the 12-model fixture, got ${JSON.stringify(ids)}`,
  );
  for (const chat of CHAT_MODELS) {
    assert(ids.includes(chat), `models: chat model ${chat} missing from the raw catalog`);
  }
  for (const non of NON_CHAT_MODELS) {
    assert(ids.includes(non), `models: non-chat model ${non} missing (needed to prove filtering)`);
  }
  console.log("models contract OK: 401 without Bearer; raw catalog = 6 chat + 6 non-chat fixture");
  console.log("(filtering to the 6 chat models, deepseek first, is pinned by the Rust unit tests)");
}

// Read an SSE stream at the byte level: reassemble network chunks, split
// complete lines, extract `data:` payloads. Decoding only complete lines
// keeps multi-byte characters split across TCP writes intact.
async function readSseDataPayloads(url, body) {
  const rawChunks = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rawChunks.push(value);
  }
  let raw = Buffer.concat(rawChunks.map((c) => Buffer.from(c)));
  const payloads = [];
  for (;;) {
    const idx = raw.indexOf(0x0a); // '\n'
    if (idx === -1) break;
    const line = raw.slice(0, idx).toString("utf8");
    raw = raw.slice(idx + 1);
    if (line.startsWith("data: ")) {
      payloads.push(line.slice("data: ".length));
    } else if (line.startsWith("data:")) {
      payloads.push(line.slice("data:".length));
    }
  }
  void url;
  return payloads;
}

async function expectChatStreamContract() {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${MOCK_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  });
  assert(res.status === 200, `chat stream: expected 200, got ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  assert(contentType.includes("text/event-stream"), `chat stream: expected SSE content-type, got ${contentType}`);

  const payloads = await readSseDataPayloads(CHAT_URL, res.body);

  // The first event is a role-only preamble: no content to accumulate.
  assert(payloads.length >= 2, `chat stream: expected several data events, got ${payloads.length}`);
  const first = JSON.parse(payloads[0]);
  assert(
    first.choices?.[0]?.delta?.role === "assistant" && !first.choices[0].delta.content,
    `chat stream: first event must be a role-only delta, got ${payloads[0]}`,
  );

  // The rest accumulate to the exact reply; the final payload is [DONE].
  const last = payloads[payloads.length - 1];
  assert(last.trim() === "[DONE]", `chat stream: expected final [DONE], got ${last}`);
  const contentPayloads = payloads.slice(1, -1);
  assert(
    contentPayloads.length === EXPECTED_CONTENT_CHUNKS,
    `chat stream: expected ${EXPECTED_CONTENT_CHUNKS} content deltas, got ${contentPayloads.length}`,
  );
  let accumulated = "";
  for (const payload of contentPayloads) {
    const event = JSON.parse(payload);
    const delta = event.choices?.[0]?.delta?.content;
    assert(typeof delta === "string" && delta.length > 0, `chat stream: empty delta in ${payload}`);
    accumulated += delta;
  }
  assert(
    accumulated === EXPECTED_REPLY,
    `chat stream: accumulated reply mismatch\n--- expected ---\n${EXPECTED_REPLY}\n--- got ---\n${accumulated}`,
  );
  console.log(
    `chat stream contract OK: role preamble ignored, ${contentPayloads.length} deltas accumulate to the exact reply (${accumulated.length} chars, multibyte split preserved), [DONE] last`,
  );
}

async function expectChatAuthAndStatusContract() {
  const noAuth = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true }),
  });
  assert(noAuth.status === 401, `chat without Bearer: expected 401, got ${noAuth.status}`);

  const wrongKey = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      authorization: "Bearer sk-wrong-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [], stream: true }),
  });
  assert(wrongKey.status === 401, `chat with wrong key: expected 401, got ${wrongKey.status}`);

  const rateLimited = await fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${MOCK_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "trigger-429", messages: [], stream: true }),
  });
  assert(rateLimited.status === 429, `trigger-429: expected 429, got ${rateLimited.status}`);

  const serverError = await fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${MOCK_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "trigger-500", messages: [], stream: true }),
  });
  assert(serverError.status === 500, `trigger-500: expected 500, got ${serverError.status}`);
  console.log("chat auth/status contract OK: 401 (missing/wrong key), 429, 500");
}

async function expectNonStreamFallback() {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${MOCK_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gemma4", messages: [], stream: false }),
  });
  assert(res.status === 200, `non-stream chat: expected 200, got ${res.status}`);
  const body = await res.json();
  assert(
    body.choices?.[0]?.message?.content === EXPECTED_REPLY,
    "non-stream chat: message content must equal the full reply",
  );
  console.log("non-stream fallback OK");
}

async function runCargoTest() {
  return new Promise((resolve) => {
    const child = spawn("cargo", ["test"], {
      cwd: path.join(ROOT, "src-tauri"),
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH ?? ""}`,
      },
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const server = spawn(process.execPath, [path.join(ROOT, "test", "mock-chat.mjs")], {
  stdio: "inherit",
});

let failed = false;
try {
  await waitForServer();
  await fetch(RESET_URL);

  await expectModelsContract();
  await expectChatStreamContract();
  await expectChatAuthAndStatusContract();
  await expectNonStreamFallback();

  console.log("running cargo test (chat + chat_store round-trips + full Rust suite)...");
  const cargoCode = await runCargoTest();
  if (cargoCode !== 0) {
    console.error(`cargo test failed with exit code ${cargoCode}`);
    failed = true;
  }
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  await fetch(RESET_URL).catch(() => {});
  server.kill("SIGTERM");
}

process.exit(failed ? 1 : 0);
