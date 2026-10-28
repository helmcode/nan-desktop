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
