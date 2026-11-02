#!/usr/bin/env node
// T8 acceptance check for the tools subsystem (+ round 2: S13 approval
// modes, S14 inline approvals, S15 move/delete/run_command, S16 DSML).
//
// Drives the pure Rust-core functions through `cargo test` (all suites,
// tempdir-only — never real app dirs, HOME or the real trash), asserts
// that the round-2 acceptance tests actually RAN and passed (a filtered or
// renamed test must not silently drop coverage), and then asserts the audit
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
// Tool kinds plus the settings/grant pseudo-actions.
const ALLOWED_ACTIONS = new Set([
  "read_file",
  "list_files",
  "write_file",
  "replace_file",
  "run_command",
  "move_path",
  "delete_path",
  "grant",
  "grant_mode",
  "unknown",
]);
// Round-2 acceptance tests that must run and pass (name suffix match on
// the `test <path> ... ok` lines of cargo's output).
const REQUIRED_TESTS = [
  // S13 approval modes
  "tools::grants::tests::approval_mode_round_trips_and_parses_strictly",
  "tools::grants::tests::legacy_grants_load_in_ask_mode",
  "tools::grants::tests::computer_wide_grants_always_ask",
  "tools::tests::allow_mode_runs_every_covered_action_without_a_prompt",
  "tools::tests::allow_mode_never_unlocks_the_deny_list_or_protected_targets",
  "tools::tests::computer_wide_always_uses_the_native_dialog_whatever_the_mode",
  // S14 inline approvals
  "tools::tests::ask_mode_prompts_inline_and_a_deny_executes_nothing",
  "tools::approvals::tests::renderer_cannot_answer_an_id_the_core_never_created",
  "tools::approvals::tests::a_grant_resolves_the_waiting_request_once",
  "tools::approvals::tests::dropping_the_ticket_withdraws_the_request",
  // S15 tools
  "tools::tests::move_path_renames_and_overwrites_only_when_asked",
  "tools::tests::move_path_keeps_both_ends_inside_granted_scope",
  "tools::tests::delete_path_removes_files_and_folders_and_states_permanence",
  "tools::tests::run_command_on_by_default_and_refused_when_switched_off",
  "tools::grants::tests::pre_promotion_store_is_migrated_on_once_and_explicit_off_sticks",
  "tools::grants::tests::removal_of_roots_home_app_data_and_sensitive_dirs_is_refused",
  // S16 DSML
  "tool_markup::tests::leaked_l18_sample_becomes_a_tool_call_and_no_dsml_reaches_content",
  "tool_markup::tests::leaked_sample_split_at_every_byte_boundary_still_parses",
  "chat::tests::leaked_dsml_in_streamed_content_becomes_a_tool_call_never_text",
  "chat::tests::openai_tool_call_deltas_still_win_over_content_markup",
  // S24 voice parked
  "tests::voice_ui_is_parked_by_default",
  // S21 preview pane backends
  "preview::tests::reads_a_file_inside_the_grant_as_exact_base64",
  "preview::tests::refuses_files_outside_every_grant_and_profiles_without_grants",
  "preview::tests::refuses_the_sensitive_deny_list_even_inside_a_grant",
  "preview::tests::refuses_the_protected_app_data_folder",
  "preview::tests::refuses_files_over_the_8_mib_cap",
  "preview::tests::success_returns_the_page_and_speaks_the_wire_contract",
  "preview::tests::failures_map_to_typed_kinds",
  "preview::tests::no_key_material_or_page_content_leaks_into_errors_or_replies",
  // Image endpoint path (base already ends in /v1)
  "images::tests::generation_url_is_exactly_v1_images_generations_on_both_tenants",
];
// Unix-only acceptance tests (symlinks / sh): required where they can run.
if (process.platform !== "win32") {
  REQUIRED_TESTS.push(
    "tools::tests::move_path_and_delete_path_are_symlink_safe",
    "tools::tests::run_command_asks_unless_its_cwd_is_in_an_allow_grant",
    "tools::trash::tests::files_and_folders_land_in_the_trash_and_nothing_is_lost",
    "preview::tests::never_follows_symlinks",
  );
}
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
const summaries = cargo.stdout.split("\n").filter((line) => line.startsWith("test result: "));
let totalPassed = 0;
for (const line of summaries) {
  const match = /(\d+) passed/.exec(line);
  if (match) totalPassed += Number(match[1]);
}
console.log(`t8-check: ${summaries.length} suites, ${totalPassed} tests passed`);

const passedTests = new Set(
  cargo.stdout
    .split("\n")
    .map((line) => /^test (\S+) \.\.\. ok$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1]),
);
for (const required of REQUIRED_TESTS) {
  if (!passedTests.has(required)) fail(`required round-2 test did not run/pass: ${required}`);
}
console.log(`t8-check: ${REQUIRED_TESTS.length} round-2 acceptance tests ran and passed`);

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
  if (!ALLOWED_ACTIONS.has(entry.action)) fail(`line ${index + 1} unknown action "${entry.action}"`);
  seenEvents.add(entry.event);
}

for (const requiredEvent of ["propose", "approve", "execute", "deny", "settings"]) {
  if (!seenEvents.has(requiredEvent)) fail(`fixture is missing the "${requiredEvent}" event`);
}

if (raw.includes(CANARY)) {
  fail("audit log contains file CONTENTS (canary leaked) — audit must store paths/summaries only");
}

console.log(
  `t8-check: audit schema OK (${lines.length} lines, events: ${[...seenEvents].sort().join(", ")}) — no content leakage`,
);
console.log("t8-check: PASS");
