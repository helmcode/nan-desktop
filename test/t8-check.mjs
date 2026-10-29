#!/usr/bin/env node
// T8 acceptance check for the tools subsystem.
//
// Drives the pure Rust-core functions through `cargo test` (all suites,
// tempdir-only — never real app dirs or HOME) and then asserts the audit
// log JSONL format through the REAL append() code path: the Rust test
// `audit_fixture_written_when_env_set` writes a realistic sample into the
// temp dir this script hands over via NAN_DESKTOP_T8_AUDIT_FIXTURE_DIR.
// The sample includes a content canary that must never appear in the file.
//
// Exit 0 = pass. Any failure exits non-zero.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cargoDir = join(repoRoot, "src-tauri");

const ALLOWED_EVENTS = new Set([
  "propose",
  "approve",
  "deny",
  "execute",
  "grant_add",
  "grant_revoke",
  "settings",
]);
const ALLOWED_OUTCOMES = new Set(["ok", "rejected", "error", "ignored"]);
const ALLOWED_KEYS = new Set(["ts", "event", "action", "outcome", "grant_id", "profile_id", "detail"]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
// The canary content written by the Rust fixture test: proof that file
// contents never reach the audit log.
const CANARY = "TOP-SECRET-CANARY-CONTENT";

function fail(message) {
  console.error(`t8-check: FAIL — ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------- cargo test

const cargoPath = process.env.CARGO ?? "cargo";
const env = {
  ...process.env,
  PATH: `${process.env.HOME ?? ""}/.cargo/bin:${process.env.PATH ?? ""}`,
};

console.log("t8-check: running cargo test (all suites) …");
const cargo = spawnSync(cargoPath, ["test"], {
  cwd: cargoDir,
  env,
  encoding: "utf8",
});
if (cargo.error) {
  fail(`cannot run cargo (${cargoPath}): ${cargo.error.message}`);
}
if (cargo.status !== 0) {
  console.error(cargo.stdout);
  console.error(cargo.stderr);
  fail(`cargo test exited with status ${cargo.status}`);
}
const summary = cargo.stdout.split("\n").find((line) => line.startsWith("test result: "));
console.log(`t8-check: ${summary?.trim()}`);

// ------------------------------------------------------------ audit fixture

const fixtureDir = mkdtempSync(join(tmpdir(), "nan-desktop-t8-"));
let raw;
try {
  console.log("t8-check: writing audit fixture through the Rust append() path …");
  const withFixture = spawnSync(cargoPath, ["test", "tools::audit::tests::audit_fixture_written_when_env_set"], {
    cwd: cargoDir,
    env: { ...env, NAN_DESKTOP_T8_AUDIT_FIXTURE_DIR: fixtureDir },
    encoding: "utf8",
  });
  if (withFixture.status !== 0) {
    console.error(withFixture.stdout);
    console.error(withFixture.stderr);
    fail("audit fixture cargo test failed");
  }
  raw = readFileSync(join(fixtureDir, "tools-audit.log"), "utf8");
} finally {
  rmSync(fixtureDir, { recursive: true, force: true });
}

const lines = raw.split("\n").filter((line) => line.trim().length > 0);
if (lines.length === 0) fail("audit fixture file is empty");

const seenEvents = new Set();
for (const [index, line] of lines.entries()) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (err) {
    fail(`line ${index + 1} is not valid JSON: ${err.message}`);
  }
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_KEYS.has(key)) fail(`line ${index + 1} has unexpected key "${key}"`);
  }
  for (const required of ["ts", "event", "action", "outcome"]) {
    if (typeof entry[required] !== "string" || entry[required].length === 0) {
      fail(`line ${index + 1} is missing a non-empty "${required}"`);
    }
  }
  if (!RFC3339.test(entry.ts)) fail(`line ${index + 1} ts is not RFC3339 UTC: ${entry.ts}`);
  if (!ALLOWED_EVENTS.has(entry.event)) fail(`line ${index + 1} unknown event "${entry.event}"`);
  if (!ALLOWED_OUTCOMES.has(entry.outcome)) fail(`line ${index + 1} unknown outcome "${entry.outcome}"`);
  seenEvents.add(entry.event);
}

for (const requiredEvent of ["propose", "approve", "execute", "deny"]) {
  if (!seenEvents.has(requiredEvent)) fail(`fixture is missing the "${requiredEvent}" event`);
}

if (raw.includes(CANARY)) {
  fail("audit log contains file CONTENTS (canary leaked) — audit must store paths/summaries only");
}

console.log(
  `t8-check: audit schema OK (${lines.length} lines, events: ${[...seenEvents].sort().join(", ")}) — no content leakage`,
);
console.log("t8-check: PASS");
