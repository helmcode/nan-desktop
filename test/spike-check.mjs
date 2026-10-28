// T1 spike integration check (optional; the direct cargo/pnpm commands are
// the primary verification per the task).
//
// 1. Starts the mock SSE server (test/mock-sse.mjs) and consumes
//    GET /events to prove the wire format the Rust parser must handle.
// 2. Runs `cargo test` in src-tauri (SSE parser + SQLite unit tests) and
//    asserts it passed.
//
// Usage: node test/spike-check.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 14321;
const EVENTS_URL = `http://${HOST}:${PORT}/events`;
const TOTAL_CHUNKS = 5;

async function waitForServer(attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      // Any HTTP response (even our 404) proves the server is listening.
      await fetch(`http://${HOST}:${PORT}/__probe__`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`mock server did not come up at ${EVENTS_URL}`);
}

async function consumeEventStream() {
  const res = await fetch(EVENTS_URL);
  if (!res.ok || !res.body) {
    throw new Error(`unexpected response: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunks = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Same wire contract the Rust parser implements: blank-line-delimited
    // `data:` events.
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of event.split("\n")) {
        if (line.startsWith("data:")) {
          chunks.push(line.slice("data:".length).replace(/^ /, ""));
        }
      }
    }
  }
  return chunks;
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

const server = spawn(process.execPath, [path.join(ROOT, "test", "mock-sse.mjs")], {
  stdio: "inherit",
});

let failed = false;
try {
  await waitForServer();

  const chunks = await consumeEventStream();
  const expected = Array.from({ length: TOTAL_CHUNKS }, (_, i) => `chunk ${i + 1}`);
  const mockOk =
    chunks.length === expected.length && chunks.every((c, i) => c === expected[i]);
  if (mockOk) {
    console.log(`mock SSE stream OK: received ${chunks.length} chunks in order`);
  } else {
    console.error(`mock SSE stream MISMATCH: got ${JSON.stringify(chunks)}`);
    failed = true;
  }

  console.log("running cargo test (SSE parser + SQLite unit tests)...");
  const cargoCode = await runCargoTest();
  if (cargoCode !== 0) {
    console.error(`cargo test failed with exit code ${cargoCode}`);
    failed = true;
  }
} catch (err) {
  console.error(err);
  failed = true;
} finally {
  server.kill("SIGTERM");
}

process.exit(failed ? 1 : 0);
