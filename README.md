# nan-desktop

Native desktop app for the NaN/Helmcode inference APIs. Tauri v2 + React 19 +
Vite (S9). No Docker, no external runtime dependencies (S1). Zero telemetry:
the app only talks to URLs the user provides (S8).

## T1 spike

T1 proves three Rust-core capabilities end to end before the chat MVP (T4)
builds on them:

1. **SSE streaming, Rust → frontend** (`sse_demo_start`): HTTP lives in the
   Rust core (reqwest, S4 — the UI never talks to the API directly). The Rust
   side parses the SSE stream incrementally (`src-tauri/src/sse.rs`, pure and
   unit-tested) and emits Tauri events to the window:
   - `sse://chunk` — payload `{seq, text}` per parsed data event
   - `sse://done` — stream closed cleanly (payload: final chunk count)
   - `sse://error` — payload: error message
   Calling `sse_demo_start` again aborts the previous stream task
   (cancel-safe; handle kept in app state).

2. **Keychain storage** (`keyring_set` / `keyring_get`): OS credential store
   via the `keyring` crate — macOS Keychain, Windows Credential Manager,
   Linux Secret Service under one API (S4: the API key never enters the web
   renderer process). The UI only ever displays whether a value exists, and
   masks it to the last 4 characters.

3. **SQLite local history** (`db_demo`): `rusqlite` (bundled) creates a
   `messages` table under the app data dir, inserts one demo row per call
   and returns the last 10 rows by id. The DB logic is unit-tested against a
   temp file (`tempfile`), never against the real app dir.

### Running the spike

```sh
pnpm install
node test/mock-sse.mjs          # mock SSE server on http://127.0.0.1:14321/events
pnpm tauri dev                  # app window with the three spike panels
```

Integration check (mock server wire format + Rust unit tests):

```sh
node test/spike-check.mjs
```

## T3 onboarding + profiles + keychain

T3 turns the spike into the app's entry flow: profile selection (S2), API-key
storage in the OS keychain (S4) and a connection test — all with the
zero-telemetry rule intact (S8: the app only ever contacts the configured
profile's own base URL).

### Profile model

Profiles live in `profiles.json` inside the OS app data dir
(`~/Library/Application Support/com.helmcode.nan.desktop/profiles.json` on
macOS). The document is `{profiles: [{id, name, base_url}],
active_profile}`:

- **Seeded on first run** with exactly two profiles: `nan` → "NaN community"
  (`https://api.nan.builders/v1`) and `helmcode` → "Helmcode enterprise"
  (`https://api.helmcode.com/v1`).
- **Custom profiles** (any OpenAI-compatible base URL) can be added from the
  onboarding screen. Validation (in the Rust core, `src-tauri/src/profile.rs`):
  the base URL must be `https`; plain `http` is accepted only for
  `127.0.0.1`/`localhost` hosts (needed for local dev mocks). Query strings
  and fragments are rejected.
- **Corruption recovery**: a missing, corrupted or invalid `profiles.json`
  falls back to the seeded defaults and the file is rewritten so it stays
  readable. Unknown active ids are rejected without changing the current one.
- Profile ids for custom profiles are slugs of their name, kept unique
  (`My Lab` → `my-lab`, `my-lab-2`, …).

### Where the key lives

The API key is **never** in `profiles.json`. It is stored in the OS keychain
(macOS Keychain / Windows Credential Manager / Linux Secret Service) via the
`keyring` crate under:

- service: `com.helmcode.nan.desktop` (constant shared by Rust and the UI)
- account: the profile id

The renderer never reads a stored key back: the connection test resolves the
key inside Rust, and the UI only ever sees `has_key` plus a mask of the last
4 characters (keys ≤ 4 chars are masked entirely). The key input is cleared
from component state right after saving. `key_delete(profile_id)` removes a
stored key (idempotent).

### Connection test

`connection_test(profile_id, key?)` runs `GET {base_url}/models` with the
Bearer key (typed key before saving, stored key otherwise) from the Rust
core, with a 10 s timeout, and classifies the outcome:
`ok` (2xx + OpenAI-style model list; reports model count + latency) /
`http_error` (non-2xx or unparseable body; reports status only) /
`network_error` / `missing_key`. The result never contains the key or any
response body — only counts and a short error string.

### Testing with the mock API

```sh
node test/mock-api.mjs
```

serves `GET /v1/models` on `http://127.0.0.1:14322/v1/models`, requiring
`Authorization: Bearer test-key-12345` (mock fixture token) and answering
with 3 models. In the app: add a **Custom** profile with base URL
`http://127.0.0.1:14322/v1`, enter `test-key-12345`, press **Test
connection** → should show 3 models and a latency; a wrong key shows the
401 classification.

Integration check (mock wire contract + full Rust unit suite):

```sh
node test/t3-check.mjs
```

### What is NOT yet implemented

- **Real chat (T4)**: SSE chat streaming, model picker UI, markdown + code
  highlighting, SQLite conversation history. The post-onboarding screen is a
  placeholder; the T1 spike panel (collapsed below it) still proves the
  SSE/keychain/SQLite foundations.
- Updater and code signing (T2/T7) and the Linux CI build, as deferred from
  T1.

Rust-side verification:

```sh
cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cargo test                      # 9 SSE + 2 SQLite + 9 profile + 9 conn-test
```

Rust-side verification:

```sh
cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cargo test                      # 9 SSE parser tests + 2 SQLite tests
```

### What remains untested (deferred per spec T1)

- **Keyring automated test**: deliberately omitted — macOS may pop a
  Keychain permission prompt in headless runs. Covered manually via the
  UI buttons (Set/Get) for now.
- **Updater**: config deferred to T2/T7 (signed updater needs release
  infrastructure).
- **Linux WebKitGTK build**: deferred to CI (T2 matrix); this spike was
  validated on macOS only.
