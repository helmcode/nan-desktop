// T6 integration check (optional; the direct cargo/pnpm commands are the
// primary verification per the task).
//
// Starts the mock voice server (test/mock-voice.mjs) and proves the wire
// contract the Rust audio cores (src-tauri/src/tts.rs, src-tauri/src/stt.rs)
// are unit-tested against:
//
//   1. WAV decode — POST /v1/audio/speech answers a byte-level valid PCM16
//      mono 22050 Hz WAV (RIFF/WAVE, fmt, data chunk sizes consistent): the
//      exact shape the Rust `decode_wav` unit tests decode in memory. The
//      in-memory decode itself is pinned by cargo tests, run at the end.
//   2. Size guard — a transcription upload over 25 MiB is rejected 413 by
//      the server; the Rust core rejects it locally BEFORE any upload
//      (`validate_audio`, kind protocol — pinned by unit tests in the cargo
//      suite).
//   3. Multipart shape — a real multipart upload parses into a `model`
//      field ("whisper") and a `file` part with filename, content-type and
//      the exact byte size; /record exposes the shape (never the bytes).
//   4. Classification — 401 without/wrong Bearer, 429 and 500 on the
//      trigger models, for both /audio/speech and /audio/transcriptions
//      (what the Rust cores map to unauthorized / rate_limited / server).
//   5. cargo test — the full Rust suite (all previous tasks' tests included)
//      must stay green.
//
// Usage: node test/t6-check.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 14324;
const BASE = `http://${HOST}:${PORT}`;
const SPEECH_URL = `${BASE}/v1/audio/speech`;
const STT_URL = `${BASE}/v1/audio/transcriptions`;
const RESET_URL = `${BASE}/reset`;

const MOCK_KEY = "sk-test-1234567890abcdef"; // must match mock-voice.mjs

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
  throw new Error(`mock voice inference did not come up at ${BASE}`);
}

// Synthesize the same tiny WAV the Rust unit tests and the mock build
// (PCM16 mono 22050 Hz) — used as a dictation upload payload.
function tinyWav(samples) {
  const dataLen = samples * 2;
  const wav = Buffer.alloc(44 + dataLen);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataLen, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(22050, 24);
  wav.writeUInt32LE(44100, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples; i += 1) {
    wav.writeInt16LE((((i % 64) - 32) * 512) | 0, 44 + i * 2);
  }
  return wav;
}

// --- 1. WAV decode contract -------------------------------------------------

async function expectSpeechWavContract() {
  const res = await fetch(SPEECH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${MOCK_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "kokoro",
      voice: "ef_dora",
      input: "Hola mundo",
      response_format: "wav",
    }),
  });
  assert(res.status === 200, `speech: expected 200, got ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "";
  assert(contentType.includes("audio/wav"), `speech: expected audio/wav, got ${contentType}`);

  const wav = Buffer.from(await res.arrayBuffer());
  assert(wav.length > 44, `speech: WAV too short (${wav.length} bytes)`);
  assert(wav.subarray(0, 4).toString("ascii") === "RIFF", "speech: RIFF magic missing");
  assert(wav.subarray(8, 12).toString("ascii") === "WAVE", "speech: WAVE magic missing");
  assert(wav.readUInt32LE(4) === wav.length - 8, "speech: RIFF size mismatch");
  assert(wav.subarray(12, 16).toString("ascii") === "fmt ", "speech: fmt chunk missing");
  assert(wav.readUInt16LE(20) === 1, "speech: expected PCM format");
  assert(wav.readUInt16LE(22) === 1, "speech: expected mono");
  assert(wav.readUInt32LE(24) === 22050, "speech: expected 22050 Hz");
  assert(wav.readUInt16LE(34) === 16, "speech: expected 16 bits per sample");
  assert(wav.subarray(36, 40).toString("ascii") === "data", "speech: data chunk missing");
  assert(
    wav.readUInt32LE(40) === wav.length - 44,
    "speech: data chunk size mismatch",
  );
  console.log(
    `speech WAV contract OK: ${wav.length} bytes, PCM16 mono 22050 Hz, consistent chunk sizes`,
  );

  // Invalid bodies are rejected (the Rust core validates the voice before
  // any request; the mock pins the server-side contract too).
  const badVoice = await fetch(SPEECH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${MOCK_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "kokoro", voice: "ef_nobody", input: "x", response_format: "wav" }),
  });
  assert(badVoice.status === 400, `speech with unknown voice: expected 400, got ${badVoice.status}`);
  const badFormat = await fetch(SPEECH_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${MOCK_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "kokoro", voice: "ef_dora", input: "x", response_format: "mp3" }),
  });
  assert(badFormat.status === 400, `speech with mp3 format: expected 400, got ${badFormat.status}`);
  console.log("speech body contract OK: unknown voice and non-wav format rejected 400");
}

// --- 4. Classification (both endpoints) -------------------------------------

async function expectClassification(url, build) {
  const noAuth = await fetch(url, build(false, MOCK_KEY));
  assert(noAuth.status === 401, `${url}: without Bearer expected 401, got ${noAuth.status}`);
  const wrongKey = await fetch(url, build(true, "sk-wrong-key"));
  assert(wrongKey.status === 401, `${url}: with wrong key expected 401, got ${wrongKey.status}`);
  const rateLimited = await fetch(url, build(true, MOCK_KEY, "trigger-429"));
  assert(rateLimited.status === 429, `${url}: trigger-429 expected 429, got ${rateLimited.status}`);
  const serverError = await fetch(url, build(true, MOCK_KEY, "trigger-500"));
  assert(serverError.status === 500, `${url}: trigger-500 expected 500, got ${serverError.status}`);
}

function speechRequest(withAuth, key, model = "kokoro") {
  return {
    method: "POST",
    headers: {
      ...(withAuth ? { authorization: `Bearer ${key}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, voice: "ef_dora", input: "hola", response_format: "wav" }),
  };
}

function transcriptionRequest(withAuth, key, model = "whisper") {
  const form = new FormData();
  form.append("model", model);
  form.append("file", new Blob([tinyWav(100)], { type: "audio/wav" }), "audio.wav");
  return {
    method: "POST",
    headers: withAuth ? { authorization: `Bearer ${key}` } : {},
    body: form,
  };
}

// --- 3. Multipart shape ------------------------------------------------------

async function expectMultipartShapeContract() {
  const payload = Buffer.from("fake-opus-frames-Ñ-😀");
  const form = new FormData();
  form.append("model", "whisper");
  form.append("file", new Blob([payload], { type: "audio/webm" }), "audio.webm");
  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${MOCK_KEY}` },
    body: form,
  });
  assert(res.status === 200, `transcription: expected 200, got ${res.status}`);
  const body = await res.json();
  assert(
    body.text === `Mock transcription of ${payload.length} bytes`,
    `transcription: unexpected reply ${JSON.stringify(body)}`,
  );

  const record = await (await fetch(`${BASE}/record`)).json();
  const upload = record.transcription;
  assert(upload, "record: transcription upload was not recorded");
  assert(upload.model === "whisper", `record: expected model=whisper, got ${upload.model}`);
  assert(upload.filename === "audio.webm", `record: expected filename audio.webm, got ${upload.filename}`);
  assert(
    (upload.contentType ?? "").startsWith("audio/webm"),
    `record: expected content-type audio/webm, got ${upload.contentType}`,
  );
  assert(
    upload.size === payload.length,
    `record: expected ${payload.length} bytes, got ${upload.size}`,
  );
  assert(
    (upload.extraParts ?? []).length === 0,
    `record: unexpected extra parts ${JSON.stringify(upload.extraParts)}`,
  );
  console.log(
    "transcription multipart shape OK: model=whisper + file (audio.webm, exact byte size preserved)",
  );
}

// --- 2. Size guard ------------------------------------------------------------

async function expectSizeGuardContract() {
  const over = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
  const form = new FormData();
  form.append("model", "whisper");
  form.append("file", new Blob([over], { type: "audio/webm" }), "audio.webm");
  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${MOCK_KEY}` },
    body: form,
  });
  assert(res.status === 413, `oversized upload: expected 413, got ${res.status}`);
  const record = await (await fetch(`${BASE}/record`)).json();
  assert(
    record.transcription === null,
    "record: the oversized upload must not be recorded as served (rejected 413)",
  );
  console.log(
    "size guard OK: >25 MiB upload rejected 413 by the server (the Rust core rejects it locally first — validate_audio unit tests)",
  );
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

const server = spawn(process.execPath, [path.join(ROOT, "test", "mock-voice.mjs")], {
  stdio: "inherit",
});

let failed = false;
try {
  await waitForServer();
  await fetch(RESET_URL);

  await expectSpeechWavContract();
  await expectClassification(SPEECH_URL, speechRequest);
  console.log("speech classification OK: 401 (missing/wrong key), 429, 500");
  await expectClassification(STT_URL, transcriptionRequest);
  console.log("transcription classification OK: 401 (missing/wrong key), 429, 500");
  await expectMultipartShapeContract();
  await fetch(RESET_URL); // isolate the size-guard assertion from the shape upload
  await expectSizeGuardContract();

  console.log("running cargo test (voice cores + full Rust suite)...");
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
