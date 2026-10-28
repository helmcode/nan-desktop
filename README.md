# nan-desktop

[![CI](https://github.com/helmcode/nan-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/helmcode/nan-desktop/actions/workflows/ci.yml)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-proprietary%20(source--available)-red)
![Telemetry](https://img.shields.io/badge/telemetry-none-success)

Native desktop app for the NaN/Helmcode inference APIs. Tauri v2 + React 19 +
Vite (S9). No Docker, no external runtime dependencies (S1). Zero telemetry:
the app only talks to the two locked tenants' own URLs (S8).

**A community-built product:** the source is public for review and
contribution, and the product is Helmcode S.L. proprietary — the app only
connects to `api.nan.builders` and `api.helmcode.com`. See
[CONTRIBUTING.md](CONTRIBUTING.md) to get started and
[SECURITY.md](SECURITY.md) to report anything sensitive privately.

## T4 chat MVP (S3)

After sign-in the app is a full chat client: streaming SSE replies, markdown
+ syntax-highlighted code blocks, local SQLite conversation history and a
model picker fed by `GET /v1/models`.

### Architecture: Rust streaming → events → React

Everything secret and every HTTP byte lives in the Rust core (S4); the
renderer only ever sees delta text, conversation metadata and classified
error kinds:

```
composer (Enter sends)                       ┌─ chat://delta {conversation_id, delta}
   │ invoke("chat_send")                     │      …per SSE data chunk
   ▼                                        │
┌────────────────────── src-tauri/src/chat.rs ───────────────────────────┐
│ 1. keychain read (account <profile-id>) → 401-classifiable Bearer     │
│ 2. persist user message BEFORE streaming (chat_store, chat.db)        │
│    + auto-title: first user message, 48 chars, no extra model call    │
│ 3. POST {inference_base}/chat/completions  {model, messages, stream}  │
│ 4. incremental UTF-8 decode → sse.rs parser → extract_delta           │
│ 5. persist assistant message AFTER done (final accumulated text;      │
│    on error the partial text is dropped, only chat://error is sent)   │
└────────────────────────────────────────────────────────────────────────┘
   │                                        └─ chat://done {conversation_id}
   ▼                                        └─ chat://error {conversation_id, kind}
React state (drafts per conversation) → react-markdown + highlight + sanitize
```

- **One active stream per conversation.** `chat_send` again into the same
  conversation aborts the previous stream task (cancel-safe registry in
  `ChatState`: conversation → generation counter + `JoinHandle`; a finishing
  task only removes its own entry). Different conversations may stream in
  parallel.
- **Error kinds** (`chat://error`): `missing_key`, `unauthorized` (401 → the
  UI shows the "Session expired — sign in again" banner with a Sign out
  action), `rate_limited` (429), `server` (other non-2xx), `network`
  (transport), `protocol` (local failures). Errors render inline in the
  message area — never `alert()`.
- **Persistence** (`src-tauri/src/chat_store.rs`, SQLite file `chat.db` in
  the app data dir, separate from the spike's `spike.db`): tables
  `conversations(id, title, profile_id, created_at, updated_at)` and
  `messages(id, conversation_id, role, content, model, created_at)`. The
  user message is stored before streaming starts; the assistant message
  after a clean finish. Commands: `conversation_list(profile_id)` (most
  recent first, last-message preview), `conversation_create(profile_id,
  title?)`, `conversation_delete(id)`, `messages_list(conversation_id)`.
- **Model picker**: `models_list()` → `GET {inference_base}/models` with the
  keychain Bearer (active profile), parsed, then filtered by the pure
  `filter_chat_models` (excludes `kokoro`, `whisper`, `qwen3-embedding`,
  `rerank`, `qwen-image-2.1`, `flux-2-klein` and any id containing
  `embedding` / `rerank` / `whisper` / `kokoro` / `image` / `flux`, case-
  insensitive) and sorted with `deepseek-v4-flash` first — the default
  selection. 401 maps to the `unauthorized` kind.
- **Markdown**: react-markdown + remark-gfm; highlighting via
  **rehype-highlight** (sync highlight.js pipeline — shiki's async
  highlighting would complicate/ stall streaming re-renders and its grammar
  bundle dwarfs highlight.js; bundle size is irrelevant since Tauri ships
  assets on disk) and **rehype-sanitize** as the LAST pass — raw HTML is
  never rendered, the schema keeps only the highlighter's `hljs-*` classes.
  Code blocks get a dark theme, a language label and a copy button.

### Testing with the mocks

Both mocks are dependency-free Node servers:

```sh
node test/mock-device.mjs      # mock login platform   on http://127.0.0.1:14322
node test/mock-chat.mjs        # mock inference API    on http://127.0.0.1:14323
```

Run them together, then the app against both (debug builds only — release
builds ignore the env vars entirely, S12):

```sh
NAN_DESKTOP_MOCK_PLATFORM=http://127.0.0.1:14322 \
NAN_DESKTOP_MOCK_INFERENCE=http://127.0.0.1:14323 pnpm tauri dev
```

`test/mock-chat.mjs` serves `GET /v1/models` (the 12-model fixture: 6 chat +
6 non-chat) and `POST /v1/chat/completions` (Bearer `sk-test-1234567890abcdef`
— the same key the device mock issues — streams a role-only preamble, 8
content deltas of a markdown reply with a fenced code block and a multi-byte
char split across two TCP writes, then `[DONE]`; `trigger-429` / `trigger-500`
models answer 429/500 for classification tests).

Integration check (mock wire contract + full Rust suite):

```sh
node test/t4-check.mjs
```

### What is NOT in the MVP

- Tool use / computer use (T8), vision upload + image generation/editing
  (T5), TTS kokoro + dictation whisper (T6) — the model picker deliberately
  filters those models out for now.
- Conversation rename, message editing/regeneration, persisted model choice
  (in-memory per session, default `deepseek-v4-flash`), streaming cancellation
  button (re-sending into the conversation already aborts the stream).
- On error the partial assistant text is dropped by design (only the user
  message stays persisted); no partial-message marker in this MVP.

## T13 device-flow login (with T3b profile lockdown)

Signing in is a browser-based device flow (RFC 8628-style, S11/S4): the user
never pastes an API key — approval in the browser is what mints the
credentials, and they land straight in the OS keychain.

### Login flow

1. **Profile choice** — two locked cards ("NaN community", "Helmcode
   enterprise") with one-line descriptions. No URLs are shown; the renderer
   never receives one (S4/S12).
2. **Authorizing** — the Rust core POSTs
   `{platform_base}/api/auth/device/start`, keeps the `device_code` in memory
   only (never persisted, never sent to the renderer), opens the system
   browser on the returned `verification_url` (via `tauri-plugin-opener`),
   and the UI shows the big `XXXX-XXXX` user_code plus a live status line fed
   by `device://` events, with a Cancel button.
3. **Poll** — the Rust core polls `/api/auth/device/poll` at the advertised
   interval, honoring 429 `slow_down` / `Retry-After` backoff. The poll state
   machine (`src-tauri/src/device_flow.rs`, pure + unit-tested) maps each
   response:
   - `{"status":"pending"}` → keep polling (`device://status`)
   - `{"status":"denied"}` → `device://denied`
   - `{"status":"expired"}` → `device://expired`
   - approved `{session_token, api_key, key_alias}` → stored **exactly once**
   - 4xx/5xx/malformed → `device://error {kind}` (`network`, `timeout`,
     `rate_limited`, `server`, `protocol`)
4. **Approved** — the API key is stored in the OS keychain under the profile
   id, the session JWT under `<profile-id>.session`, the profile becomes
   active, and the renderer only learns `{key_alias, profile_id}`. The raw
   key/token never crosses the IPC boundary (S4). The UI lands on the chat
   placeholder (active profile + signed-in state + Sign out).
5. **Sign out** — `device_logout(profile_id)` deletes both keychain entries
   and clears the active profile.

A second `device_login_start` cancels the first loop (same cancel-safe
managed-task pattern as the SSE demo); `device_login_cancel` backs the Cancel
button.

### Locked profiles (T3b, S2/S12)

`profiles.json` (schema **v2**, in the OS app data dir) persists only the
canonical profile list plus the active id. Both definitions are compiled-in
Rust constants; there is no API to add, edit or remove profiles and no
user-configurable endpoint anywhere — the binary cannot be pointed at
anything but the two owned tenants:

| id | Name | Platform base (device endpoints) | Inference base (chat/images/audio) |
|----|------|----------------------------------|------------------------------------|
| `nan` | NaN community | `https://cloud-api.nan.builders` | `https://api.nan.builders/v1` |
| `helmcode` | Helmcode enterprise | `https://api.helmcode.com` | `https://api.helmcode.com/v1` |

Keychain (service `com.helmcode.nan.desktop`): account `<profile-id>` holds
the inference API key, account `<profile-id>.session` holds the login session
JWT. The stored active profile id is validated against the two ids on load.

**Migration**: pre-existing v1 `profiles.json` files (T3 era, with custom
OpenAI-compatible profiles and `base_url` fields) are rewritten to v2 on
load; custom profiles are dropped and the active id is kept only when it is
one of the two known ids. The old key-entry / Replace-key /
Switch-profile-by-URL UI was removed entirely.

### Testing with the mock platform

The real device endpoints live behind PRs
[nan-cloud-api#411](https://github.com/helmcode/nan-cloud-api/pull/411)
(community) and enterprise-api#105 (enterprise). Until they are deployed, a
dependency-free mock proves the flow end to end:

```sh
node test/mock-device.mjs      # mock platform on http://127.0.0.1:14322
```

`test/mock-device.mjs` implements `/api/auth/device/start`, `/poll`, the
approval page stub, `/approve`, `/deny` and `/reset`: a started request is
pending for its first 2 polls, then auto-approves exactly once with
`session_token "fake-jwt"` + `api_key "sk-test-1234567890abcdef"`; polling
faster than 200 ms answers 429 + `Retry-After`.

To run the app against the mock (debug builds only):

```sh
NAN_DESKTOP_MOCK_PLATFORM=http://127.0.0.1:14322 pnpm tauri dev
```

The `NAN_DESKTOP_MOCK_PLATFORM` env var overrides the device-flow platform
base **only in debug builds** (`cfg!(debug_assertions)`); release builds
ignore it entirely (S12). It is developer tooling — never set it for real
usage.

Integration check (mock wire contract + full Rust unit suite):

```sh
node test/t13-check.mjs
```

### What changed vs the key-based onboarding (T3, superseded)

- No API-key entry anywhere: sign-in is the device flow; the key is minted
  server-side and stored by the Rust core.
- No custom profiles: the profile list is locked to the two tenants (T3b);
  any previously stored custom profile is dropped on first run of the new
  build.
- No "Test connection" in the UI: the `connection_test` command remains as a
  Rust-side diagnostic (stored key only) but the login screen no longer needs
  it.
- The T1 spike panel (SSE / keychain / SQLite) is kept under a collapsed
  `<details>` in the chat shell — it still proves the foundations.

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
pnpm tauri dev                  # app window with the spike panels
```

Integration check (mock server wire format + Rust unit tests):

```sh
node test/spike-check.mjs
```

### What is NOT yet implemented

- Updater and code signing (T2/T7) and the Linux CI build, as deferred from
  T1. (The real chat landed in T4 — see the T4 section at the top.)

### What remains untested (deferred per spec T1)

- **Keyring automated test**: deliberately omitted — macOS may pop a
  Keychain permission prompt in headless runs. Covered manually via the UI
  buttons (Set/Get) for now; the account-name conventions
  (`<profile-id>` / `<profile-id>.session`) are unit-tested in
  `profile.rs`.
- **Updater**: config deferred to T2/T7 (signed updater needs release
  infrastructure).
- **Linux WebKitGTK build**: deferred to CI (T2 matrix); validated on macOS
  only.

Rust-side verification:

```sh
cd src-tauri
cargo fmt --check
cargo clippy -- -D warnings
cargo test                      # 9 SSE + 2 SQLite + 11 profile + 18 device-flow + 9 conn-test + 23 chat + 7 chat_store
```
