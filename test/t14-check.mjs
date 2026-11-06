#!/usr/bin/env node
// Round 4 end-to-end check (runs in CI).
//
// Images failed four iterations in a row, so this script proves the whole
// path over mocks and refuses to pass if any pinned test was renamed,
// filtered or skipped:
//
//   Rust (loopback HTTP, no network): the mock tenant's desktop route
//   (/v1/desktop/images/generations, multipart, session bearer) answers
//   {"data":[{"url": presigned}]} → the core downloads it with NO
//   Authorization header (also across redirects), 20 MiB cap, non-200 →
//   protocol → the generate_image tool saves it under app_data/images and
//   persists an `image` artifact whose row JSON is exactly what the
//   renderer reads. A FLUX JPEG reply is saved as `.jpg`. Plus the route
//   pins (desktop generate on both tenants, per-profile edit paths) and the
//   memory sync keeping artifacts.
//
//   UI (vitest, mocked Tauri IPC): chat send → `generating_image` activity
//   → done → inline image + the preview pane opens it; a produced file
//   auto-opens and later artifacts replace it; image mode is per
//   conversation; the post-PDF conversation switch never blanks the shell.
//
// Usage: node test/t14-check.mjs        Exit 0 = pass.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cargoDir = join(repoRoot, "src-tauri");
const isWindows = process.platform === "win32";

const REQUIRED_RUST = [
  "images::tests::generation_url_is_the_desktop_route_on_both_tenants",
  "images::tests::edit_urls_are_resolved_per_profile",
  "images::tests::e2e_a_flux_jpeg_reply_is_saved_as_jpg",
  "images::tests::the_production_request_path_uses_the_compiled_in_base_unchanged",
  "images::tests::parses_b64_json_reply_into_exact_bytes",
  "images::tests::https_url_reply_is_the_live_community_shape",
  "images::tests::non_https_url_replies_are_protocol_and_never_fetched",
  "images::tests::empty_data_missing_fields_and_malformed_json_are_protocol",
  "images::tests::download_returns_the_exact_bytes_on_200",
  "images::tests::download_non_200_is_protocol",
  "images::tests::download_over_20_mib_is_decode_with_or_without_content_length",
  "images::tests::production_download_refuses_plain_http_without_any_connection",
  "images::tests::download_follows_at_most_three_redirects",
  "images::tests::e2e_url_reply_is_downloaded_and_no_authorization_reaches_the_storage_host",
  "images::tests::e2e_no_authorization_reaches_the_storage_host_across_redirects",
  "images::tests::e2e_generate_image_tool_call_lands_as_an_inline_image_artifact",
  "images::tests::e2e_b64_reply_still_works_and_errors_classify",
  "images::tests::e2e_production_mode_refuses_a_plain_http_url_reply",
  "chat_store::tests::memory_sync_overwrite_keeps_the_artifacts_of_replies_still_present",
  "chat_store::tests::artifacts_roundtrip_clear_and_tolerate_corrupt_json",
];

const UI_FILES = ["src/App.round4.test.tsx", "src/App.freeze.test.tsx", "src/chat/autoOpen.test.ts"];
const REQUIRED_UI = [
  "opens the file a reply produced, replaces it with a later one, and respects a close",
  "switching conversations never opens anything by itself",
  "a reply that finishes in a background conversation is open when the user returns",
  "chat send → generating_image activity → done → inline image + pane opens it",
  "the composer's image mode result opens in the pane too",
  "does not leak across chats and is remembered per chat",
  "a new chat starts in text mode and keeps the mode it was given once created",
  "baseline: PDF produced → pane opens → switching conversations keeps the shell",
  "a renderer whose teardown throws on the switch no longer blanks the window",
  "a renderer that throws while rendering shows a closable note instead of a blank window",
];

function fail(message) {
  console.error(`t14-check: FAIL — ${message}`);
  process.exit(1);
}

const env = { ...process.env, PATH: `${process.env.HOME ?? ""}/.cargo/bin:${process.env.PATH ?? ""}` };
// The E2E must exercise the loopback mocks only — never a dev override.
delete env.NAN_DESKTOP_MOCK_INFERENCE;
delete env.NAN_DESKTOP_MOCK_IMAGES;
delete env.NAN_DESKTOP_MOCK_IMAGE_EDITS;
delete env.NAN_DESKTOP_MOCK_PLATFORM;

// ------------------------------------------------------------------- Rust

console.log("t14-check: cargo test (images + chat_store) …");
const cargo = spawnSync(process.env.CARGO ?? "cargo", ["test", "--lib", "--", "images::", "chat_store::"], {
  cwd: cargoDir,
  env,
  encoding: "utf8",
});
if (cargo.error) fail(`cannot run cargo: ${cargo.error.message}`);
if (cargo.status !== 0) {
  console.error(cargo.stdout);
  console.error(cargo.stderr);
  fail(`cargo test exited with status ${cargo.status}`);
}
const passedRust = new Set(
  cargo.stdout
    .split("\n")
    .map((line) => /^test (\S+) \.\.\. ok$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1]),
);
for (const name of REQUIRED_RUST) {
  if (!passedRust.has(name)) fail(`required Rust test did not run/pass: ${name}`);
}
console.log(`t14-check: ${REQUIRED_RUST.length} required Rust tests passed`);

// --------------------------------------------------------------------- UI

const outDir = mkdtempSync(join(tmpdir(), "nan-desktop-t14-"));
try {
  const report = join(outDir, "vitest.json");
  console.log("t14-check: vitest (round-4 UI flows) …");
  const vitest = spawnSync(
    isWindows ? "npx.cmd" : "npx",
    ["vitest", "run", ...UI_FILES, "--reporter=json", `--outputFile=${report}`],
    { cwd: repoRoot, env, encoding: "utf8", shell: isWindows },
  );
  if (vitest.error) fail(`cannot run vitest: ${vitest.error.message}`);
  let results;
  try {
    results = JSON.parse(readFileSync(report, "utf8"));
  } catch (err) {
    console.error(vitest.stdout);
    console.error(vitest.stderr);
    fail(`no vitest JSON report: ${err.message}`);
  }
  const passedUi = new Set(
    results.testResults
      .flatMap((file) => file.assertionResults)
      .filter((test) => test.status === "passed")
      .map((test) => test.title),
  );
  if (vitest.status !== 0) {
    const failed = results.testResults
      .flatMap((file) => file.assertionResults)
      .filter((test) => test.status !== "passed")
      .map((test) => `${test.title}: ${(test.failureMessages ?? []).join(" ").slice(0, 400)}`);
    fail(`vitest failed:\n  ${failed.join("\n  ")}`);
  }
  for (const title of REQUIRED_UI) {
    if (!passedUi.has(title)) fail(`required UI test did not run/pass: ${title}`);
  }
  console.log(`t14-check: ${REQUIRED_UI.length} required UI flows passed`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log("t14-check: PASS");
