//! Inline image generation (T5, S5): `qwen-image-2.1` through
//! `POST {inference_base}/images/generations`.
//!
//! Architecture mirrors `chat.rs` (S4): the key is read from the OS keychain
//! (account = profile id, derived from the conversation row — the renderer
//! never sends secrets or URLs), the request is sent from the Rust core with
//! body `{model: "qwen-image-2.1", prompt, size}`, and the reply is decoded
//! and saved as a PNG under `app_data_dir/images/<uuid>.png`. The web
//! renderer never sees the key, any URL, or the image bytes — only status
//! events and the saved file's path:
//!
//! - `images://started` `{conversation_id}` — the task began
//! - `images://done`    `{conversation_id, media_path}` — image saved AND
//!   persisted as an assistant message row (`media_path` column)
//! - `images://error`   `{conversation_id, kind}` — classified failure
//! - `images://stopped` `{conversation_id}` — the user cancelled (or a new
//!   generation superseded the running one in the same conversation)
//!
//! Error kinds are chat's [`chat::ErrorKind`]. On this surface `rate_limited`
//! (429) means the tenant's monthly image quota was exhausted (the shared
//! 100-images/month pool), so the UI renders a quota message. `decode` is
//! the only image-specific use of the audio-introduced kind: a `b64_json`
//! payload that fails to base64-decode (or decodes to zero bytes).
//!
//! **The `url` reply variant is deliberately REJECTED with kind `protocol`
//! (S12).** The OpenAI images API may answer `{"data":[{"url": …}]}` where
//! the URL points at an arbitrary remote host; downloading it would turn the
//! app into a fetcher for third-party endpoints, which S12 forbids ("the app
//! binary refuses any endpoint outside the two owned tenants"). Both tenants
//! serve `b64_json`; if a future backend flips to `url`-only replies the app
//! fails closed instead of opening an exfiltration/fetch channel.
//!
//! Generation takes ~1 minute per image, so `image_generate` is a managed
//! task (same cancel-safe registry pattern as the chat streams): exactly one
//! active generation per conversation, a new send aborts the previous one,
//! `image_cancel` aborts it explicitly. Different conversations may generate
//! in parallel.
//!
//! Persistence: on success the core appends ONE assistant message row
//! (`content` = prompt, `model` = qwen-image-2.1, `media_path` = the saved
//! file) via `chat_store::insert_image_message`. If the DB insert fails the
//! already-written file is deleted — no orphan files. The renderer then
//! loads the image through the Tauri asset protocol (scope pinned to
//! `app_data_dir/images` in `tauri.conf.json`); the bytes themselves never
//! cross the IPC boundary (S4).
//!
//! Scope note (L13): v1 is GENERATION ONLY — no image editing surface
//! (`flux-2-klein` / `/v1/images/edits`) is exposed.
//!
//! Zero telemetry (S8): the only host contacted is the conversation
//! profile's own inference base — a compiled-in constant (S2); in debug
//! builds the `NAN_DESKTOP_MOCK_INFERENCE` environment variable may point it
//! at a local mock (`test/mock-images.mjs`), exactly like the chat surface.
//! Release builds ignore the variable entirely (S12).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::chat;
use crate::chat_store;

/// The image-generation model both locked tenants serve (S5).
pub const IMAGE_MODEL: &str = "qwen-image-2.1";

/// Default generation size (1k tier; see `validate_size`).
pub const DEFAULT_SIZE: &str = "1024x1024";

/// Size bounds (bridge-side limits, mirrored by the mock): every dimension
/// must be within `[MIN_DIM, MAX_DIM]` and a multiple of [`DIM_STEP`].
pub const MIN_DIM: u32 = 512;
pub const MAX_DIM: u32 = 1280;
pub const DIM_STEP: u32 = 16;

// ---------------------------------------------------------------------------
// Pure, unit-tested core
// ---------------------------------------------------------------------------

/// Validate a `WIDTHxHEIGHT` size string (e.g. `1024x1024`): both dimensions
/// must be integers within `[MIN_DIM, MAX_DIM]` and multiples of
/// [`DIM_STEP`]. Lowercase `x` only, no whitespace. Rejected before any
/// network work with kind [`chat::ErrorKind::Protocol`].
pub fn validate_size(size: &str) -> Result<(u32, u32), chat::ErrorKind> {
    let Some((w, h)) = size.split_once('x') else {
        return Err(chat::ErrorKind::Protocol);
    };
    let parse_dim = |dim: &str| -> Option<u32> {
        // Strict: digits only (a leading `+` or `-` never parses as u32 with
        // this check; fullwidth digits are rejected by `all` too).
        if dim.is_empty() || !dim.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        dim.parse::<u32>().ok()
    };
    let (Some(w), Some(h)) = (parse_dim(w), parse_dim(h)) else {
        return Err(chat::ErrorKind::Protocol);
    };
    let valid = |d: u32| (MIN_DIM..=MAX_DIM).contains(&d) && d.is_multiple_of(DIM_STEP);
    if valid(w) && valid(h) {
        Ok((w, h))
    } else {
        Err(chat::ErrorKind::Protocol)
    }
}

/// Build the OpenAI-compatible `/images/generations` JSON body.
pub fn image_body(prompt: &str, size: &str) -> serde_json::Value {
    serde_json::json!({
        "model": IMAGE_MODEL,
        "prompt": prompt,
        "size": size,
    })
}

/// Parse the OpenAI images response body and return the decoded PNG bytes.
///
/// - `{"data":[{"b64_json": "…"}]}` → base64-decoded bytes (both tenants'
///   shape). An undecodable payload or a zero-byte result is
///   [`chat::ErrorKind::Decode`].
/// - `{"data":[{"url": "…"}]}` (with no usable `b64_json`) →
///   [`chat::ErrorKind::Protocol`] — S12: a URL would point at an arbitrary
///   remote host, and the app only ever talks to the two locked tenants.
/// - Anything else (malformed JSON, empty `data`, neither field) →
///   [`chat::ErrorKind::Protocol`].
pub fn parse_images_response(body: &str) -> Result<Vec<u8>, chat::ErrorKind> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| chat::ErrorKind::Protocol)?;
    let item = value
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|data| data.first())
        .ok_or(chat::ErrorKind::Protocol)?;
    // Only the first item is consumed (n=1 in this app). `b64_json` is the
    // only accepted shape; a `url` reply is rejected below (S12).
    if let Some(b64) = item.get("b64_json").and_then(|b| b.as_str()) {
        let bytes = BASE64_STANDARD
            .decode(b64)
            .map_err(|_| chat::ErrorKind::Decode)?;
        if bytes.is_empty() {
            return Err(chat::ErrorKind::Decode);
        }
        return Ok(bytes);
    }
    if item.get("url").and_then(|u| u.as_str()).is_some() {
        // S12: a url reply points at an arbitrary remote host. The app only
        // ever talks to the two locked tenants — fail closed, never fetch.
        return Err(chat::ErrorKind::Protocol);
    }
    Err(chat::ErrorKind::Protocol)
}

/// The directory generated images are saved under: `<app data>/images`.
pub fn images_dir(app_data: &Path) -> PathBuf {
    app_data.join("images")
}

/// Save image bytes as `<dir>/<uuid>.png` (creating `dir` if missing) and
/// return the absolute path. The uuid file name keeps concurrent generations
/// from colliding and needs no extra metadata in the store.
pub fn save_png(dir: &Path, bytes: &[u8]) -> Result<PathBuf, chat::ErrorKind> {
    std::fs::create_dir_all(dir).map_err(|_| chat::ErrorKind::Protocol)?;
    let path = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).map_err(|_| chat::ErrorKind::Protocol)?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// Event payloads (the renderer never sees the key, URLs or image bytes — S4)
// ---------------------------------------------------------------------------

/// `images://started` — the generation task began.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImagesStartedPayload {
    pub conversation_id: i64,
}

/// `images://done` — the image was saved and persisted as a message row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImagesDonePayload {
    pub conversation_id: i64,
    pub media_path: String,
}

/// `images://error` — classified failure; nothing persisted, no file left.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImagesErrorPayload {
    pub conversation_id: i64,
    pub kind: chat::ErrorKind,
}

/// `images://stopped` — the user cancelled (or superseded) the generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImagesStoppedPayload {
    pub conversation_id: i64,
}

// ---------------------------------------------------------------------------
// Active-generation registry (cancel-safe: one generation per conversation)
// ---------------------------------------------------------------------------

/// One registry entry: the generation counter and (once attached) the
/// generation task's handle. Same reserve → spawn → attach shape as the
/// chat streams and the TTS playback.
struct ActiveImage {
    generation: u64,
    handle: Option<JoinHandle<()>>,
}

/// Active generations keyed by conversation id.
#[derive(Default)]
pub struct ImagesState(Mutex<HashMap<String, ActiveImage>>);

/// Atomically abort the previous generation for `conversation_id` (if any)
/// and reserve the next generation. No handle yet — `attach_image` adds it.
fn reserve_image(state: &ImagesState, conversation_id: i64) -> Result<u64, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "images state mutex poisoned".to_string())?;
    let map_key = conversation_id.to_string();
    let generation = guard
        .get(&map_key)
        .map(|entry| entry.generation + 1)
        .unwrap_or(1);
    if let Some(ActiveImage {
        handle: Some(handle),
        ..
    }) = guard.remove(&map_key)
    {
        handle.abort();
    }
    guard.insert(
        map_key,
        ActiveImage {
            generation,
            handle: None,
        },
    );
    Ok(generation)
}

/// Attach the freshly spawned handle to its reserved generation. If another
/// generate already superseded this one (a higher generation is registered),
/// the handle is aborted immediately — the superseded task never emits.
fn attach_image(
    state: &ImagesState,
    conversation_id: i64,
    generation: u64,
    handle: JoinHandle<()>,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "images state mutex poisoned".to_string())?;
    let map_key = conversation_id.to_string();
    match guard.get(&map_key) {
        Some(entry) if entry.generation == generation => {
            if let Some(entry) = guard.get_mut(&map_key) {
                entry.handle = Some(handle);
            }
            Ok(())
        }
        _ => {
            handle.abort();
            Ok(())
        }
    }
}

/// Remove this task's registry entry — but only if it is still the newest
/// (a superseding task must not be evicted by the task it replaced).
fn release_image(state: &ImagesState, conversation_id: i64, generation: u64) {
    if let Ok(mut guard) = state.0.lock() {
        let map_key = conversation_id.to_string();
        if guard.get(&map_key).map(|entry| entry.generation) == Some(generation) {
            guard.remove(&map_key);
        }
    }
}

/// Abort and remove the active generation entry for a conversation — the
/// cancel path. Returns whether an active entry existed. An entry without an
/// attached handle yet (a send that has not spawned its task) counts as
/// active: `attach_image` will abort that task the moment it registers.
fn abort_image(state: &ImagesState, conversation_id: i64) -> Result<bool, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "images state mutex poisoned".to_string())?;
    match guard.remove(&conversation_id.to_string()) {
        Some(entry) => {
            if let Some(handle) = entry.handle {
                handle.abort();
            }
            Ok(true)
        }
        None => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Generate an image in a conversation: validate, then run the ~1-minute
/// generation as a managed task. Returns immediately; progress arrives via
/// `images://started`, `images://done`, `images://error` and
/// `images://stopped` events. The profile is derived from the conversation
/// row (same as `chat_send`) so the key and the persisted row always belong
/// to the same tenant.
#[tauri::command]
pub fn image_generate(
    app: AppHandle,
    window: Window,
    conversation_id: i64,
    prompt: String,
    size: String,
) -> Result<(), String> {
    // Local validation before any work; the renderer gets a command error
    // (no event needed — it never left the button handler).
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("prompt is empty".to_string());
    }
    // Defensive fallback: the UI always sends an explicit size; an empty
    // one falls back to the 1k-tier default instead of erroring the send.
    let size = if size.trim().is_empty() {
        DEFAULT_SIZE.to_string()
    } else {
        size
    };
    validate_size(&size).map_err(|kind| format!("invalid size {size:?} ({kind:?})"))?;

    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let conn = chat_store::open_db(&dir)?;
    let conversation = chat_store::conversation_get(&conn, conversation_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("unknown conversation id: {conversation_id}"))?;

    let state = app.state::<ImagesState>();
    // Cancel-safe: reserve (aborting the previous generation for this
    // conversation) before spawning, then attach the handle to the reserved
    // generation so a superseded task is aborted instead of orphaned.
    let generation = reserve_image(&state, conversation_id)?;
    let handle = tauri::async_runtime::spawn(run_image_generation(
        app.clone(),
        window,
        conversation_id,
        conversation.profile_id,
        prompt,
        size,
        generation,
    ));
    attach_image(&state, conversation_id, generation, handle)?;
    Ok(())
}

/// The managed generation task: read the keychain key, POST
/// `/images/generations`, parse + save the PNG, persist the assistant row
/// (deleting the file if the insert fails) and emit the lifecycle events.
/// `generation` identifies this task in the registry — a superseded task
/// never emits.
async fn run_image_generation(
    app: AppHandle,
    window: Window,
    conversation_id: i64,
    profile_id: String,
    prompt: String,
    size: String,
    generation: u64,
) {
    let state = app.state::<ImagesState>();
    let _ = window.emit("images://started", ImagesStartedPayload { conversation_id });

    let emit_error = |kind: chat::ErrorKind| {
        release_image(&state, conversation_id, generation);
        let _ = window.emit(
            "images://error",
            ImagesErrorPayload {
                conversation_id,
                kind,
            },
        );
    };

    // ---- credentials + endpoint (Rust core only, S4) ---------------------
    let key = match chat::read_profile_key(&profile_id) {
        Ok(key) => key,
        Err(kind) => return emit_error(kind),
    };
    let Some(base) = chat::inference_base(&profile_id) else {
        return emit_error(chat::ErrorKind::Protocol);
    };

    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(chat::CONNECT_TIMEOUT_SECS))
        .build()
    {
        Ok(client) => client,
        Err(_) => return emit_error(chat::ErrorKind::Protocol),
    };

    // ---- POST /images/generations ------------------------------------------
    // No overall request timeout: a ~1-minute generation must not be killed
    // mid-flight (same policy as the chat streams).
    let response = match client
        .post(format!("{base}/images/generations"))
        .bearer_auth(&key)
        .json(&image_body(&prompt, &size))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => return emit_error(chat::classify_transport(err.is_timeout())),
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        // 429 here is the tenant's monthly image quota (shared 100/month
        // pool) — the UI renders a quota message for `rate_limited`.
        return emit_error(chat::classify_chat_status(status));
    }
    let body = match response.text().await {
        Ok(body) => body,
        Err(err) => return emit_error(chat::classify_transport(err.is_timeout())),
    };
    let bytes = match parse_images_response(&body) {
        Ok(bytes) => bytes,
        Err(kind) => return emit_error(kind),
    };

    // ---- save + persist (no orphan files) -----------------------------------
    let app_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => return emit_error(chat::ErrorKind::Protocol),
    };
    let path = match save_png(&images_dir(&app_dir), &bytes) {
        Ok(path) => path,
        Err(kind) => return emit_error(kind),
    };
    let media_path = path.to_string_lossy().to_string();
    let conn = match chat_store::open_db(&app_dir) {
        Ok(conn) => conn,
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            return emit_error(chat::ErrorKind::Protocol);
        }
    };
    let persisted =
        chat_store::insert_image_message(&conn, conversation_id, &prompt, IMAGE_MODEL, &media_path)
            .and_then(|_| chat_store::touch_conversation(&conn, conversation_id));
    if persisted.is_err() {
        // The row could not be written — delete the file so no orphan is
        // left behind (the renderer only ever shows DB-backed images).
        let _ = std::fs::remove_file(&path);
        return emit_error(chat::ErrorKind::Protocol);
    }

    release_image(&state, conversation_id, generation);
    let _ = window.emit(
        "images://done",
        ImagesDonePayload {
            conversation_id,
            media_path,
        },
    );
}

/// Cancel the active generation for a conversation (if any) and emit
/// `images://stopped` so the renderer resets its generating state. No-op
/// when the conversation has no active generation.
#[tauri::command]
pub fn image_cancel(app: AppHandle, window: Window, conversation_id: i64) -> Result<(), String> {
    let state = app.state::<ImagesState>();
    if abort_image(&state, conversation_id)? {
        // The stopped task never emits (its entry is gone): report the end
        // from here so the renderer's generating state resets immediately.
        let _ = window.emit("images://stopped", ImagesStoppedPayload { conversation_id });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use tempfile::TempDir;

    // ---- validate_size ------------------------------------------------------

    #[test]
    fn accepts_the_default_and_common_sizes() {
        assert_eq!(validate_size(DEFAULT_SIZE), Ok((1024, 1024)));
        assert_eq!(validate_size("512x512"), Ok((512, 512)));
        assert_eq!(validate_size("1280x768"), Ok((1280, 768)));
        assert_eq!(validate_size("768x1280"), Ok((768, 1280)));
        assert_eq!(validate_size("1152x896"), Ok((1152, 896)));
        assert_eq!(validate_size("1280x1280"), Ok((1280, 1280)));
    }

    #[test]
    fn rejects_dimensions_out_of_the_512_1280_bounds() {
        // Below the minimum (512): 496 is a multiple of 16 but too small.
        assert_eq!(validate_size("496x512"), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_size("512x496"), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_size("0x0"), Err(chat::ErrorKind::Protocol));
        // Above the maximum (1280): 1296 is a multiple of 16 but too large.
        assert_eq!(validate_size("1296x512"), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_size("512x1296"), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_size("99999x512"), Err(chat::ErrorKind::Protocol));
    }

    #[test]
    fn rejects_dimensions_that_are_not_multiples_of_16() {
        assert_eq!(validate_size("1000x1024"), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_size("1024x520"), Err(chat::ErrorKind::Protocol));
        assert_eq!(validate_size("1023x1024"), Err(chat::ErrorKind::Protocol));
    }

    #[test]
    fn rejects_malformed_size_strings() {
        for bad in [
            "",
            "1024",
            "1024x",
            "x1024",
            "1024X1024", // uppercase separator
            "1024xx1024",
            " 1024x1024", // whitespace
            "1024x1024 ",
            "axb",
            "-512x512",
            "1024x+512",
            "16x16x16",
            "１０２４x1024", // fullwidth digits
        ] {
            assert_eq!(
                validate_size(bad),
                Err(chat::ErrorKind::Protocol),
                "{bad:?} must be rejected"
            );
        }
    }

    // ---- image_body -----------------------------------------------------------

    #[test]
    fn image_body_matches_the_openai_images_shape() {
        assert_eq!(
            image_body("a cat on a roof", "1024x1024"),
            serde_json::json!({
                "model": "qwen-image-2.1",
                "prompt": "a cat on a roof",
                "size": "1024x1024",
            })
        );
    }

    #[test]
    fn image_body_carries_the_prompt_verbatim_including_multibyte() {
        let body = image_body("Café ☕ — listó", "768x512");
        assert_eq!(body["prompt"], "Café ☕ — listó");
        assert_eq!(body["size"], "768x512");
        assert_eq!(body["model"], "qwen-image-2.1");
    }

    // ---- parse_images_response --------------------------------------------------

    /// A tiny valid PNG (1x1 pixel) — the same fixture the mock serves.
    const TINY_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn parses_b64_json_reply_into_exact_bytes() {
        // "aGVsbG8gcG5n" is base64 for b"hello png" — known raw bytes keep
        // the assertion independent of the decoder under test.
        let bytes =
            parse_images_response(r#"{"data":[{"b64_json":"aGVsbG8gcG5n"}]}"#).expect("parse");
        assert_eq!(bytes, b"hello png".to_vec());
    }

    #[test]
    fn parses_a_real_png_payload_with_the_png_magic() {
        // The exact 1x1 PNG fixture the mock serves (TINY_PNG_B64): the
        // decoded bytes must carry the 8-byte PNG signature.
        let bytes =
            parse_images_response(&format!(r#"{{"data":[{{"b64_json":"{TINY_PNG_B64}"}}]}}"#))
                .expect("parse");
        assert_eq!(
            &bytes[..8],
            &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        );
        assert!(!bytes.is_empty());
    }

    #[test]
    fn url_only_reply_is_rejected_as_protocol_s12() {
        let body = r#"{"created":1730000000,"data":[{"url":"https://cdn.example.com/img.png"}]}"#;
        assert_eq!(
            parse_images_response(body),
            Err(chat::ErrorKind::Protocol),
            "a url reply would point at an arbitrary host — S12 forbids it"
        );
    }

    #[test]
    fn b64_json_wins_when_both_fields_are_present() {
        let body = format!(
            r#"{{"data":[{{"url":"https://cdn.example.com/img.png","b64_json":"{TINY_PNG_B64}"}}]}}"#
        );
        let parsed = parse_images_response(&body);
        assert!(parsed.is_ok(), "b64_json must be used when present");
    }

    #[test]
    fn empty_data_missing_fields_and_malformed_json_are_protocol() {
        assert_eq!(
            parse_images_response(r#"{"data":[]}"#),
            Err(chat::ErrorKind::Protocol)
        );
        assert_eq!(
            parse_images_response(r#"{"created":1730000000}"#),
            Err(chat::ErrorKind::Protocol)
        );
        assert_eq!(
            parse_images_response(r#"{"data":[{"unrelated":1}]}"#),
            Err(chat::ErrorKind::Protocol)
        );
        assert_eq!(
            parse_images_response("<html>nope</html>"),
            Err(chat::ErrorKind::Protocol)
        );
        assert_eq!(parse_images_response(""), Err(chat::ErrorKind::Protocol));
    }

    #[test]
    fn undecodable_or_empty_b64_payload_is_a_decode_error() {
        assert_eq!(
            parse_images_response(r#"{"data":[{"b64_json":"not base64!!"}]}"#),
            Err(chat::ErrorKind::Decode)
        );
        assert_eq!(
            parse_images_response(r#"{"data":[{"b64_json":""}]}"#),
            Err(chat::ErrorKind::Decode),
            "zero bytes can never be a valid image"
        );
    }

    // ---- images_dir + save_png ---------------------------------------------------

    #[test]
    fn images_dir_is_the_images_subdirectory() {
        assert_eq!(
            images_dir(Path::new("/home/u/AppData")),
            PathBuf::from("/home/u/AppData/images")
        );
    }

    #[test]
    fn save_png_writes_exact_bytes_under_a_png_name() {
        let dir = TempDir::new().expect("temp dir");
        let bytes = b"fake png bytes \xF0\x9F\x98\x80";
        let path = save_png(&dir.path().join("nested"), bytes).expect("save");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        assert!(path.starts_with(dir.path()));
        assert_eq!(std::fs::read(&path).expect("read"), bytes.to_vec());
    }

    #[test]
    fn save_png_names_are_unique() {
        let dir = TempDir::new().expect("temp dir");
        let a = save_png(dir.path(), b"one").expect("save a");
        let b = save_png(dir.path(), b"two").expect("save b");
        assert_ne!(a, b, "uuid file names never collide");
    }

    // ---- registry (cancel-safe per-conversation single generation) ----------------

    /// A task that never completes on its own: only an abort ends it.
    fn spawn_pending_task() -> tauri::async_runtime::JoinHandle<()> {
        tauri::async_runtime::spawn(async { std::future::pending::<()>().await })
    }

    #[test]
    fn abort_image_aborts_the_attached_task_and_reports_presence() {
        let state = ImagesState::default();
        let generation = reserve_image(&state, 7).expect("reserve");
        let handle = spawn_pending_task();
        attach_image(&state, 7, generation, handle).expect("attach");

        assert!(
            abort_image(&state, 7).expect("abort"),
            "an active generation entry existed"
        );
        // The registry entry is gone: a second cancel is a no-op `false`,
        // and the slot is fresh again (generations only need to exceed the
        // entry currently in the map — at most one per conversation exists).
        assert!(!abort_image(&state, 7).expect("second abort"));
        assert_eq!(reserve_image(&state, 7).expect("reserve again"), 1);
    }

    #[test]
    fn generations_are_tracked_per_conversation() {
        let state = ImagesState::default();
        let g1 = reserve_image(&state, 1).expect("reserve 1");
        let g2 = reserve_image(&state, 2).expect("reserve 2");
        assert_eq!(g1, 1);
        assert_eq!(g2, 1, "different conversations start at generation 1");

        let g1b = reserve_image(&state, 1).expect("reserve 1 again");
        assert_eq!(
            g1b, 2,
            "same conversation reserves an incremented generation"
        );
        assert!(
            abort_image(&state, 1).expect("abort 1"),
            "the newest entry is the active one"
        );
        assert!(
            abort_image(&state, 2).expect("abort 2"),
            "conversation 2 is unaffected"
        );
    }

    // ---- constants -----------------------------------------------------------------

    #[test]
    fn image_model_is_the_locked_s5_model() {
        assert_eq!(IMAGE_MODEL, "qwen-image-2.1");
        assert_eq!(DEFAULT_SIZE, "1024x1024");
        assert_eq!(MIN_DIM, 512);
        assert_eq!(MAX_DIM, 1280);
        assert_eq!(DIM_STEP, 16);
        // The default and the documented presets all validate.
        for size in [
            "1024x1024",
            "512x512",
            "768x512",
            "512x768",
            "1280x768",
            "768x1280",
            "1152x896",
        ] {
            assert!(validate_size(size).is_ok(), "{size} must be valid");
        }
    }
}
