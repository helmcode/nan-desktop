// Minimal dependency-free mock of the platform device-flow endpoints (T13),
// mirroring the real backend contract (cloud-api auth_device.go PR #411 /
// enterprise-api auth_device.go PR #105):
//
//   POST /api/auth/device/start   → {device_code, user_code, verification_url,
//                                    expires_in, interval}   (no-store)
//   POST /api/auth/device/poll    → {"status":"pending"} for the first 2
//                                    polls, then approved exactly once with
//                                    {session_token, api_key, key_alias};
//                                    afterwards {"status":"expired"}.
//                                    Polling faster than MOCK_POLL_INTERVAL_MS
//                                    answers 429 + Retry-After (slow_down).
//                                    {"status":"denied"} after a deny.
//   GET  /api/auth/device         → static approval-page stub (auto-approve)
//   POST /api/auth/device/approve → 200 ok (approval is automatic by count)
//   POST /api/auth/device/deny    → marks the request denied
//   GET  /reset                   → clears all in-memory state
//
// Usage: node test/mock-device.mjs

import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = 14322;
const BASE = `http://${HOST}:${PORT}`;

// Fixture credentials (not real). The api_key/session_token shapes are what
// the Rust core maps into the OS keychain (api_key → account "<profile-id>",
// session_token → account "<profile-id>.session").
const SESSION_TOKEN = "fake-jwt";
const API_KEY = "sk-test-1234567890abcdef";
const KEY_ALIAS = "mock-member.dt-0a1b2c3d";

const PENDING_POLLS_BEFORE_APPROVAL = 2;
const MOCK_POLL_INTERVAL_MS = 200;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// device_code → { userCode, polls, lastPollAt, status, issuedAt }
const requests = new Map();

function randomChars(count) {
  let out = "";
  for (let i = 0; i < count; i += 1) {
    out += USER_CODE_ALPHABET[Math.floor(Math.random() * USER_CODE_ALPHABET.length)];
  }
  return out;
}

function newUserCode() {
  return `${randomChars(4)}-${randomChars(4)}`;
}

function newDeviceCode() {
  return randomChars(43); // base64url-style length, mock material only
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

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE);

  if (req.method === "POST" && url.pathname === "/api/auth/device/start") {
    await readBody(req);
    const deviceCode = newDeviceCode();
    requests.set(deviceCode, {
      userCode: newUserCode(),
      polls: 0,
      lastPollAt: 0,
      status: "pending",
      issuedAt: Date.now(),
    });
    sendJson(res, 200, {
      device_code: deviceCode,
      user_code: requests.get(deviceCode).userCode,
      verification_url: `${BASE}/api/auth/device`,
      expires_in: 900,
      interval: 1,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/device/poll") {
    const raw = await readBody(req);
    let deviceCode = "";
    try {
      deviceCode = JSON.parse(raw).device_code ?? "";
    } catch {
      deviceCode = "";
    }
    const request = requests.get(deviceCode);
    if (!deviceCode || !request) {
      sendJson(res, 400, { error: "invalid device_code" });
      return;
    }
    // Enforce the advertised interval like the real backends (slow_down).
    const sinceLast = Date.now() - request.lastPollAt;
    if (sinceLast < MOCK_POLL_INTERVAL_MS) {
      sendJson(
        res,
        429,
        { error: "slow_down — poll at the advertised interval" },
        { "retry-after": "1" },
      );
      return;
    }
    request.lastPollAt = Date.now();
    request.polls += 1;
    if (request.status === "denied") {
      sendJson(res, 200, { status: "denied" });
      return;
    }
    if (request.status === "consumed") {
      // Credentials were shown exactly once (real contract).
      sendJson(res, 200, { status: "expired" });
      return;
    }
    if (request.polls <= PENDING_POLLS_BEFORE_APPROVAL) {
      sendJson(res, 200, { status: "pending" });
      return;
    }
    // Auto-approve: first winning poll claims the request.
    request.status = "consumed";
    sendJson(res, 200, {
      status: "approved",
      session_token: SESSION_TOKEN,
      api_key: API_KEY,
      key_alias: KEY_ALIAS,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/device") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Approve device — mock</title></head>` +
        `<body><h1>Mock approval page</h1><p>This mock auto-approves a request after ` +
        `${PENDING_POLLS_BEFORE_APPROVAL} polls. To exercise the denied path, POST the ` +
        `device_code to /api/auth/device/deny.</p></body></html>`,
    );
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/device/approve") {
    await readBody(req);
    sendJson(res, 200, { ok: true, note: "approval is automatic in this mock" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/device/deny") {
    const raw = await readBody(req);
    let denied = 0;
    // Accept either the device_code or the user_code in JSON.
    try {
      const body = JSON.parse(raw);
      for (const request of requests.values()) {
        if (body.device_code && requests.get(body.device_code) === request) {
          request.status = "denied";
          denied += 1;
        } else if (body.user_code && request.userCode === body.user_code) {
          request.status = "denied";
          denied += 1;
        }
      }
    } catch {
      denied = 0;
    }
    if (denied === 0) {
      sendJson(res, 400, { error: "no matching pending request" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/reset") {
    requests.clear();
    sendJson(res, 200, { ok: true });
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`mock device platform listening on ${BASE}/api/auth/device/*`);
});
