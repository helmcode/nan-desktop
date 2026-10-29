// T5 integration check (optional; the direct cargo/pnpm commands are the
// primary verification per the task).
//
// Starts the mock image server (test/mock-images.mjs) and proves the wire
// contract the Rust core (src-tauri/src/images.rs) is unit-tested against:
//
//   1. Generation contract — POST /v1/images/generations with
//      {model:"qwen-image-2.1", prompt, size:"1024x1024"} answers the OpenAI
//      images shape whose `b64_json` decodes to bytes starting with the
//      8-byte PNG signature; /record exposes the exact request shape
//      (never the key).
//   2. Size guard — invalid sizes ("100x100", "1024x1023" (not a multiple
//      of 16), "1300x1024" (over the 1280 cap), "abc") are rejected 400 by
//      the server; the Rust core rejects them locally BEFORE any request
//      (`validate_size`, kind protocol — pinned by unit tests in the cargo
//      suite).
//   3. Classification — 401 without/wrong Bearer, 429 via the
//      `x-nan-test-429` header (the tenant's monthly image quota) and via
//      model "trigger-429", 500 via "trigger-500" (what the Rust core maps
//      to unauthorized / rate_limited / server).
//   4. No `url` replies — the mock serves b64_json only. A `url` reply
//      would point at an arbitrary remote host and is rejected with kind
//      `protocol` (S12: no third-party endpoints); that rejection is pinned
//      by Rust unit tests, run at the end.
//   5. cargo test — the full Rust suite (all previous tasks' tests included)
//      must stay green.
//
// Usage: node test/t5-check.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 14325;
const BASE = `http://${HOST}:${PORT}`;
const GENERATIONS_URL = `${BASE}/v1/images/generations`;
const RESET_URL = `${BASE}/reset`;

const MOCK_KEY = "sk-test-1234567890abcdef"; // must match mock-images.mjs
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  throw new Error(`mock image inference did not come up at ${BASE}`);
}

function generationRequest(withAuth, key, body, extraHeaders = {}) {
  return {
    method: "POST",
    headers: {
      ...(withAuth ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

// --- 1. Generation contract ---------------------------------------------------

async function expectGenerationContract() {
  const res = await fetch(
    GENERATIONS_URL,
    generationRequest(true, MOCK_KEY, {
      model: "qwen-image-2.1",
      prompt: "a cat on a roof at dusk",
      size: "1024x1024",
    }),
  );
  assert(res.status === 200, `generations: expected 200, got ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body.data) && body.data.length === 1, "generations: expected one data item");
  const b64 = body.data[0].b64_json;
  assert(typeof b64 === "string" && b64.length > 0, "generations: expected a b64_json string");
  assert(
    body.data[0].url === undefined,
    "generations: the mock must never serve a url reply (S12 — the app rejects it)",
  );
  const png = Buffer.from(b64, "base64");
  assert(png.length > 8, `generations: PNG too short (${png.length} bytes)`);
  assert(
    png.subarray(0, 8).equals(PNG_SIGNATURE),
    "generations: decoded payload does not start with the PNG signature",
  );
  console.log(`generation contract OK: ${png.length}-byte PNG (signature verified) from b64_json`);

  const record = await (await fetch(`${BASE}/record`)).json();
  assert(record.generation, "record: generation was not recorded");
  assert(
    record.generation.model === "qwen-image-2.1",
    `record: expected model qwen-image-2.1, got ${record.generation.model}`,
  );
  assert(
    record.generation.prompt === "a cat on a roof at dusk",
    `record: unexpected prompt ${JSON.stringify(record.generation.prompt)}`,
  );
  assert(
    record.generation.size === "1024x1024",
    `record: expected size 1024x1024, got ${record.generation.size}`,
  );
  assert(
    record.generation.authorization === undefined,
    "record: the key must never be recorded",
  );
  console.log("generation record OK: model/prompt/size preserved, key never recorded");
}

// --- 2. Size guard ------------------------------------------------------------

async function expectSizeGuardContract() {
  for (const size of ["100x100", "1024x1023", "1300x1024", "abc", "1024", "1024X1024"]) {
    const res = await fetch(
      GENERATIONS_URL,
      generationRequest(true, MOCK_KEY, { model: "qwen-image-2.1", prompt: "x", size }),
    );
    assert(res.status === 400, `size ${size}: expected 400, got ${res.status}`);
  }
  // A valid non-default size still answers 200.
  const ok = await fetch(
    GENERATIONS_URL,
    generationRequest(true, MOCK_KEY, {
      model: "qwen-image-2.1",
      prompt: "x",
      size: "1280x768",
    }),
  );
  assert(ok.status === 200, `size 1280x768: expected 200, got ${ok.status}`);
  console.log("size guard OK: out-of-bounds / non-multiple-of-16 / malformed sizes rejected 400");
}

// --- 3. Classification ----------------------------------------------------------

async function expectClassificationContract() {
  const noAuth = await fetch(
    GENERATIONS_URL,
    generationRequest(false, MOCK_KEY, { model: "qwen-image-2.1", prompt: "x", size: "1024x1024" }),
  );
  assert(noAuth.status === 401, `without Bearer: expected 401, got ${noAuth.status}`);
  const wrongKey = await fetch(
    GENERATIONS_URL,
    generationRequest(true, "sk-wrong-key", { model: "qwen-image-2.1", prompt: "x", size: "1024x1024" }),
  );
  assert(wrongKey.status === 401, `with wrong key: expected 401, got ${wrongKey.status}`);
  console.log("classification OK: 401 (missing/wrong key)");

  // 429 — the monthly image quota, via header and via trigger model.
  const quotaHeader = await fetch(
    GENERATIONS_URL,
    generationRequest(
      true,
      MOCK_KEY,
      { model: "qwen-image-2.1", prompt: "x", size: "1024x1024" },
      { "x-nan-test-429": "1" },
    ),
  );
  assert(quotaHeader.status === 429, `quota header: expected 429, got ${quotaHeader.status}`);
  const quotaModel = await fetch(
    GENERATIONS_URL,
    generationRequest(true, MOCK_KEY, { model: "trigger-429", prompt: "x", size: "1024x1024" }),
  );
  assert(quotaModel.status === 429, `trigger-429: expected 429, got ${quotaModel.status}`);
  console.log("classification OK: 429 via x-nan-test-429 header and trigger-429 model (quota)");

  const serverError = await fetch(
    GENERATIONS_URL,
    generationRequest(true, MOCK_KEY, { model: "trigger-500", prompt: "x", size: "1024x1024" }),
  );
  assert(serverError.status === 500, `trigger-500: expected 500, got ${serverError.status}`);
  console.log("classification OK: 500 via trigger-500 model");

  const unknownModel = await fetch(
    GENERATIONS_URL,
    generationRequest(true, MOCK_KEY, { model: "flux-2-klein", prompt: "x", size: "1024x1024" }),
  );
  assert(unknownModel.status === 400, `unknown model: expected 400, got ${unknownModel.status}`);
  const emptyPrompt = await fetch(
    GENERATIONS_URL,
    generationRequest(true, MOCK_KEY, { model: "qwen-image-2.1", prompt: "   ", size: "1024x1024" }),
  );
  assert(emptyPrompt.status === 400, `empty prompt: expected 400, got ${emptyPrompt.status}`);
  console.log("body guard OK: unknown model and empty prompt rejected 400");
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

const server = spawn(process.execPath, [path.join(ROOT, "test", "mock-images.mjs")], {
  stdio: "inherit",
});

let failed = false;
try {
  await waitForServer();
  await fetch(RESET_URL);

  await expectGenerationContract();
  await fetch(RESET_URL); // isolate the guard assertions from the contract request
  await expectSizeGuardContract();
  await expectClassificationContract();

  console.log("running cargo test (image core + full Rust suite)...");
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
