// Vision check: which chat models accept an OpenAI `image_url` content part.
//
// Two modes, same requests:
//
//   node test/vision-check.mjs
//       Mock mode (automated): starts test/mock-chat.mjs and proves its
//       contract: the vision models accept a tiny image, the text-only
//       model ("glm5.3") answers the platform's exact 400, and the same
//       request with the image replaced by a text stand-in (what the app
//       sends to a text-only model) succeeds.
//
//   NAN_KEY=<your member API key> node test/vision-check.mjs --real
//       REAL mode (manual, run by a member): sends the same tiny image
//       (non-streaming, max_tokens 40) to the production endpoint
//       (NAN_BASE, default https://api.nan.builders/v1) for every model in
//       src-tauri/chat-models.json and prints what each one answered. The
//       key is read from the environment only and never printed.
//
// Expected (and what chat-models.json encodes): deepseek-v4-flash and
// glm5.3-flash describe the image; glm5.3 answers 400 "text-only model".
// Exit code 0 when every model behaves as chat-models.json says.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = JSON.parse(readFileSync(path.join(ROOT, "src-tauri/chat-models.json"), "utf8"));
const REAL = process.argv.includes("--real");
const MOCK_BASE = "http://127.0.0.1:14323/v1";
const MOCK_KEY = "sk-test-1234567890abcdef";

// A 16x16 solid red PNG.
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";

function imageRequest(model) {
  return {
    model,
    stream: false,
    max_tokens: 40,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What color is this square? Answer in three words." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG}` } },
        ],
      },
    ],
  };
}

function standInRequest(model) {
  return {
    model,
    stream: false,
    max_tokens: 40,
    messages: [{ role: "user", content: "What color is this square?\n\n[Image: red.png (A small red square.)]" }],
  };
}

async function post(base, key, body) {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let message = text.slice(0, 300);
  try {
    const json = JSON.parse(text);
    message = json.choices?.[0]?.message?.content ?? json.error?.message ?? message;
  } catch {
    // keep the raw (truncated) text
  }
  return { status: res.status, message: String(message).replace(/\s+/g, " ").slice(0, 200) };
}

async function waitFor(url) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`mock did not start: ${url}`);
}

async function main() {
  let mock = null;
  let base = MOCK_BASE;
  let key = MOCK_KEY;
  if (REAL) {
    base = (process.env.NAN_BASE ?? "https://api.nan.builders/v1").replace(/\/$/, "");
    key = process.env.NAN_KEY ?? "";
    if (!key) {
      console.error("Set NAN_KEY to your member API key (it is never printed).");
      process.exit(2);
    }
  } else {
    mock = spawn(process.execPath, [path.join(ROOT, "test/mock-chat.mjs")], { stdio: "ignore" });
    await waitFor("http://127.0.0.1:14323/__probe__");
  }
  let failures = 0;
  try {
    for (const model of CONFIG.models) {
      const vision = CONFIG.vision.includes(model);
      const result = await post(base, key, imageRequest(model));
      const ok = vision
        ? result.status === 200
        : result.status === 400 && /text-only/i.test(result.message);
      if (!ok) failures += 1;
      console.log(
        `${ok ? "OK  " : "FAIL"} ${model.padEnd(20)} expected ${vision ? "accepts images " : "400 text-only  "} got ${result.status}: ${result.message}`,
      );
      if (!vision) {
        // What the app sends a text-only model instead: a text stand-in.
        const fallback = await post(base, key, standInRequest(model));
        const fine = fallback.status === 200;
        if (!fine) failures += 1;
        console.log(`${fine ? "OK  " : "FAIL"} ${model.padEnd(20)} with a text stand-in      got ${fallback.status}: ${fallback.message}`);
      }
    }
  } finally {
    mock?.kill();
  }
  if (failures > 0) {
    console.error(`${failures} check(s) did not match src-tauri/chat-models.json`);
    process.exit(1);
  }
  console.log(`All models behave as chat-models.json says (${REAL ? base : "mock"}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
