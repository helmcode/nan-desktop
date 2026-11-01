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

## Using the app (UX overview)

The app is built for non-technical users: everything is pre-made and
self-contained, the UI copy is Spanish, and no technical term (API, SSE,
IPC, SQLite, keys, providers…) ever reaches the screen. There is no
developer surface in the UI — the old T1 spike diagnostics and the tools
"demo" panel are gone, and so are their IPC commands.

| Screen | What the user sees |
| --- | --- |
| Welcome | Helmcode mark + two account cards (Comunidad NaN / Helmcode para empresas). Sign-in is confirmed in the browser. |
| Authorizing | The device code in large Roboto Mono, "Esperando tu confirmación…", Cancel. Denied/expired/error states each explain what happened and offer "Volver a intentarlo". |
| Chat | Sidebar (mark, "Nueva conversación", history), header (model picker + gear), messages with citation chips, composer with the **workspace chip**, image mode, dictation and send. |
| Settings (gear) | **Carpetas de trabajo**, **Memoria**, **Voz**, **Acerca de** (account, version, sign out). Esc or "Volver al chat" returns. |

**Workspace chip (composer).** The user never has to wonder where the
assistant works. The chip always says it: `Carpeta privada: <name>` (folders
picked with the native picker), `Elegir carpeta de trabajo` when none is set
(one click opens the picker), or — amber — `Todo el equipo — bajo tu
responsabilidad`. One click opens a menu to switch, add a folder or manage
folders. Switching to the whole computer first shows a plain-language
warning, then the Rust core's own native confirmation (see "Computer-wide
mode" in the T8 section).

**Activity line.** While the assistant searches the web or waits for a file
permission the reply shows a calm status ("Buscando en internet…",
"Esperando tu permiso para usar tus archivos…") instead of silence.

### Design system (Helmcode brand kit)

Tokens live at the top of `src/App.css`:

- Canvas `#0a0a0a` (warm black), surfaces `#111111` / `#161616`.
- Text `#ffffff`, `rgba(255,255,255,.55)`, `rgba(255,255,255,.35)` (never
  lower; `.35` only for decoration/disabled — body text stays ≥ `.55` for
  WCAG AA).
- Accent indigo `#4934E1` in at most 4–5 moments per screen: the primary
  button, the active conversation, the focus ring, one status. Small accent
  text uses `#818CF8` (base indigo is never used as text below ~24px).
- Severity colors only for severity: `#ff5f56` error, `#ffbd2e` warning
  (the whole-computer mode), `#27c93f` ok.
- Typography: Roboto (UI) + Roboto Mono (device codes, model ids, paths,
  code). The CSP allows same-origin fonts only, so the stack falls back to
  the system sans/mono until the font files are bundled
  (`pnpm add @fontsource-variable/roboto @fontsource-variable/roboto-mono`
  and import them in `src/main.tsx`).
- Radii 8–12px, generous spacing, one focus treatment (indigo ring),
  `prefers-reduced-motion` honored.
- Brand mark: `src/icons.tsx` (`BrandMark`, `Wordmark` "helmcode_") and
  `public/helmcode-symbol.svg` (favicon). These are drawn to the hexagon
  symbol spec; replace them with the official
  `branding/helmcode-symbol-{color,white}.svg` files when syncing assets.

### Web search (built-in, P1-7)

There is no search button or toggle: every chat request offers the model a
`web_search` function (OpenAI tool-calling). When the model calls it, the
Rust core sends `POST {platform_base}/v1/search {"query": "…"}` with the
session JWT from the keychain; our platform API answers
`{results:[{title, url, snippet}]}`. The provider behind that API is never
named in the app (a unit test guards the tool definition). The results go
back to the model, the answer keeps streaming, and the cited pages are saved
with the message and shown as small citation chips (click → system browser
through `open_external`, https-only).

Silent degradation: no session, offline, 404 (endpoint not deployed yet),
5xx or a malformed body all yield "no results" — the model is told to answer
without the search and the user sees nothing unusual. A server that rejects
the `tools` field (400) is retried once without tools. At most 6 tool rounds
per reply; the last round offers no tools.

### Conversation memory (P1-6)

Your conversations are saved in your account by default, so they are
available on every device you sign in to. In **Ajustes → Memoria** you can
switch to **Solo en este dispositivo**.

- **Account (default).** The app keeps a local copy and syncs it with your
  account in the background: at startup, after each reply or image, and
  after you delete a conversation. Sync downloads conversations from your
  other devices, uploads the ones that changed here, and removes the ones you
  deleted. When the same conversation changed in two places, the most recent
  version wins. A conversation is never changed while a reply is still being
  written.
- **Only on this device.** Conversations stay in the local database
  (`chat.db` in the app data folder) and nothing is sent anywhere.
- **Switching** moves your history once, in the right direction: to the
  account when you choose account storage, down to this device when you
  choose device-only storage. You never configure anything.
- **Images** are files on this device. They never leave it; only the text of
  a conversation is synced.
- **Offline or not yet available.** If the account memory can't be reached
  (unreachable, timeout, 401/403/404/5xx), the app quietly keeps working
  with the local copy for the rest of the session and syncs the next time.
  You see no error, and you are never signed out because of it.

Under the hood: `src-tauri/src/memory.rs` defines a `MemoryBackend`
abstraction with `RemoteMemory` (`GET` / `PUT
{platform}/api/memory/conversations`, `DELETE
{platform}/api/memory/conversations/{id}`, Bearer = sign-in session from the
OS keychain, never sent to the app window) and `LocalMemory` (SQLite). Each
device has a random device id stored in `memory.json` in the app data folder,
together with the chosen mode. Commands: `memory_settings_get`,
`memory_set_mode`, `memory_sync` (always `Ok`; returns whether the list
changed).

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
  UI shows the "Tu sesión ha caducado" banner with a "Volver a entrar"
  action), `rate_limited` (429), `server` (other non-2xx), `network`
  (transport), `protocol` (local failures). Errors render inline in the
  message area — never `alert()`.
- **Persistence** (`src-tauri/src/chat_store.rs`, SQLite file `chat.db` in
  the app data dir): tables
  `conversations(id, title, profile_id, created_at, updated_at, remote_id,
  synced_at)`, `messages(id, conversation_id, role, content, model,
  media_path, created_at, status, sources)` and `memory_tombstones`
  (`status`: `complete` default, `in_progress` while streaming — T4b;
  `sources`: JSON citation list from web search; `remote_id`/`synced_at`/
  tombstones: memory sync). The
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

Chosen in **Ajustes → Voz** (it used to sit in the chat header). Three
kokoro voices are offered (persisted in `localStorage`):
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

## T8 tools: folder grants + propose/approve/execute (S7)

The tools subsystem lets the assistant work inside folders the user has
explicitly granted — with the security boundary in the **Rust core**, never
in the web renderer. The flow is: **model REQUESTS (tool call) → Rust core
validates and stores a proposal → USER approves/denies in a NATIVE dialog →
Rust core executes ONLY the exact approved action → result goes back to the
model**.

### Flow

1. **Grants.** The user grants one or more folders per profile with the
   native folder picker (`tauri-plugin-dialog`, opened from Rust — there is
   no typed-path IPC), or enables the computer-wide mode (below). Grants
   are stored canonicalized in `tools.json` under the app data dir.
2. **Model tool call.** When the profile has a workspace, every chat
   request offers the file tools (`list_files`, `read_file`, `write_file`,
   `replace_file`; `run_command` only when enabled) plus a system message
   naming the workspace folders. A call is mapped onto a `ToolAction` and
   validated against the grants: absolute paths only, lexical `..`
   rejected, symlinks resolved — the canonical path must sit
   component-wise under a granted root and outside the app data dir.
   The core stores a proposal (TTL 5 minutes, single-use, uuid id) with a
   summary + unified diff (vendored LCS diff).
3. **Approve / deny — every action.** The core shows a native dialog in
   plain Spanish naming the exact file/folder/command (writes include a
   short preview of the change). "Permitir" executes the EXACT stored
   action — paths are re-canonicalized and re-verified under the grant
   right before use, so symlink swaps, grant revocations, or the
   run_command switch flipping in between all fail closed. "No permitir"
   consumes the proposal as a deny and tells the model not to retry.

The renderer can no longer propose or execute anything: the former
`tools_propose` / `tools_execute` / `tools_deny` / `tools_audit_tail` IPC
test surface was removed together with the demo panel.

### Threat model

- **Renderer compromise cannot read or write the disk.** There is no
  "read this path" IPC: the only file access runs through a stored,
  single-use, TTL-bounded proposal whose canonical path was grant-checked
  at propose time and re-verified at execute time.
- **Symlink escapes fail closed.** Canonicalization at propose,
  under-grant verification at execute, and re-canonicalization equality
  right before I/O (`verify_stable`/`verify_writable`). Writes refuse a
  symlink LEAF outright, and — since a dangling symlink BETWEEN the grant
  root and the leaf is invisible to canonicalization but would be
  followed by `fs::write` the moment its target materializes —
  `verify_writable` also walks EVERY path component and rejects any
  symlink component (not just the leaf). Lexical `..` is rejected before
  any I/O.
- **Audit.** Every propose/approve/deny/execute outcome (plus grant and
  switch changes, and propose-time REJECTIONS such as escape attempts) is
  appended as JSONL to `tools-audit.log` — paths and summaries ONLY, never
  file contents. Audit write failures fail closed.
- **Commands kill their process group.** `run_command` children run in
  their own process group; the timeout kill is a group SIGKILL, so forked
  children cannot outlive the kill while holding the pipes. The output
  drain waits bounded (2 s grace): a grandchild that outlives the shell
  cannot hang `execute` — the residual is that the abandoned drain thread
  and the reparented grandchild live until the grandchild exits, and a
  double-fork daemon can survive the kill entirely (its output is then
  lost/truncated).
- **Known limitation (documented, acceptable for v1):** a sub-millisecond
  TOCTOU window remains between the final verification and the actual
  open() (a full fix needs openat2/RESOLVE_BENEATH or per-open
  verification). Also, `fs::write` on a FIFO inside a grant BLOCKS until a
  reader appears (soft DoS — but only after the user explicitly approved
  that exact write), and `run_command` children inherit the app's full
  environment. By design the app keeps NO secrets in environment
  variables (credentials live in the OS keychain, S4), so there is
  nothing env-level for an approved command to leak.

### Caps

| Cap | Value |
| --- | --- |
| read/write size | 2 MiB per file |
| binary detection | NUL byte in first 8 KiB → refused ("binary file") |
| list_files | depth ≤ 3, 500 entries max (summary notes truncation) |
| run_command output | 64 KiB per stream, 30 s timeout then kill |
| proposal lifetime | 5 min TTL, single-use |

### run_command — EXPERIMENTAL, OFF by default

`run_command` executes a shell command (`sh -c` / `cmd /C`) inside a
granted cwd. It is **disabled by default** (`tools_allow_run_command: false`
in `tools.json`); enabling it requires a NATIVE confirmation dialog shown
from the Rust core (a renderer cannot fake it), per-action approval ALWAYS
applies as another native dialog, and the flag is re-checked at execute
time. A shell can do anything the user could — the native confirmation is
the control. Keep it OFF unless you need it.

### Native confirmations (renderer-proof approvals)

Approvals are NATIVE dialogs rendered by the Rust core via
`tauri-plugin-dialog`, not web UI a compromised renderer could fake or
auto-click:

- Every model tool action (reads included): "Permitir" / "No permitir"
  with the target path or command; declining consumes the proposal as a
  deny (nothing runs).
- `tools_set_run_command_enabled(true)`: warning dialog; cancel keeps the
  flag off (audited as `settings/ignored`).
- `tools_grant_add`: the ONLY path in is the native folder picker opened
  from Rust — the picked path never crosses the renderer, and the
  protected-scope policy below applies.
- `tools_grant_computer_wide`: warning dialog ("Activar bajo mi
  responsabilidad"); the core creates the grant only when it is confirmed.

**Threading (P0-3 regression note).** Tauri v2 runs SYNC commands on the
main thread, and the dialog plugin's `blocking_pick_folder()` /
`blocking_show()` wait for the main thread to present the dialog — a sync
command calling them deadlocks the app (the "Choose folder…" hang on
macOS). Every dialog-opening command is therefore `async` and runs the
blocking call on Tauri's blocking pool (`spawn_blocking`, helper
`off_main_thread` in `tools/mod.rs`). Never call a `blocking_*` dialog API
from a sync command.

### Grant scope policy (protected locations)

`validate_grant_scope` (Rust, unit-tested with injected dirs) rejects a
grant when the canonical path is: the app data dir or anything INSIDE it
(tools-grants.json, tools-audit.log, chat.db, profiles.json — an approved
write must never be able to rewrite the tool policy itself); the
filesystem root; `$HOME` itself; or any folder that CONTAINS the app data
dir (granting ~ would cover it). Subtrees of `$HOME` outside the app data
(e.g. `~/Projects`) and unrelated folders are fine.

### Computer-wide mode (P1-5)

Grants carry a `scope`: `folder` (default; files written before scopes
existed load as `folder`) or `computer_wide`. A computer-wide grant is
rooted at the canonical `$HOME` and is created ONLY by
`tools_grant_computer_wide`, after the user confirms the core's native
warning (the UI shows a plain-language explanation first). `$HOME` stays
rejected for normal folder grants. Even in this mode:

- every action is still approved one by one in a native dialog;
- the app data dir (tool policy, audit log, profiles, chat DB) is off
  limits: `is_protected` is checked at propose time AND again right before
  execution, whatever the grant;
- the filesystem root can never be a grant root.

Switching back to "Carpeta privada" revokes the computer-wide grant.

### Link safety (two independent layers)

Model-generated links can never navigate the main window (in-window
phishing):

1. **Rust navigation guard**: the main window is created programmatically
   with `WebviewWindowBuilder::on_navigation` — an allowlist (app origins,
   asset protocol, about/blob/data/ipc, dev server) decides every
   navigation; remote http(s) origins are cancelled.
2. **Frontend**: markdown anchors render as a NEUTRAL element (no href).
   Clicking invokes `open_external(url)`, a Rust command that validates
   the URL (https-only, host required, no credentials) before handing it
   to the OS opener; the URL is shown as visible text next to the link.

### Dependency auditing

CI runs `pnpm audit --prod --audit-level high` (fails on high+).
Rust-side auditing (cargo-audit / cargo-deny) is a MANUAL step for now:
run `cargo install cargo-audit && cargo audit` from `src-tauri/` when
reviewing dependency changes.

### UI

- **Ajustes → Carpetas de trabajo**: friendly cards ("El asistente puede
  leer y escribir en <carpeta>"), "Añadir carpeta…" (native picker),
  "Quitar", "Dar acceso a todo el equipo…" (amber), and the red-warned
  "Ejecutar órdenes en tu equipo (Experimental)" switch.
- **Composer workspace chip**: shows and switches where the assistant
  works (see "Using the app").
- The audit log is still written for every action; the viewer left the UI.

### What's NOT included

- Hard-link escape detection (only symlinks and `..` are handled).
- File watching / live diffs: the proposal diff is computed at propose
  time; if the file changes before execution, replace_file re-validates
  uniqueness against the current content and otherwise applies the exact
  approved old→new replacement.
- Streaming command output (run_command result arrives whole, capped).
- Recursive delete, move, or any destructive action type — not in the v1
  action set.

### Verify

```sh
cargo test                # from src-tauri (tools::* suites)
pnpm build                # frontend gate
node test/t8-check.mjs    # drives cargo test + audit JSONL schema
```

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
## Foundations (formerly the T1 spike)

The T1 spike proved SSE streaming, keychain storage and SQLite history; all
three now live in the product (`sse.rs` parser used by `chat.rs`, keychain
credentials in `device_flow.rs`/`chat.rs`, `chat_store.rs`). The spike
diagnostics panel, its debug-only IPC commands (`sse_demo_start`,
`keyring_set`, `keyring_get`, `db_demo`), the `spike_db` module, the
`SseState` demo plumbing and `test/spike-check.mjs` / `test/mock-sse.mjs`
were removed: debug and release builds expose the same, product-only IPC
surface. The SSE parser keeps its unit tests in `sse.rs`.

### What is NOT yet implemented

- Updater and code signing (T2/T7) and the Linux CI build, as deferred from
  T1.

### What remains untested (deferred per spec T1)

- **Keyring automated test**: deliberately omitted — macOS may pop a
  Keychain permission prompt in headless runs. The account-name conventions
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
cargo clippy --all-targets -- -D warnings
cargo test
```
