// T4b integration check (streaming resilience; the direct cargo/pnpm
// commands are the primary verification per the task).
//
// Starts the mock inference server (test/mock-chat.mjs) and proves the two
// halves of the T4b contract:
//
//   1. Stop transport contract — model "trigger-slow-stream" streams one
//      delta every 200 ms and NEVER finishes (no [DONE]); a client that
//      aborts its read mid-stream is seen by the server as exactly one
//      premature disconnect, after several deltas arrived. That is exactly
//      what the Rust `chat_stop` command + frontend stop button do to a
//      live stream.
//   2. /reset clears the recorded stats (deltasSent, clientDisconnects).
//   3. `cargo test` runs the full Rust suite, including the T4b unit tests
//      that pin the store-level guarantees: the kill simulation (partial
//      text persisted without done), the stop finalize (text kept, no
//      failed marker), the `partial` flag in messages_list, the legacy
//      (pre-T4b) schema migration, and the stop registry (abort_stream).
//
// Usage: node test/t4b-check.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 14323;
const BASE = `http://${HOST}:${PORT}`;
const CHAT_URL = `${BASE}/v1/chat/completions`;
const RESET_URL = `${BASE}/reset`;
const STATS_URL = `${BASE}/__stats__`;

const MOCK_KEY = "sk-test-1234567890abcdef"; // must match mock-chat.mjs / mock-device.mjs

// Read budget for the slow stream: long enough for several 200 ms deltas.
const SLOW_READ_MS = 1500;
const MIN_DELTAS = 3;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForServer(attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await fetch(`${BASE}/__probe__`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`mock chat inference did not come up at ${CHAT_URL}`);
}

// Read the SSE body for at most `ms` milliseconds, extracting content deltas
// from complete `data:` lines (partial lines across reads stay buffered).
// The returned promise always resolves on the deadline — the caller then
// aborts the fetch to simulate the stop button.
async function readDeltasFor(body, ms) {
  const deltas = [];
  let raw = Buffer.alloc(0);
  const reader = body.getReader();
  const deadline = Date.now() + ms;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const chunkPromise = reader.read();
    // Never leave an aborted read rejection unhandled.
    chunkPromise.catch(() => {});
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(null), remaining));
    const step = await Promise.race([chunkPromise, timeoutPromise]);
    if (step === null) break; // deadline hit — caller aborts below
    const { done, value } = step;
    if (done) break;
    raw = Buffer.concat([raw, Buffer.from(value)]);
    for (;;) {
      const idx = raw.indexOf(0x0a); // '\n'
      if (idx === -1) break;
      const line = raw.slice(0, idx).toString("utf8");
      raw = raw.slice(idx + 1);
      if (!line.startsWith("data: ")) continue;
      try {
        const delta = JSON.parse(line.slice("data: ".length))?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) deltas.push(delta);
      } catch {
        // Only complete lines are parsed; nothing else to do.
      }
    }
  }
  return deltas;
}

async function expectSlowStreamDisconnectContract() {
  const controller = new AbortController();
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${MOCK_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "trigger-slow-stream",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
    signal: controller.signal,
  });
  assert(res.status === 200, `slow stream: expected 200, got ${res.status}`);
  assert(
    (res.headers.get("content-type") ?? "").includes("text/event-stream"),
    `slow stream: expected SSE content-type, got ${res.headers.get("content-type")}`,
  );

  const deltas = await readDeltasFor(res.body, SLOW_READ_MS);
  assert(
    deltas.length >= MIN_DELTAS,
    `slow stream: expected at least ${MIN_DELTAS} deltas in ${SLOW_READ_MS} ms, got ${deltas.length}`,
  );
  for (const delta of deltas) {
    assert(
      delta.startsWith("chunk "),
      `slow stream: unexpected delta payload ${JSON.stringify(delta)}`,
    );
  }

  // The stop path: abort the read mid-stream — exactly what aborting the
  // stream task does to the HTTP response.
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const stats = await (await fetch(STATS_URL)).json();
  assert(
    Number.isInteger(stats.deltasSent) && stats.deltasSent >= deltas.length,
    `slow stream: server wrote ${stats.deltasSent} deltas, we read ${deltas.length}`,
  );
  assert(
    stats.clientDisconnects === 1,
    `slow stream: the client abort must be seen as exactly one disconnect, got ${stats.clientDisconnects}`,
  );
  console.log(
    `slow-stream stop contract OK: ${deltas.length} deltas read, server wrote ${stats.deltasSent}, client abort = exactly one server-side disconnect (stream never finished)`,
  );
}

async function expectResetClearsStats() {
  await fetch(RESET_URL);
  const stats = await (await fetch(STATS_URL)).json();
  assert(
    stats.deltasSent === 0 && stats.clientDisconnects === 0,
    `reset: stats must be cleared, got ${JSON.stringify(stats)}`,
  );
  console.log("reset contract OK: recorded stats cleared");
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

  await expectSlowStreamDisconnectContract();
  await expectResetClearsStats();

  console.log("running cargo test (T4b persistence/stop/partial unit tests + full Rust suite)...");
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
