#!/usr/bin/env node
// Template layout check (R-V1): every bundled video template, in every
// aspect (16:9 1920x1080, 9:16 1080x1920, 1:1 1080x1080), keeps its text
// and images inside the frame, measured with REAL layout (jsdom has none).
//
// 1. The core writes each template's assembled preview, exactly what the
//    player and the render load (`cargo test --lib dump_template_previews
//    -- --ignored`, VIDEO_TEMPLATE_DUMP=<dir>), unless a dump dir is given.
// 2. Headless Chrome (CDP over the built-in WebSocket, no dependency) opens
//    each document with the viewport set to the composition size and runs
//    the app's own layout check in it (src-tauri/src/video/layout_probe.js,
//    the same script the app runs on agent-authored videos before an
//    export): it seeks the HyperFrames runtime to several times per scene
//    and measures every visible text run and image:
//    - at any time, an element that is partly in frame must not touch the
//      edge (within MARGIN of the short side): that is clipped text;
//    - when a scene has settled (just before it ends), nothing visible may
//      be outside the frame at all (an element entirely off-frame mid-scene
//      is an entrance/exit animation and is allowed).
//    Elements hidden by opacity, display, visibility or an overflow-clipping
//    ancestor smaller than the frame are ignored.
//
// Usage:
//   node test/template-layout-check.mjs [--dump <dir>] [--shots <dir>] [--only <id,...>]
//   CHROME_PATH=/path/to/chrome overrides the browser lookup.
//   --shots writes <template>-<aspect>-<mid|end>.png for a visual review.
//
// Exit 0 = pass. Any violation (or no browser) exits non-zero.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ASPECTS = { "1920x1080": "horizontal", "1080x1920": "vertical", "1080x1080": "square" };

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const only = flag("--only")?.split(",");
const shots = flag("--shots");
if (shots) mkdirSync(shots, { recursive: true });

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ];
  return candidates.find((p) => p && existsSync(p));
}

function dumpPreviews() {
  const dir = mkdtempSync(join(tmpdir(), "tpl-layout-"));
  const run = spawnSync("cargo", ["test", "--lib", "dump_template_previews", "--", "--ignored"], {
    cwd: join(repoRoot, "src-tauri"),
    env: { ...process.env, VIDEO_TEMPLATE_DUMP: dir },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (run.status !== 0) {
    console.error("could not dump the template previews");
    process.exit(1);
  }
  return dir;
}

async function launch(chrome) {
  const profile = mkdtempSync(join(tmpdir(), "tpl-layout-chrome-"));
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const ws = await new Promise((resolve, reject) => {
    let err = "";
    const timer = setTimeout(() => reject(new Error(`chrome did not start: ${err}`)), 30000);
    proc.stderr.on("data", (chunk) => {
      err += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
  });
  const port = new URL(ws).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const close = () => {
    socket.close();
    proc.kill();
    // Chrome may still hold the profile for a moment.
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
  };
  return { send, close };
}

// The shared layout check (defines window.__nanLayoutProbe in the page).
const PROBE = readFileSync(join(repoRoot, "src-tauri/src/video/layout_probe.js"), "utf8");

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error("no Chrome/Chromium found (set CHROME_PATH)");
    process.exit(1);
  }
  const given = flag("--dump");
  const dump = given ?? dumpPreviews();
  const files = readdirSync(dump)
    .filter((f) => /-\d+x\d+\.html$/.test(f))
    .filter((f) => !only || only.includes(f.replace(/-\d+x\d+\.html$/, "")))
    .sort();
  if (files.length === 0) {
    console.error(`no template previews in ${dump}`);
    process.exit(1);
  }
  const { send, close } = await launch(chrome);
  const failures = [];
  try {
    await send("Page.enable");
    await send("Runtime.enable");
    const evaluate = async (expression) => {
      const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? "evaluation failed");
      return res.result.value;
    };
    for (const file of files) {
      const [, id, size] = /^(.*)-(\d+x\d+)\.html$/.exec(file);
      const [width, height] = size.split("x").map(Number);
      const aspect = ASPECTS[size] ?? size;
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: pathToFileURL(join(dump, file)).href });
      const started = Date.now();
      while (!(await evaluate("window.__playerReady === true && document.readyState === 'complete'"))) {
        if (Date.now() - started > 20000) throw new Error(`${file}: the runtime never became ready`);
        await new Promise((r) => setTimeout(r, 100));
      }
      await evaluate("document.fonts.ready.then(() => true)");
      // Scene timing from the document as the core wrote it (the runtime
      // strips data-duration from the hosts once it mounts them).
      const html = readFileSync(join(dump, file), "utf8");
      const scenes = [...html.matchAll(/data-composition-src="[^"]*" data-start="([\d.]+)" data-duration="([\d.]+)"/g)].map(
        (m) => [Number(m[1]), Number(m[2])],
      );
      if (scenes.length === 0) throw new Error(`${file}: no scenes found`);
      const total = await evaluate("window.__player.getDuration()");
      await evaluate(PROBE);
      const config = {
        scenes: scenes.map(([start, duration], i) => ({ id: `scene-${i + 1}`, start, duration })),
        total,
        // CI looks at every sample, however long it takes.
        budgetMs: 120000,
        maxSamples: 10000,
      };
      const result = await evaluate(`window.__nanLayoutProbe.checkAll(window, ${JSON.stringify(config)})`);
      if (!result.complete) throw new Error(`${file}: the check did not finish`);
      const problems = new Set(
        result.issues.map(
          (i) =>
            `t=${i.time.toFixed(2)}s ${i.element} ${i.kind === "clipped" ? "touches the edge" : "is off-frame when the scene settles"} [${i.box[0]},${i.box[1]} → ${i.box[2]},${i.box[3]}]`,
        ),
      );
      if (shots) {
        for (const [name, t] of [
          ["mid", total / 2],
          ["end", total - 0.05],
        ]) {
          await evaluate(`window.__player.pause(); window.__player.seek(${t}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
          const png = await send("Page.captureScreenshot", { format: "png" });
          writeFileSync(join(shots, `${id}-${aspect}-${name}.png`), Buffer.from(png.data, "base64"));
        }
      }
      const status = problems.size === 0 ? "ok" : "FAIL";
      console.log(`${status}  ${id} ${aspect}`);
      for (const p of problems) {
        console.log(`      ${p}`);
        failures.push(`${id} ${aspect}: ${p}`);
      }
    }
  } finally {
    close();
    if (!given) rmSync(dump, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} layout problem(s)`);
    process.exit(1);
  }
  console.log(`\nall ${files.length} template previews keep their content in frame`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
