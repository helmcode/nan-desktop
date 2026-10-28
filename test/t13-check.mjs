// T13 integration check (optional; the direct cargo/pnpm commands are the
// primary verification per the task).
//
// 1. Starts the mock device-flow platform (test/mock-device.mjs) and proves
//    its wire contract — the exact contract the Rust `PollStateMachine`
//    (src-tauri/src/device_flow.rs) is unit-tested against:
//      start  → {device_code, user_code "XXXX-XXXX", verification_url,
//                expires_in, interval}
//      poll   → pending, pending, then approved exactly once with
//               {session_token, api_key, key_alias} — the three credential
//               fields the Rust core stores in the OS keychain (api_key under
//               account "<profile-id>", session_token under
//               "<profile-id>.session"); the next poll reads expired
//      poll   → 429 slow_down with Retry-After when polled too fast
//      deny   → {"status":"denied"}
// 2. Runs `cargo test` (poll state machine + profile lockdown suites).
//
// Usage: node test/t13-check.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 14322;
const BASE = `http://${HOST}:${PORT}`;
const START_URL = `${BASE}/api/auth/device/start`;
const POLL_URL = `${BASE}/api/auth/device/poll`;
const PAGE_URL = `${BASE}/api/auth/device`;
const RESET_URL = `${BASE}/reset`;
const MOCK_POLL_INTERVAL_MS = 200; // must match mock-device.mjs
const PENDING_POLLS = 2; // must match mock-device.mjs
const SESSION_TOKEN = "fake-jwt"; // must match mock-device.mjs
const API_KEY = "sk-test-1234567890abcdef"; // must match mock-device.mjs

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
  throw new Error(`mock device platform did not come up at ${START_URL}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startLogin() {
  const res = await fetch(START_URL, { method: "POST" });
  assert(res.status === 200, `start: expected 200, got ${res.status}`);
  const body = await res.json();
  assert(typeof body.device_code === "string" && body.device_code.length > 0, "start: device_code missing");
  assert(/^([A-Z2-9]{4})-([A-Z2-9]{4})$/.test(body.user_code), `start: user_code not XXXX-XXXX (${body.user_code})`);
  assert(body.verification_url === PAGE_URL, `start: unexpected verification_url ${body.verification_url}`);
  assert(Number.isFinite(body.expires_in) && body.expires_in > 0, "start: expires_in missing");
  assert(Number.isFinite(body.interval) && body.interval > 0, "start: interval missing");
  return body;
}

async function poll(deviceCode) {
  const res = await fetch(POLL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.json() };
}

async function expectWireContract() {
  // Start → page → pending ×2 → approved exactly once → expired.
  const start = await startLogin();
  const page = await fetch(PAGE_URL);
  assert(page.status === 200, `approval page: expected 200, got ${page.status}`);
  assert((await page.text()).includes("Mock approval page"), "approval page: unexpected body");

  for (let i = 0; i < PENDING_POLLS; i += 1) {
    await sleep(MOCK_POLL_INTERVAL_MS + 50);
    const result = await poll(start.device_code);
    assert(result.status === 200 && result.body.status === "pending", `poll ${i + 1}: expected pending, got ${result.status} ${JSON.stringify(result.body)}`);
  }

  await sleep(MOCK_POLL_INTERVAL_MS + 50);
  const approved = await poll(start.device_code);
  assert(approved.status === 200 && approved.body.status === "approved", `poll: expected approved, got ${approved.status} ${JSON.stringify(approved.body)}`);
  // The approved payload must carry exactly the credential fields the Rust
  // core stores in the OS keychain — session_token + api_key + key_alias.
  assert(approved.body.session_token === SESSION_TOKEN, "approved: session_token mismatch");
  assert(approved.body.api_key === API_KEY, "approved: api_key mismatch");
  assert(typeof approved.body.key_alias === "string" && approved.body.key_alias.length > 0, "approved: key_alias missing");

  await sleep(MOCK_POLL_INTERVAL_MS + 50);
  const consumed = await poll(start.device_code);
  assert(consumed.status === 200 && consumed.body.status === "expired", `poll after claim: expected expired, got ${consumed.status} ${JSON.stringify(consumed.body)}`);

  console.log("wire contract OK: start → page → pending×2 → approved once → expired");
}

async function expectSlowDown() {
  await fetch(RESET_URL);
  const start = await startLogin();
  // Two back-to-back polls: the second violates the advertised interval.
  await poll(start.device_code);
  const fast = await poll(start.device_code);
  assert(fast.status === 429, `fast poll: expected 429 slow_down, got ${fast.status}`);
  assert(fast.retryAfter !== null && Number(fast.retryAfter) > 0, "429: Retry-After header missing");
  console.log(`wire contract OK: fast poll → 429 slow_down (Retry-After: ${fast.retryAfter})`);

  // Deny path: the next poll (after backing off) must read denied.
  await sleep(MOCK_POLL_INTERVAL_MS + 50);
  const deny = await fetch(`${BASE}/api/auth/device/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_code: start.device_code }),
  });
  assert(deny.status === 200, `deny: expected 200, got ${deny.status}`);
  await sleep(MOCK_POLL_INTERVAL_MS + 50);
  const denied = await poll(start.device_code);
  assert(denied.status === 200 && denied.body.status === "denied", `poll after deny: expected denied, got ${denied.status} ${JSON.stringify(denied.body)}`);
  console.log("wire contract OK: deny → poll reads denied");
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

const server = spawn(process.execPath, [path.join(ROOT, "test", "mock-device.mjs")], {
  stdio: "inherit",
});

let failed = false;
try {
  await waitForServer();
  await fetch(RESET_URL);

  await expectWireContract();
  await expectSlowDown();

  console.log("running cargo test (poll state machine + profile lockdown)...");
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
