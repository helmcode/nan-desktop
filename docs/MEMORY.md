# How memory works

**Principle: the working copy is always local.** The chat reads and writes a
SQLite database on your device (`chat.db`). The cloud is a *sync*, never a
dependency: if it is unreachable, everything keeps working.

## Cloud sync (default)

- Every conversation is stored in **your account** through the platform's
  memory API — `api.nan.builders` (NaN) or `api.helmcode.com` (Helmcode) —
  authenticated with your login session. Your inference key never travels
  there; it never leaves the Rust core.
- Sync is **incremental** with a cursor based on the **server's** clock
  (`synced_at`), so a device with a skewed clock cannot hide changes. The
  merge is idempotent: the newest copy of each conversation wins, deletions
  propagate.
- **Multi-device by design**: same account, same conversations on every
  machine you sign in from.
- **Abuse limits**: 2 MiB per message, 50 MiB per user, 200 conversations
  (oldest are evicted), and a read rate limiter.
- **Strict isolation**: every row carries your `user_id` (plus `org_id` on
  Helmcode enterprise) — no user can ever read or write another user's
  memory.

## Local-only mode (optional, in Settings)

- Nothing ever leaves your device.
- Switching modes performs a one-time migration in the direction of the
  change (local → cloud uploads, cloud → local downloads), safe to
  interrupt.
- You can switch back at any time without duplicates.

## Silent degradation

If the platform is unreachable (timeout, maintenance, memory API absent),
the app keeps working 100% locally and reconciles on the next cycle. The
chat never blocks and you are never signed out because of it.

## What NEVER leaves your device

- **Images** you generate or view (local files, never synced). The one
  exception is an image you explicitly send to **Edit**: its bytes go to the
  platform's edit endpoint for that request only (see below).
- **Credentials** (the encrypted local vault, see SECURITY.md).
- **Your prompts and responses**: the platform keeps a strict zero-logs
  policy — no prompt or response content is recorded anywhere.

## At rest on your machine

- `chat.db` is plain SQLite, protected by OS user separation and disk
  encryption (FileVault/BitLocker) — the same tradeoff ChatGPT, Claude and
  other desktop assistants make.
- Credentials are stronger: AES-256-GCM in an encrypted vault whose master
  key lives in the OS keychain (release builds) — see SECURITY.md.

## Image edits (lineage)

Editing an image (NaN community, desktop sessions only) sends the 1 to 3
selected images and your instruction to `POST /v1/images/edits` on the
platform API, authenticated with your desktop login session (never the
inference key). The Rust core reads the image bytes from disk itself; only
this app's own images are accepted: chat images under `<app data>/images`
and files you pick with the native dialog, which must sit inside one of
your working folders and are never taken from credential, login-item,
shell-startup or key-file locations (copied to `<app data>/images/staged`,
removed after a successful edit or after 24 h). The result comes back
inline (`b64_json`), is saved locally like a generated image and stored in
`chat.db` as a new assistant row whose `parent_message_id` points at the
message the source image came from; the chat shows it with an "Edited"
badge and a link to the original. Image rows stay device-local: like every
image, edits are never part of the cloud sync. The instruction text and
image bytes are never logged.

## Chat model picker (allowlist)

The model picker is allowlist-driven, not a blocklist. `src-tauri/chat-models.json`
lists the exact `/v1/models` ids to show (`models`, in display order) and the
`headliner` that is always first and is the default model. Ids the server
serves but the file does not list never appear; listed ids the server does not
serve are omitted. To change the picker, edit only that file (keep `headliner`
equal to `DEFAULT_MODEL` in `src-tauri/src/chat.rs` and `src/App.tsx` — a unit
test pins it). The file is embedded at compile time; a malformed file falls
back to the built-in default (`deepseek-v4-flash`, `glm5.3`, `glm5.3-flash`).
