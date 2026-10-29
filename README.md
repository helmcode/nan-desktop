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
│ 5. persist assistant reply as it streams (T4b): in_progress row +
│    per-chunk delta flush; finalized on done/stop, deleted on error
└────────────────────────────────────────────────────────────────────┘
   │                                        └─ chat://done {conversation_id}
   ▼                                        └─ chat://stopped {conversation_id} (T4b)
                                            └─ chat://error {conversation_id, kind}
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
  `messages(id, conversation_id, role, content, model, created_at, status)`
  (`status`: `complete` default, `in_progress` while streaming — T4b). The
  user message is stored before streaming starts; the assistant reply is
  stored as an in-progress row whose content is overwritten per network
  chunk and finalized on done/stop (see T4b below). Commands:
  `conversation_list(profile_id)` (most recent first, last-message
  preview), `conversation_create(profile_id, title?)`,
  `conversation_delete(id)`, `messages_list(conversation_id)`,
  `chat_stop(conversation_id)` (T4b).
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
node test/mock-voice.mjs       # mock voice inference  on http://127.0.0.1:14324
node test/mock-images.mjs      # mock image inference  on http://127.0.0.1:14325
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
char split across two TCP writes, then `[DONE]`; `trigger-429` /
`trigger-500` models answer 429/500 for classification tests;
`trigger-slow-stream` streams a delta every 200 ms and never ends, for the
T4b stop check, which reads the recorded counters via `GET /__stats__` and
clears them via `GET /reset`).

Integration check (mock wire contract + full Rust suite):

```sh
node test/t4-check.mjs
```

### What is NOT in the MVP

- Tool use / computer use (T8), vision upload and image EDITING (the image
  GENERATION half of T5 shipped — see below; editing stays out of v1 per the
  product review) — the model picker still filters those models out.
- Conversation rename, message editing/regeneration, persisted model choice
  (in-memory per session, default `deepseek-v4-flash`).
- On a classified error the partial assistant text is dropped by design
  (only the user message stays persisted) — crash partials ARE persisted
  since T4b, see below.

## T4b streaming resilience (S3)

The product review's killer differentiator — streaming that survives app
focus loss, sleep and crashes — is cheap here because the stream task lives
in the Rust core next to the SQLite store: deltas are persisted as they
arrive, not at the end.

### Delta persistence (crash safety)

- Once the API answers 2xx, the stream task creates the assistant row with
  `status='in_progress'` and empty content (a rejected request persists
  nothing assistant-side, as before).
- Every received network chunk's deltas are flushed into that row BEFORE the
  task waits for the next chunk — the same granularity as delta emission,
  no timer batching. A crash/kill mid-stream leaves everything received so
  far in `chat.db`; at most one chunk's worth of text can be lost.
- A clean finish finalizes the row in place (`status='complete'`, final
  content) — the transcript looks exactly like pre-T4b messages.
- A classified error deletes the in-progress row: the partial text is
  dropped by design (unchanged from T4).
- The row is created AFTER the request history is read, so interrupted
  leftovers of previous streams stay part of the history as-is while the
  reply now being generated is not (it has no content yet anyway).

### Stop button

`chat_stop(conversation_id)` aborts the stream task (same generation-counter
registry as `chat_send`; an entry without a spawned task yet counts as
active) and completes every `in_progress` row of the conversation — a
deliberate stop is not a failure: the text that arrived stays persisted,
with no error event and no interrupted marker. The core emits
`chat://stopped {conversation_id}` when a stream was actually stopped
(stopping an idle conversation is a no-op). The composer swaps Send for
"Stop generating" while streaming; the stopped transcript reloads exactly
like a finished one.

### Interrupted marker (crash leftovers)

`messages_list` flags every `status='in_progress'` row (at most one per
conversation: a crash leftover) with `partial: true`. The UI renders a
subtle "message interrupted" notice instead of a clean bubble. Interrupted
rows are never resumed network-wise: the next `chat_send` continues the
conversation history including the partial text as-is.

Schema note: `messages` gains a `status` column (`complete` default).
Existing databases are migrated in place on open (`ALTER TABLE` when the
column is missing); legacy rows render as complete.

### Testing

```sh
node test/t4b-check.mjs
```

Proves the stop path's transport contract against the mock (model
`trigger-slow-stream`: one delta every 200 ms, never ends — a client abort
must be seen as exactly one server-side disconnect after several deltas),
then runs the full Rust suite. The Rust unit tests pin the store-level
guarantees: the kill simulation (partial text persisted without done), the
stop finalize (text kept, no failed marker, idempotent), the `partial` flag
in `messages_list`, the legacy-schema migration, and the stop registry
(`abort_stream` aborts the attached task and reports presence).

## T6 voice: TTS kokoro + dictation whisper (S5, S10)

Both locked tenants serve the audio models (S10), so the voice surface is
identical on either profile: kokoro reads assistant messages aloud and
whisper transcribes composer dictation.

### Architecture: audio never touches the renderer (S4)

All voice HTTP lives in the Rust core, exactly like chat. The renderer only
sees control commands and status events:

- **TTS** (`tts_speak` / `tts_stop`): the core reads the keychain key, sends
  `POST {inference_base}/audio/speech` with `{model: "kokoro", voice, input,
  response_format: "wav"}`, decodes the WAV reply IN MEMORY (rodio's
  wav-only decoder over a `Cursor` — no temp files) and plays it natively
  through the default audio device. The renderer receives `tts://started`,
  `tts://ended` and `tts://error {kind}` events only — never audio bytes,
  the key, or any URL. `tts://error` kinds are chat's `ErrorKind` plus the
  audio-only `decode` kind (a non-WAV or corrupt reply).
- **STT** (`stt_transcribe`): the composer records with the browser's
  `MediaRecorder` (guarded — devices without it get an inline hint), hands
  the bytes to the core over IPC, and the core uploads them as multipart
  (`model=whisper`, `file=<bytes>`) to
  `{inference_base}/audio/transcriptions`, returning `{text}`. Recordings
  are never persisted and never logged; uploads over 25 MiB are rejected
  locally (kind `protocol`) before anything is sent.

Cancel safety mirrors the chat streams: exactly ONE active playback globally
(single-slot registry with a generation counter). Speaking another message
replaces the current playback; `tts_stop` aborts the task, stops the rodio
player and emits `tts://ended` itself — a superseded task never emits stray
events.

### Voice picker

Three kokoro voices are offered (persisted in `localStorage`):
`ef_dora` (ES), `em_alex` (ES), `af_heart` (EN). Anything else is rejected by
the Rust core before any request is made.

### Testing with the voice mock

`test/mock-voice.mjs` is a dependency-free Node server that synthesizes a
valid PCM16 mono 22050 Hz WAV for `/v1/audio/speech` and hand-parses the
multipart upload for `/v1/audio/transcriptions` (port 14324):

```sh
node test/mock-voice.mjs     # mock voice inference on http://127.0.0.1:14324
NAN_DESKTOP_MOCK_INFERENCE=http://127.0.0.1:14324 pnpm tauri dev
```

`trigger-429` / `trigger-500` answer 429/500 on both endpoints for
classification tests; oversized transcription uploads get 413.

Integration check (mock wire contract + full Rust suite):

```sh
node test/t6-check.mjs
```

### What is NOT in the voice MVP

- No pause/resume or progress bar — playback is start/stop only.
- No automatic read-aloud of streaming replies; playback is per
  assistant-message via the ▶ button.
- Dictation is push-to-talk (record → stop → transcribe), not live
  streaming; the transcribed text lands in the composer for review before
  sending.
- macOS microphone permission metadata (Info.plist) is not yet wired — on a
  clean macOS install the browser layer may deny `getUserMedia`; the UI
  surfaces it as an inline hint (T7 packaging will add the plist entry).

## T5 inline image generation (S5)

The composer's small `img` toggle switches it into image mode: the prompt
placeholder becomes "Describe the image", a Size dropdown appears in the
header (default `1024x1024`), and sending runs `image_generate` in the
active conversation. The generated image renders INLINE in the transcript
under the assistant bubble, with the prompt as its caption.

**v1 scope (L13 product review): generation ONLY — there is no image
editing UI** (`flux-2-klein` / `/v1/images/edits` stay out; the model picker
keeps filtering those ids).

### Architecture: bytes stay in the Rust core (S4)

`src-tauri/src/images.rs` mirrors the chat/TTS surfaces: the keychain key is
read by the core, `POST {inference_base}/images/generations` is sent with
`{model: "qwen-image-2.1", prompt, size}`, and the reply is decoded and
saved by the core. The renderer only ever receives status events plus the
saved file's path:

- `images://started` `{conversation_id}` — the task began
- `images://done` `{conversation_id, media_path}` — image saved AND persisted
- `images://error` `{conversation_id, kind}` — classified failure
- `images://stopped` `{conversation_id}` — cancelled or superseded

**The image bytes never cross the IPC boundary** — no base64 payloads in any
event; the transcript's `<img>` loads the saved file through the Tauri
asset protocol (`convertFileSrc`).

- **Reply shape**: only `b64_json` is accepted. A `url` reply is rejected
  with kind `protocol` (S12: a url would point at an arbitrary remote host,
  and the binary refuses any endpoint outside the two owned tenants — it
  fails closed instead of fetching).
- **Sizes**: `WIDTHxHEIGHT`, each dimension in `512..1280` and a multiple of
  16 (bridge-side limits). Invalid sizes are rejected locally (kind
  `protocol`) before any request; presets: `1024x1024` (default),
  `512x512`, `768x512`, `512x768`, `1280x768`, `768x1280`, `1152x896`.
- **Error kinds** (`images://error`): chat's `ErrorKind`. `rate_limited`
  (429) means the tenant's monthly image quota was exhausted — the shared
  100-images/month pool — and renders "Monthly image quota reached";
  `unauthorized` triggers the session-expired banner; `decode` covers an
  undecodable `b64_json` payload.
- **Persistence**: on success the core appends ONE assistant row (`content`
  = the prompt, `model` = `qwen-image-2.1`, `media_path` = the file path).
  The `messages` table gained a `media_path TEXT` column, migrated in place
  on open (same pattern as the `status` column); pre-existing rows read as
  NULL. If the DB insert fails after the file was written, the file is
  deleted — no orphan files.
- **Cancel safety**: the same managed-task registry as the chat streams —
  one active generation per conversation (different conversations generate
  in parallel), a new send aborts the previous one, and while the ~1-minute
  generation runs the composer shows "Generating image (~1 min)" with a
  `Cancel image` button (`image_cancel`).

### Asset protocol scope (renderer file access)

Loading local images from the webview needs Tauri's asset protocol, which
is a renderer-reachable file-read primitive — so it is scoped as tightly as
possible in `tauri.conf.json`:

```json
"assetProtocol": { "enable": true, "scope": ["$APPDATA/images/**"] }
```

Only the generated-images directory is exposed — NOT the whole app data
dir (`chat.db`, `profiles.json` and the keychain-backed state stay
unreadable from the renderer). The CSP gained the matching `img-src
asset: http://asset.localhost` sources (production and dev), and the `tauri`
crate gained the `protocol-asset` feature (required by the build script
once `enable` is set).

### Testing with the image mock

`test/mock-images.mjs` (port 14325) answers `POST /v1/images/generations`
with a tiny valid 1x1 PNG as `b64_json`, enforces the same size rules as
the Rust core, and triggers 429 via model `trigger-429` or the
`x-nan-test-429: 1` header:

```sh
node test/t5-check.mjs
```

Proves the wire contract (b64 → PNG signature, size guard, 401/429/500
classification, no `url` replies, key never recorded) and then runs the
full Rust suite. The Rust unit tests pin the pure surface: size validation
(bounds, multiples of 16, malformed strings), response parsing (`b64_json`
accepted, `url` rejected as protocol, undecidable payloads as `decode`),
path handling (uuid `.png` names under the images dir), the
per-conversation cancel-safe registry, and the store round-trip with
`media_path` plus the legacy-schema migration.

### What is NOT in the image MVP

- No image editing (`flux-2-klein` / `/v1/images/edits`) — v1 scope
  decision (L13).
- No vision upload (attaching images to chat prompts) — still T5 future
  work.
- No quota counter UI: the app learns about quota exhaustion only from the
  429 reply.
- Generated files live until the conversation is deleted with the app
  running — deleting a conversation does not yet delete its image files
  (they stay orphaned on disk, unreferenced by the transcript).

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
