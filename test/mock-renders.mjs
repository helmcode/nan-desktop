// Minimal dependency-free mock of the desktop render routes (R-V1, shared
// contract §2 and its amendment), mounted by mock-device.mjs so the whole
// platform mock lives on one base (NAN_DESKTOP_MOCK_PLATFORM):
//
//   POST /v1/desktop/renders           multipart: `meta` (JSON) + `bundle`
//                                      (a zip: must start with PK\x03\x04,
//                                      <= 90 MiB). Checks `Authorization:
//                                      Bearer fake-jwt`. -> 202 {id, status:
//                                      "queued", charge_seconds}
//                                      Errors: 401, 402 render_quota_exhausted
//                                      {remaining_seconds, period_end} when
//                                      ceil(duration_s) > remaining, 402
//                                      subscription_required (title
//                                      "trigger-402"), 413 bundle_too_large,
//                                      422 invalid_meta / invalid_bundle, 429
//                                      too_many_active_renders (> 2 active) or
//                                      rate_limited (title "trigger-429"),
//                                      503 busy (title "trigger-busy") /
//                                      storage_unavailable ("trigger-503"),
//                                      both with Retry-After (contract §4).
//   GET  /v1/desktop/renders/quota     {included_seconds, used_seconds,
//                                      remaining_seconds, period_end}
//   GET  /v1/desktop/renders/{id}      queued -> rendering (progress) -> done
//                                      over ~8 s, with a presigned-style
//                                      download_url on this server (plain http
//                                      on 127.0.0.1: debug builds with the mock
//                                      platform accept loopback http). Title
//                                      "trigger-fail" ends failed
//                                      (render_failed).
//   POST /v1/desktop/renders/{id}/cancel  204 (refunds; a finished render is
//                                      a no-op)
//   GET  /files/{id}.mp4               the "rendered" MP4 (a tiny ftyp-headed
//                                      file; not playable media)
//
// Standalone: node test/mock-renders.mjs (port 14330).

import { createServer } from "node:http";

const SESSION_TOKEN = "fake-jwt";
const INCLUDED_SECONDS = Number(process.env.MOCK_RENDER_SECONDS || 7200);
const MAX_BUNDLE = 90 * 1024 * 1024;
const RENDER_MS = 8000;

const renders = new Map();
let used = 0;
let createdThisHour = [];

function json(res, status, payload, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(payload === undefined ? "" : JSON.stringify(payload));
}

function readBody(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) over = true;
      else chunks.push(c);
    });
    req.on("end", () => resolve({ body: Buffer.concat(chunks), over }));
  });
}

/// The parts of a multipart body: name -> Buffer.
function multipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || "");
  if (!boundary) return null;
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const parts = {};
  let at = body.indexOf(marker);
  while (at >= 0) {
    const next = body.indexOf(marker, at + marker.length);
    if (next < 0) break;
    const chunk = body.subarray(at + marker.length + 2, next - 2);
    const split = chunk.indexOf("\r\n\r\n");
    const head = chunk.subarray(0, split).toString();
    const name = /name="([^"]+)"/.exec(head)?.[1];
    if (name) parts[name] = chunk.subarray(split + 4);
    at = next;
  }
  return parts;
}

function periodEnd() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

function view(render, base) {
  const elapsed = Date.now() - render.createdAt;
  let status = render.canceled ? "canceled" : elapsed < 1500 ? "queued" : elapsed < RENDER_MS ? "rendering" : "done";
  if (status === "done" && render.fail) status = "failed";
  if (status === "failed" && !render.refunded) {
    render.refunded = true;
    used -= render.charge;
  }
  return {
    id: render.id,
    status,
    charge_seconds: render.charge,
    progress: status === "done" ? 1 : status === "rendering" ? Math.min(0.99, (elapsed - 1500) / (RENDER_MS - 1500)) : 0,
    error: status === "failed" ? "render_failed" : null,
    download_url: status === "done" ? `${base}/files/${render.id}.mp4?X-Mock-Signature=abc` : null,
    size_bytes: status === "done" ? 4096 : null,
    expires_at: status === "done" ? new Date(Date.now() + 3600_000).toISOString() : null,
  };
}

function active() {
  return [...renders.values()].filter((r) => !r.canceled && Date.now() - r.createdAt < RENDER_MS).length;
}

/// Handle a render route; returns false when the request is not one.
export async function handleRenders(req, res, base) {
  const url = new URL(req.url, base);
  if (req.method === "GET" && /^\/files\/[A-Za-z0-9-]+\.mp4$/.test(url.pathname)) {
    const body = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4084, 7)]);
    res.writeHead(200, { "content-type": "video/mp4", "content-length": body.length });
    res.end(body);
    return true;
  }
  if (!url.pathname.startsWith("/v1/desktop/renders")) return false;
  if (req.headers.authorization !== `Bearer ${SESSION_TOKEN}`) {
    json(res, 401, { error: "unauthorized" });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/v1/desktop/renders/quota") {
    json(res, 200, { included_seconds: INCLUDED_SECONDS, used_seconds: used, remaining_seconds: Math.max(0, INCLUDED_SECONDS - used), period_end: periodEnd() });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/v1/desktop/renders") {
    const { body, over } = await readBody(req, MAX_BUNDLE + 1024 * 1024);
    if (over) return json(res, 413, { error: "bundle_too_large" }), true;
    const parts = multipart(body, req.headers["content-type"]);
    let meta;
    try {
      meta = JSON.parse(parts?.meta?.toString() ?? "");
    } catch {
      return json(res, 422, { error: "invalid_meta" }), true;
    }
    const bundle = parts?.bundle;
    if (!bundle || bundle.length > MAX_BUNDLE) return json(res, 413, { error: "bundle_too_large" }), true;
    if (bundle.subarray(0, 4).toString("binary") !== "PK\x03\x04") return json(res, 422, { error: "invalid_bundle" }), true;
    const okMeta =
      typeof meta.duration_s === "number" && meta.duration_s > 0 && meta.duration_s <= 600 &&
      [24, 25, 30, 60].includes(meta.fps) && ["standard", "draft"].includes(meta.quality) &&
      Number.isInteger(meta.width) && Number.isInteger(meta.height);
    if (!okMeta) return json(res, 422, { error: "invalid_meta" }), true;
    if (meta.title === "trigger-402") return json(res, 402, { error: "subscription_required" }), true;
    if (meta.title === "trigger-busy") return json(res, 503, { error: "busy" }, { "retry-after": "20" }), true;
    if (meta.title === "trigger-503") return json(res, 503, { error: "storage_unavailable" }, { "retry-after": "30" }), true;
    createdThisHour = createdThisHour.filter((t) => Date.now() - t < 3600_000);
    if (meta.title === "trigger-429" || createdThisHour.length >= 10) {
      return json(res, 429, { error: "rate_limited" }, { "retry-after": "120" }), true;
    }
    if (active() >= 2) return json(res, 429, { error: "too_many_active_renders" }, { "retry-after": "30" }), true;
    const charge = Math.ceil(meta.duration_s);
    const remaining = Math.max(0, INCLUDED_SECONDS - used);
    if (charge > remaining) {
      return json(res, 402, { error: "render_quota_exhausted", remaining_seconds: remaining, period_end: periodEnd() }), true;
    }
    used += charge;
    createdThisHour.push(Date.now());
    const id = crypto.randomUUID();
    renders.set(id, { id, createdAt: Date.now(), charge, fail: meta.title === "trigger-fail", canceled: false });
    json(res, 202, { id, status: "queued", charge_seconds: charge });
    return true;
  }
  const match = /^\/v1\/desktop\/renders\/([A-Za-z0-9_-]+)(\/cancel)?$/.exec(url.pathname);
  const render = match && renders.get(match[1]);
  if (!render) return json(res, 404, { error: "not_found" }), true;
  if (req.method === "GET" && !match[2]) return json(res, 200, view(render, base)), true;
  if (req.method === "POST" && match[2]) {
    if (view(render, base).status !== "done" && !render.canceled) {
      render.canceled = true;
      used -= render.charge;
    }
    res.writeHead(204);
    res.end();
    return true;
  }
  json(res, 405, { error: "method_not_allowed" });
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = "http://127.0.0.1:14330";
  createServer((req, res) => {
    void handleRenders(req, res, base).then((handled) => {
      if (!handled) json(res, 404, { error: "not_found" });
    });
  }).listen(14330, "127.0.0.1", () => console.log(`mock renders on ${base}`));
}
