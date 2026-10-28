// T3 integration check (optional; the direct cargo/pnpm commands are the
// primary verification per the task).
//
// 1. Starts the mock OpenAI-compatible API (test/mock-api.mjs) and proves
//    its wire contract: GET /v1/models with `Bearer test-key-12345` → 200
//    with 3 models; a wrong or missing token → 401. This is the exact
//    contract the Rust `connection_test` command (pure classification) is
//    unit-tested against by `cargo test`.
// 2. Runs `cargo test` in src-tauri (profile store + connection-test pure
//    logic) and asserts it passed.
//
// Usage: node test/t3-check.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 14322;
const MODELS_URL = `http://${HOST}:${PORT}/v1/models`;
const TOKEN = "test-key-12345"; // mock fixture, not a real credential
const EXPECTED_MODELS = 3;

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
  throw new Error(`mock API did not come up at ${MODELS_URL}`);
}

async function expectModels(status) {
  const res = await fetch(MODELS_URL, {
    headers: status === "ok" ? { authorization: `Bearer ${TOKEN}` } : {},
  });
  const body = await res.json();
  if (status === "ok") {
    if (res.status !== 200) {
      throw new Error(`expected 200 with valid token, got ${res.status}`);
    }
    const count = body?.data?.length;
    if (count !== EXPECTED_MODELS) {
      throw new Error(`expected ${EXPECTED_MODELS} models, got ${count}`);
    }
    return `200 with ${count} models`;
  }
  if (res.status !== 401) {
    throw new Error(`expected 401 without token, got ${res.status}`);
  }
  return "401 without token";
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

const server = spawn(process.execPath, [path.join(ROOT, "test", "mock-api.mjs")], {
  stdio: "inherit",
});

let failed = false;
try {
  await waitForServer();

  const ok = await expectModels("ok");
  console.log(`mock API OK: GET /v1/models + valid bearer → ${ok}`);
  const rejected = await expectModels("unauthorized");
  console.log(`mock API OK: GET /v1/models without bearer → ${rejected}`);

  console.log("running cargo test (profile store + connection-test logic)...");
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
