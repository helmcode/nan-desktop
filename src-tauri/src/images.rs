//! Inline image generation (T5, S5): `qwen-image-2.1` through
//! `POST {inference_base}/images/generations` (the base ends in `/v1`, so
//! the wire path is `/v1/images/generations`; see [`generations_url`]).
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
//! **Reply shapes.** `b64_json` is decoded inline. The LIVE community
//! tenant answers `{"data":[{"url": "https://…r2.cloudflarestorage.com/…"}]}`
//! (a presigned URL the tenant itself issues in its authenticated reply;
//! verified 2026-11-02). That URL is downloaded https-only (every redirect
//! hop too), with NO credentials attached — the bearer key only ever goes
//! to the tenant's own inference host — at most 3 redirects and a 20 MiB
//! streaming cap. A non-https URL fails closed with kind `protocol`.
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
//! Zero telemetry (S8): the only hosts contacted are the conversation
//! profile's own inference base — a compiled-in constant (S2) — and, for the
//! `url` reply shape, the presigned storage URL that base returned; in debug
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

/// Generation endpoint for an inference base. The compiled-in inference
/// bases ALREADY end in `/v1` (`https://api.nan.builders/v1`, same root as
/// `{base}/chat/completions`), so this yields `/v1/images/generations`;
/// adding another `/v1` here would hit `/v1/v1/...` and 404. Debug mocks
/// set `NAN_DESKTOP_MOCK_INFERENCE` to their `/v1` root as well.
///
/// A base given WITHOUT the `/v1` suffix (a bare host root) still yields the
/// `/v1/images/generations` path, so the wire path can never silently lose
/// its version prefix.
pub fn generations_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/images/generations")
    } else {
        format!("{base}/v1/images/generations")
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

/// What the tenant's images endpoint returned for one generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageReply {
    /// Inline bytes (`b64_json`).
    Bytes(Vec<u8>),
    /// A tenant-issued presigned https URL to download (community shape).
    Url(String),
}

/// Parse the OpenAI images response body.
///
/// - `{"data":[{"b64_json": "…"}]}` → [`ImageReply::Bytes`]. An undecodable
///   payload or a zero-byte result is [`chat::ErrorKind::Decode`].
/// - `{"data":[{"url": "https://…"}]}` → [`ImageReply::Url`]: the LIVE
///   community shape (verified 2026-11-02: a presigned R2 URL issued by the
///   tenant itself). The caller downloads it WITHOUT credentials (it is
///   presigned), https-only, with a size cap — see [`download_image_url`].
///   The URL comes from the locked tenant's authenticated response, so this
///   is tenant-issued content, not an arbitrary remote host. A non-https
///   URL is [`chat::ErrorKind::Protocol`] (never fetched).
/// - Anything else (malformed JSON, empty `data`, neither field) →
///   [`chat::ErrorKind::Protocol`].
#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_images_response(body: &str) -> Result<ImageReply, chat::ErrorKind> {
    parse_reply(body, false)
}

/// Whether a reply/download URL may be fetched: https always; plain http
/// ONLY to the loopback mock host, and only when `allow_loopback_http`
/// (debug builds whose inference base is the local mock — never release).
fn url_allowed(url: &str, allow_loopback_http: bool) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    allow_loopback_http
        && (url.starts_with("http://127.0.0.1:") || url.starts_with("http://127.0.0.1/"))
}

/// [`parse_images_response`] with the loopback-mock allowance.
fn parse_reply(body: &str, allow_loopback_http: bool) -> Result<ImageReply, chat::ErrorKind> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| chat::ErrorKind::Protocol)?;
    let item = value
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|data| data.first())
        .ok_or(chat::ErrorKind::Protocol)?;
    // Only the first item is consumed (n=1 in this app). `b64_json` wins
    // when both fields are present; a `url` must be https.
    if let Some(b64) = item.get("b64_json").and_then(|b| b.as_str()) {
        let bytes = BASE64_STANDARD
            .decode(b64)
            .map_err(|_| chat::ErrorKind::Decode)?;
        if bytes.is_empty() {
            return Err(chat::ErrorKind::Decode);
        }
        return Ok(ImageReply::Bytes(bytes));
    }
    if let Some(url) = item.get("url").and_then(|u| u.as_str()) {
        if url_allowed(url, allow_loopback_http) {
            return Ok(ImageReply::Url(url.to_string()));
        }
        return Err(chat::ErrorKind::Protocol);
    }
    Err(chat::ErrorKind::Protocol)
}

/// The largest image the tenant-side presigned URL may yield (PNG at the
/// model's sizes stays far below this; the cap bounds a hostile reply).
pub const IMAGE_DOWNLOAD_CAP: u64 = 20 << 20;

/// Maximum redirect hops followed while downloading a presigned image URL.
pub const IMAGE_DOWNLOAD_MAX_REDIRECTS: usize = 3;

/// Overall timeout of one image download (the bytes already exist on the
/// tenant's storage; only the ~1-minute GENERATION is unbounded).
pub const IMAGE_DOWNLOAD_TIMEOUT_SECS: u64 = 60;

/// Download a tenant-issued presigned image URL: https-only (including every
/// redirect hop), NO credentials attached (the URL is presigned; the key
/// must never reach another host), at most [`IMAGE_DOWNLOAD_MAX_REDIRECTS`]
/// hops, size-capped while streaming, bounded timeout. Returns the bytes.
#[cfg_attr(not(test), allow(dead_code))]
pub async fn download_image_url(url: &str) -> Result<Vec<u8>, chat::ErrorKind> {
    download_with(url, false).await
}

/// [`download_image_url`] with the loopback-mock allowance (see
/// [`url_allowed`]): the debug mock serves its "presigned" URL over plain
/// http on 127.0.0.1. Production always passes `false`.
async fn download_with(url: &str, allow_loopback_http: bool) -> Result<Vec<u8>, chat::ErrorKind> {
    if !url_allowed(url, allow_loopback_http) {
        return Err(chat::ErrorKind::Protocol);
    }
    let client = reqwest::Client::builder()
        .https_only(!allow_loopback_http)
        .connect_timeout(std::time::Duration::from_secs(chat::CONNECT_TIMEOUT_SECS))
        .timeout(std::time::Duration::from_secs(IMAGE_DOWNLOAD_TIMEOUT_SECS))
        .redirect(download_redirect_policy(allow_loopback_http))
        .build()
        .map_err(|_| chat::ErrorKind::Protocol)?;
    fetch_image(&client, url, IMAGE_DOWNLOAD_CAP).await
}

/// Redirect policy for presigned downloads: ≤ 3 hops, every hop allowed by
/// [`url_allowed`] (https in production).
fn download_redirect_policy(allow_loopback_http: bool) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() > IMAGE_DOWNLOAD_MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if !url_allowed(attempt.url().as_str(), allow_loopback_http) {
            attempt.error("redirect to a disallowed scheme/host")
        } else {
            attempt.follow()
        }
    })
}

/// Debug builds whose inference base is the local mock
/// (`NAN_DESKTOP_MOCK_INFERENCE`) may fetch the mock's loopback http image
/// URL. Always `false` in release builds (S12).
fn mock_inference_active() -> bool {
    cfg!(debug_assertions)
        && std::env::var("NAN_DESKTOP_MOCK_INFERENCE").is_ok_and(|mock| !mock.trim().is_empty())
}

/// GET `url` with `client` (which carries NO default headers — never a
/// bearer key) and stream the body, failing with
/// [`chat::ErrorKind::Decode`] the moment it exceeds `cap` bytes (a hostile
/// endless body is never buffered whole). Non-2xx → Protocol; an empty body
/// → Decode. The transport split from [`download_image_url`] exists so the
/// cap, status and no-credentials invariants are tested over loopback.
async fn fetch_image(
    client: &reqwest::Client,
    url: &str,
    cap: u64,
) -> Result<Vec<u8>, chat::ErrorKind> {
    use futures_util::StreamExt as _;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|err| chat::classify_transport(err.is_timeout()))?;
    if !response.status().is_success() {
        return Err(chat::ErrorKind::Protocol);
    }
    if response.content_length().is_some_and(|len| len > cap) {
        return Err(chat::ErrorKind::Decode);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| chat::classify_transport(err.is_timeout()))?;
        if bytes.len() as u64 + chunk.len() as u64 > cap {
            return Err(chat::ErrorKind::Decode);
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(chat::ErrorKind::Decode);
    }
    Ok(bytes)
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

    let bytes = match request_image(&profile_id, &prompt, &size).await {
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

/// Generate one image for `profile_id` and return the decoded PNG bytes:
/// keychain key + compiled-in inference base (Rust core only, S4), then
/// `POST {base}/images/generations`. Shared by the composer's image mode
/// and the chat's `generate_image` tool. A 429 is the tenant's monthly
/// image quota (shared 100/month pool) — classified `rate_limited`.
pub async fn request_image(
    profile_id: &str,
    prompt: &str,
    size: &str,
) -> Result<Vec<u8>, chat::ErrorKind> {
    let key = chat::read_profile_key(profile_id)?;
    request_image_with_key(profile_id, &key, prompt, size).await
}

/// [`request_image`] after the keychain read: resolve the profile's
/// inference base, POST the generation, then decode (`b64_json`) or
/// download (presigned `url`). Split out so the live smoke test exercises
/// the exact production path with a key supplied from the environment.
pub async fn request_image_with_key(
    profile_id: &str,
    key: &str,
    prompt: &str,
    size: &str,
) -> Result<Vec<u8>, chat::ErrorKind> {
    let base = chat::inference_base(profile_id).ok_or(chat::ErrorKind::Protocol)?;
    generate_at(&base, key, prompt, size, mock_inference_active()).await
}

/// The wire flow against one inference base: POST the generation with the
/// bearer key (to `base` ONLY), then decode the `b64_json` or download the
/// presigned `url` WITHOUT credentials.
async fn generate_at(
    base: &str,
    key: &str,
    prompt: &str,
    size: &str,
    allow_loopback_http: bool,
) -> Result<Vec<u8>, chat::ErrorKind> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(chat::CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|_| chat::ErrorKind::Protocol)?;
    // No overall request timeout: a ~1-minute generation must not be killed
    // mid-flight (same policy as the chat streams).
    let response = client
        .post(generations_url(base))
        .bearer_auth(key)
        .json(&image_body(prompt, size))
        .send()
        .await
        .map_err(|err| chat::classify_transport(err.is_timeout()))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(chat::classify_chat_status(status));
    }
    let body = response
        .text()
        .await
        .map_err(|err| chat::classify_transport(err.is_timeout()))?;
    match parse_reply(&body, allow_loopback_http)? {
        ImageReply::Bytes(bytes) => Ok(bytes),
        ImageReply::Url(url) => download_with(&url, allow_loopback_http).await,
    }
}

// ---------------------------------------------------------------------------
// `generate_image` chat tool (round 3): the model can create images itself
// ---------------------------------------------------------------------------

/// Tool name offered to the model.
pub const TOOL_NAME: &str = "generate_image";

/// OpenAI function definition for the `generate_image` tool.
pub fn tool_definition() -> serde_json::Value {
    serde_json::json!({ "type": "function", "function": {
        "name": TOOL_NAME,
        "description": "Create an image from a text description with the platform's image model (about one minute). The image is shown to the user in the chat automatically; reply with a short caption, do not describe a link or path.",
        "parameters": { "type": "object", "properties": {
            "prompt": { "type": "string", "description": "Detailed description of the image to create." },
            "size": { "type": "string", "description": "WIDTHxHEIGHT, each 512-1280 in steps of 16. Default 1024x1024." }
        }, "required": ["prompt"] }
    }})
}

/// Parsed `generate_image` arguments: `(prompt, size)`. An empty prompt is
/// an invalid call; a missing or invalid size falls back to the default.
pub fn parse_tool_args(arguments: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let prompt = value.get("prompt")?.as_str()?.trim().to_string();
    if prompt.is_empty() {
        return None;
    }
    let size = value
        .get("size")
        .and_then(|size| size.as_str())
        .map(str::trim)
        .filter(|size| validate_size(size).is_ok())
        .unwrap_or(DEFAULT_SIZE)
        .to_string();
    Some((prompt, size))
}

/// Tool-message content for a finished generation.
pub fn tool_result_for_model(result: &Result<PathBuf, chat::ErrorKind>) -> String {
    match result {
        Ok(path) => serde_json::json!({
            "ok": true,
            "summary": "image created and already shown to the user in the chat",
            "path": path.display().to_string(),
        })
        .to_string(),
        Err(chat::ErrorKind::RateLimited) => serde_json::json!({
            "ok": false,
            "error": "quota_exhausted",
            "message": "The monthly image quota is used up. Tell the user; do not retry.",
        })
        .to_string(),
        Err(kind) => serde_json::json!({
            "ok": false,
            "error": "image_failed",
            "message": format!("Image generation failed ({kind:?}). Tell the user; do not retry more than once."),
        })
        .to_string(),
    }
}

/// Run the `generate_image` tool: generate, then save under
/// `app_data/images` (the asset-protocol scope the chat renders from).
pub async fn run_tool(
    app_data: &Path,
    profile_id: &str,
    prompt: &str,
    size: &str,
) -> Result<PathBuf, chat::ErrorKind> {
    let bytes = request_image(profile_id, prompt, size).await?;
    save_png(&images_dir(app_data), &bytes)
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

    /// Unwrap a `Bytes` reply (panics with the actual variant otherwise).
    fn expect_bytes(reply: Result<ImageReply, chat::ErrorKind>) -> Vec<u8> {
        match reply {
            Ok(ImageReply::Bytes(bytes)) => bytes,
            other => panic!("expected ImageReply::Bytes, got {other:?}"),
        }
    }

    #[test]
    fn parses_b64_json_reply_into_exact_bytes() {
        // "aGVsbG8gcG5n" is base64 for b"hello png" — known raw bytes keep
        // the assertion independent of the decoder under test.
        assert_eq!(
            parse_images_response(r#"{"data":[{"b64_json":"aGVsbG8gcG5n"}]}"#),
            Ok(ImageReply::Bytes(b"hello png".to_vec()))
        );
    }

    #[test]
    fn parses_a_real_png_payload_with_the_png_magic() {
        // The exact 1x1 PNG fixture the mock serves (TINY_PNG_B64): the
        // decoded bytes must carry the 8-byte PNG signature.
        let bytes = expect_bytes(parse_images_response(&format!(
            r#"{{"data":[{{"b64_json":"{TINY_PNG_B64}"}}]}}"#
        )));
        assert_eq!(
            &bytes[..8],
            &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        );
    }

    #[test]
    fn https_url_reply_is_the_live_community_shape() {
        // Exactly the live shape (2026-11-02): keys ['url'] only, a presigned
        // R2 URL with a query string that must survive verbatim.
        let url = "https://abc123.r2.cloudflarestorage.com/images/x.png?X-Amz-Signature=deadbeef&X-Amz-Expires=3600";
        let body = format!(r#"{{"created":1730000000,"data":[{{"url":"{url}"}}]}}"#);
        assert_eq!(
            parse_images_response(&body),
            Ok(ImageReply::Url(url.to_string()))
        );
    }

    #[test]
    fn non_https_url_replies_are_protocol_and_never_fetched() {
        for url in [
            "http://abc.r2.cloudflarestorage.com/x.png",
            "file:///etc/passwd",
            "ftp://example.com/x.png",
            "//example.com/x.png",
            "HTTPS-ish://x",
            "",
        ] {
            let body = serde_json::json!({ "data": [{ "url": url }] }).to_string();
            assert_eq!(
                parse_images_response(&body),
                Err(chat::ErrorKind::Protocol),
                "{url:?} must be rejected"
            );
        }
    }

    #[test]
    fn b64_json_wins_when_both_fields_are_present() {
        let body =
            r#"{"data":[{"url":"https://cdn.example.com/img.png","b64_json":"aGVsbG8gcG5n"}]}"#;
        assert_eq!(
            parse_images_response(body),
            Ok(ImageReply::Bytes(b"hello png".to_vec()))
        );
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
    fn generation_url_is_exactly_v1_images_generations_on_both_tenants() {
        for (id, expected) in [
            ("nan", "https://api.nan.builders/v1/images/generations"),
            ("helmcode", "https://api.helmcode.com/v1/images/generations"),
        ] {
            let base = crate::profile::inference_base_for(id).expect("tenant");
            let url = generations_url(base);
            assert_eq!(url, expected);
            assert!(!url.contains("/v1/v1/"), "no doubled /v1 prefix");
        }
        // A mock root with a trailing slash still yields one separator.
        assert_eq!(
            generations_url("http://127.0.0.1:1/v1/"),
            "http://127.0.0.1:1/v1/images/generations"
        );
        // A bare host root (no /v1) can never lose the version prefix: this
        // exact path regression (`{base}/images/generations` on a non-/v1
        // root, or `/v1/v1/`) is what 404'd image generation for 4 rounds.
        assert_eq!(
            generations_url("https://api.nan.builders"),
            "https://api.nan.builders/v1/images/generations"
        );
        assert_eq!(
            generations_url("https://api.nan.builders/"),
            "https://api.nan.builders/v1/images/generations"
        );
        for base in [
            "https://api.nan.builders/v1",
            "https://api.nan.builders",
            "http://127.0.0.1:9/v1",
        ] {
            let url = generations_url(base);
            assert!(url.ends_with("/v1/images/generations"), "{url}");
            assert_eq!(url.matches("/v1/").count(), 1, "{url}");
        }
    }

    #[test]
    fn the_production_request_path_uses_the_compiled_in_base_unchanged() {
        // `request_image_with_key` resolves the base through
        // `chat::inference_base`; without the debug mock variable it is the
        // compiled-in constant, so the wire URL is pinned end to end.
        if std::env::var("NAN_DESKTOP_MOCK_INFERENCE").is_err() {
            let base = chat::inference_base("nan").expect("nan base");
            assert_eq!(
                generations_url(&base),
                "https://api.nan.builders/v1/images/generations"
            );
        }
    }

    // ---- loopback HTTP harness (download + E2E wire tests) ------------------------

    use std::io::{Read as _, Write as _};
    use std::sync::{Arc, Mutex as StdMutex};

    /// One recorded request: lowercase header block + body.
    #[derive(Debug, Clone)]
    struct Recorded {
        head: String,
        body: Vec<u8>,
    }

    impl Recorded {
        fn has_header(&self, name: &str) -> bool {
            self.head
                .lines()
                .any(|line| line.starts_with(&format!("{name}:")))
        }
    }

    /// A dependency-free HTTP/1.1 server on 127.0.0.1 (one request per
    /// connection, `Connection: close`). `respond(path, request)` returns
    /// the raw response bytes. Every request is recorded. The request head
    /// is lowercased (header-name checks are case-insensitive).
    struct Loopback {
        origin: String,
        requests: Arc<StdMutex<Vec<(String, Recorded)>>>,
    }

    impl Loopback {
        fn start<F>(respond: F) -> Self
        where
            F: Fn(&str, &Recorded) -> Vec<u8> + Send + 'static,
        {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
            let origin = format!("http://{}", listener.local_addr().expect("addr"));
            let requests = Arc::new(StdMutex::new(Vec::new()));
            let log = Arc::clone(&requests);
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 8192];
                    let head_end = loop {
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => break None,
                            Ok(n) => raw.extend_from_slice(&buf[..n]),
                        }
                        if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            break Some(pos + 4);
                        }
                    };
                    let Some(head_end) = head_end else { continue };
                    let head = String::from_utf8_lossy(&raw[..head_end]).to_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    while raw.len() < head_end + length {
                        match stream.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => raw.extend_from_slice(&buf[..n]),
                        }
                    }
                    let request_line = head.lines().next().unwrap_or_default().to_string();
                    let path = request_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let recorded = Recorded {
                        head,
                        body: raw[head_end..].to_vec(),
                    };
                    let response = respond(path.as_str(), &recorded);
                    log.lock().expect("log").push((path, recorded));
                    let _ = stream.write_all(&response);
                    let _ = stream.flush();
                }
            });
            Loopback { origin, requests }
        }

        fn requests(&self) -> Vec<(String, Recorded)> {
            self.requests.lock().expect("log").clone()
        }
    }

    fn http_response(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status}\r\nconnection: close\r\n");
        for (name, value) in headers {
            out.push_str(&format!("{name}: {value}\r\n"));
        }
        out.push_str("\r\n");
        let mut bytes = out.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    fn ok_bytes(body: &[u8]) -> Vec<u8> {
        http_response(
            "200 OK",
            &[
                ("content-type", "image/png".into()),
                ("content-length", body.len().to_string()),
            ],
            body,
        )
    }

    fn tiny_png() -> Vec<u8> {
        BASE64_STANDARD.decode(TINY_PNG_B64).expect("fixture")
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    // ---- download_image_url / download_with ----------------------------------------

    #[test]
    fn download_returns_the_exact_bytes_on_200() {
        let png = tiny_png();
        let served = png.clone();
        let server = Loopback::start(move |_, _| ok_bytes(&served));
        let url = format!("{}/bucket/img.png?X-Amz-Signature=abc", server.origin);
        assert_eq!(block_on(download_with(&url, true)), Ok(png));
        // The presigned query string reached the storage host verbatim.
        assert_eq!(
            server.requests()[0].0,
            "/bucket/img.png?x-amz-signature=abc"
        );
    }

    #[test]
    fn download_non_200_is_protocol() {
        for status in [
            "403 Forbidden",
            "404 Not Found",
            "500 Internal Server Error",
        ] {
            let server = Loopback::start(move |_, _| http_response(status, &[], b"nope"));
            let url = format!("{}/img.png", server.origin);
            assert_eq!(
                block_on(download_with(&url, true)),
                Err(chat::ErrorKind::Protocol),
                "{status}"
            );
        }
    }

    #[test]
    fn download_over_20_mib_is_decode_with_or_without_content_length() {
        // Declared too large: refused before reading the body.
        let server = Loopback::start(|_, _| {
            http_response(
                "200 OK",
                &[("content-length", (IMAGE_DOWNLOAD_CAP + 1).to_string())],
                b"",
            )
        });
        assert_eq!(
            block_on(download_with(&format!("{}/a.png", server.origin), true)),
            Err(chat::ErrorKind::Decode)
        );
        // No length declared: the streaming cap trips at cap + 1 bytes.
        let body = vec![0u8; IMAGE_DOWNLOAD_CAP as usize + 1];
        let server = Loopback::start(move |_, _| http_response("200 OK", &[], &body));
        assert_eq!(
            block_on(download_with(&format!("{}/b.png", server.origin), true)),
            Err(chat::ErrorKind::Decode)
        );
        // Exactly at the cap is accepted (the bound is inclusive).
        let body = vec![7u8; 4096];
        let server = Loopback::start(move |_, _| http_response("200 OK", &[], &body));
        let client = reqwest::Client::new();
        assert_eq!(
            block_on(fetch_image(
                &client,
                &format!("{}/c.png", server.origin),
                4096
            ))
            .map(|b| b.len()),
            Ok(4096)
        );
        assert_eq!(
            block_on(fetch_image(
                &client,
                &format!("{}/c.png", server.origin),
                4095
            )),
            Err(chat::ErrorKind::Decode)
        );
    }

    #[test]
    fn download_empty_body_is_decode() {
        let server = Loopback::start(|_, _| ok_bytes(b""));
        assert_eq!(
            block_on(download_with(&format!("{}/e.png", server.origin), true)),
            Err(chat::ErrorKind::Decode)
        );
    }

    #[test]
    fn production_download_refuses_plain_http_without_any_connection() {
        let server = Loopback::start(|_, _| ok_bytes(b"x"));
        let url = format!("{}/img.png", server.origin);
        assert_eq!(
            block_on(download_image_url(&url)),
            Err(chat::ErrorKind::Protocol)
        );
        for url in [
            "file:///etc/passwd",
            "ftp://x/y.png",
            "http://example.com/a.png",
        ] {
            assert_eq!(
                block_on(download_image_url(url)),
                Err(chat::ErrorKind::Protocol),
                "{url}"
            );
        }
        // The loopback allowance is ONLY for 127.0.0.1 even in mock mode.
        assert_eq!(
            block_on(download_with("http://example.com/a.png", true)),
            Err(chat::ErrorKind::Protocol)
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(server.requests().is_empty(), "nothing was ever requested");
    }

    #[test]
    fn download_follows_at_most_three_redirects() {
        // /r/N redirects to /r/N-1 … /r/0 serves the image.
        let png = tiny_png();
        let server = Loopback::start(move |path, _| {
            let n: u32 = path
                .strip_prefix("/r/")
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            if n == 0 {
                ok_bytes(&png)
            } else {
                http_response(
                    "302 Found",
                    &[
                        ("location", format!("/r/{}", n - 1)),
                        ("content-length", "0".into()),
                    ],
                    b"",
                )
            }
        });
        assert!(block_on(download_with(&format!("{}/r/3", server.origin), true)).is_ok());
        assert!(block_on(download_with(&format!("{}/r/4", server.origin), true)).is_err());
    }

    // ---- end-to-end wire flow (mock tenant → presigned url → download) -------------

    const E2E_KEY: &str = "sk-e2e-key-0123456789";

    /// The mock tenant: answers the generation with the LIVE url shape,
    /// pointing at a SEPARATE storage host (another loopback port).
    fn start_tenant(storage_origin: String) -> Loopback {
        Loopback::start(move |path, request| {
            if path != "/v1/images/generations" {
                return http_response("404 Not Found", &[], b"{}");
            }
            if !request
                .head
                .contains(&format!("authorization: bearer {}", E2E_KEY.to_lowercase()))
            {
                return http_response("401 Unauthorized", &[], b"{}");
            }
            let body = serde_json::json!({ "created": 1, "data": [{
                "url": format!("{storage_origin}/bucket/gen.png?X-Amz-Signature=s1g")
            }] })
            .to_string();
            http_response(
                "200 OK",
                &[
                    ("content-type", "application/json".into()),
                    ("content-length", body.len().to_string()),
                ],
                body.as_bytes(),
            )
        })
    }

    #[test]
    fn e2e_url_reply_is_downloaded_and_no_authorization_reaches_the_storage_host() {
        let png = tiny_png();
        let served = png.clone();
        let storage = Loopback::start(move |_, _| ok_bytes(&served));
        let tenant = start_tenant(storage.origin.clone());

        let bytes = block_on(generate_at(
            &format!("{}/v1", tenant.origin),
            E2E_KEY,
            "un gato astronauta",
            "1024x1024",
            true,
        ))
        .expect("generation through the url shape");
        assert_eq!(bytes, png, "the downloaded bytes are the stored image");

        // Tenant: exactly one POST to /v1/images/generations WITH the key.
        let tenant_requests = tenant.requests();
        assert_eq!(tenant_requests.len(), 1);
        assert_eq!(tenant_requests[0].0, "/v1/images/generations");
        assert!(tenant_requests[0].1.head.starts_with("post "));
        let body: serde_json::Value =
            serde_json::from_slice(&tenant_requests[0].1.body).expect("json body");
        assert_eq!(body, image_body("un gato astronauta", "1024x1024"));

        // Storage: one GET, and the key NEVER reached it in any form.
        let storage_requests = storage.requests();
        assert_eq!(storage_requests.len(), 1);
        let (path, request) = &storage_requests[0];
        assert!(request.head.starts_with("get "));
        assert_eq!(path, "/bucket/gen.png?x-amz-signature=s1g");
        assert!(!request.has_header("authorization"));
        assert!(!request.has_header("proxy-authorization"));
        assert!(!request.has_header("cookie"));
        assert!(
            !request.head.contains(&E2E_KEY.to_lowercase()),
            "the bearer key leaked to the storage host"
        );
    }

    #[test]
    fn e2e_generate_image_tool_call_lands_as_an_inline_image_artifact() {
        // The model's tool call → the wire flow (url shape) → saved under
        // app_data/images exactly like `run_tool` → persisted as an `image`
        // artifact on the reply → the row JSON the renderer reads.
        let png = tiny_png();
        let served = png.clone();
        let storage = Loopback::start(move |_, _| ok_bytes(&served));
        let tenant = start_tenant(storage.origin.clone());
        let app_data = TempDir::new().expect("app data");

        let (prompt, size) =
            parse_tool_args(r#"{"prompt":"un zorro en la nieve","size":"768x512"}"#)
                .expect("valid tool call");
        let bytes = block_on(generate_at(
            &format!("{}/v1", tenant.origin),
            E2E_KEY,
            &prompt,
            &size,
            true,
        ))
        .expect("generation");
        let saved = save_png(&images_dir(app_data.path()), &bytes);
        let model_reply: serde_json::Value =
            serde_json::from_str(&tool_result_for_model(&saved)).expect("tool json");
        assert_eq!(model_reply["ok"], true);
        let path = saved.expect("saved");
        assert!(path.starts_with(images_dir(app_data.path())));
        assert_eq!(std::fs::read(&path).expect("read"), png);

        let conn = chat_store::open_db(app_data.path()).expect("db");
        let conv = chat_store::insert_conversation(&conn, "nan", "t").expect("conv");
        let reply = chat_store::insert_message(&conn, conv, "assistant", "Aquí está.", Some("m"))
            .expect("reply");
        chat_store::set_message_artifacts(
            &conn,
            reply,
            &[chat_store::Artifact {
                path: path.display().to_string(),
                kind: chat_store::ArtifactKind::Image,
            }],
        )
        .expect("artifacts");
        let rows = chat_store::list_messages(&conn, conv).expect("list");
        let wire = serde_json::to_value(&rows[0]).expect("row json");
        assert_eq!(
            wire["artifacts"],
            serde_json::json!([{ "path": path.display().to_string(), "kind": "image" }])
        );
    }

    #[test]
    fn e2e_no_authorization_reaches_the_storage_host_across_redirects() {
        let png = tiny_png();
        let final_host = Loopback::start(move |_, _| ok_bytes(&png));
        let final_origin = final_host.origin.clone();
        let hop = Loopback::start(move |_, _| {
            http_response(
                "307 Temporary Redirect",
                &[
                    ("location", format!("{final_origin}/final.png")),
                    ("content-length", "0".into()),
                ],
                b"",
            )
        });
        let tenant = start_tenant(hop.origin.clone());
        block_on(generate_at(
            &format!("{}/v1", tenant.origin),
            E2E_KEY,
            "p",
            "512x512",
            true,
        ))
        .expect("generation across a redirect");
        for (host, server) in [("hop", &hop), ("final", &final_host)] {
            let requests = server.requests();
            assert_eq!(requests.len(), 1, "{host}");
            assert!(!requests[0].1.has_header("authorization"), "{host}");
        }
    }

    #[test]
    fn e2e_b64_reply_still_works_and_errors_classify() {
        // b64_json shape (the enterprise tenant) end to end.
        let tenant = Loopback::start(|_, _| {
            let body = format!(r#"{{"data":[{{"b64_json":"{TINY_PNG_B64}"}}]}}"#);
            http_response("200 OK", &[], body.as_bytes())
        });
        assert_eq!(
            block_on(generate_at(
                &format!("{}/v1", tenant.origin),
                E2E_KEY,
                "p",
                "512x512",
                false
            )),
            Ok(tiny_png())
        );
        // 429 is the monthly quota; 404 (a wrong path) is NOT silently ok.
        for (status, kind) in [
            ("429 Too Many Requests", chat::ErrorKind::RateLimited),
            ("401 Unauthorized", chat::classify_chat_status(401)),
            ("404 Not Found", chat::classify_chat_status(404)),
        ] {
            let tenant = Loopback::start(move |_, _| http_response(status, &[], b"{}"));
            assert_eq!(
                block_on(generate_at(
                    &format!("{}/v1", tenant.origin),
                    E2E_KEY,
                    "p",
                    "512x512",
                    false
                )),
                Err(kind),
                "{status}"
            );
        }
    }

    #[test]
    fn e2e_production_mode_refuses_a_plain_http_url_reply() {
        // Without the mock allowance a non-https url is never fetched.
        let storage = Loopback::start(|_, _| ok_bytes(b"x"));
        let tenant = start_tenant(storage.origin.clone());
        assert_eq!(
            block_on(generate_at(
                &format!("{}/v1", tenant.origin),
                E2E_KEY,
                "p",
                "512x512",
                false
            )),
            Err(chat::ErrorKind::Protocol)
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(storage.requests().is_empty());
    }

    // ---- LIVE smoke (manual: real community tenant, real key) ----------------------

    /// Real generation through the app's own path against
    /// `https://api.nan.builders/v1`. Ignored by default (needs the network
    /// and a member key). Run:
    ///
    /// ```sh
    /// NAN_SMOKE_MODELS_JSON=/path/to/models.json \   # or NAN_SMOKE_KEY=…
    ///   cargo test live_smoke -- --ignored --nocapture
    /// ```
    ///
    /// The key is read from `NAN_SMOKE_KEY`, else from
    /// `providers.nan.apiKey` in the JSON file at `NAN_SMOKE_MODELS_JSON`.
    /// It is never printed. The image is written to `NAN_SMOKE_OUT`
    /// (default `/tmp/nan-desktop-live-smoke.png`).
    #[test]
    #[ignore = "live network smoke: needs a member key (see doc comment)"]
    fn live_smoke_community_generation() {
        assert!(
            std::env::var("NAN_DESKTOP_MOCK_INFERENCE").is_err(),
            "unset NAN_DESKTOP_MOCK_INFERENCE: the smoke must hit the real tenant"
        );
        let key = std::env::var("NAN_SMOKE_KEY").ok().or_else(|| {
            let path = std::env::var("NAN_SMOKE_MODELS_JSON").ok()?;
            let raw = std::fs::read_to_string(path).ok()?;
            let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
            json["providers"]["nan"]["apiKey"]
                .as_str()
                .map(str::to_string)
        });
        let key = key.expect("set NAN_SMOKE_KEY or NAN_SMOKE_MODELS_JSON");
        assert!(!key.is_empty());
        let out = std::env::var("NAN_SMOKE_OUT")
            .unwrap_or_else(|_| "/tmp/nan-desktop-live-smoke.png".to_string());

        let base = chat::inference_base("nan").expect("nan base");
        println!("live smoke: POST {}", generations_url(&base));
        let started = std::time::Instant::now();
        let result = block_on(request_image_with_key(
            "nan",
            &key,
            "A small red fox sitting in fresh snow, soft morning light, photographic",
            DEFAULT_SIZE,
        ));
        let elapsed = started.elapsed();
        let bytes = match result {
            Ok(bytes) => bytes,
            Err(kind) => panic!("live generation failed after {elapsed:?}: {kind:?}"),
        };
        std::fs::write(&out, &bytes).expect("write smoke image");
        let png = bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        let jpeg = bytes.starts_with(&[0xFF, 0xD8, 0xFF]);
        let webp = bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
        println!(
            "live smoke: OK bytes={} elapsed_ms={} format={} out={out}",
            bytes.len(),
            elapsed.as_millis(),
            if png {
                "png"
            } else if jpeg {
                "jpeg"
            } else if webp {
                "webp"
            } else {
                "unknown"
            }
        );
        assert!(png || jpeg || webp, "the downloaded bytes are not an image");
    }

    #[test]
    fn generate_image_tool_definition_requires_only_the_prompt() {
        let def = tool_definition();
        assert_eq!(def["function"]["name"], TOOL_NAME);
        assert_eq!(
            def["function"]["parameters"]["required"],
            serde_json::json!(["prompt"])
        );
    }

    #[test]
    fn generate_image_args_default_the_size_and_reject_an_empty_prompt() {
        assert_eq!(
            parse_tool_args(r#"{"prompt":" un gato astronauta "}"#),
            Some(("un gato astronauta".into(), DEFAULT_SIZE.into()))
        );
        assert_eq!(
            parse_tool_args(r#"{"prompt":"x","size":"768x1280"}"#),
            Some(("x".into(), "768x1280".into()))
        );
        // An invalid size never fails the call: the default is used.
        assert_eq!(
            parse_tool_args(r#"{"prompt":"x","size":"4096x4096"}"#),
            Some(("x".into(), DEFAULT_SIZE.into()))
        );
        assert_eq!(parse_tool_args(r#"{"prompt":"  "}"#), None);
        assert_eq!(parse_tool_args(r#"{"size":"1024x1024"}"#), None);
        assert_eq!(parse_tool_args("not json"), None);
    }

    #[test]
    fn generate_image_results_tell_the_model_it_is_shown_and_quota_is_final() {
        let ok: serde_json::Value = serde_json::from_str(&tool_result_for_model(&Ok(
            PathBuf::from("/data/images/a.png"),
        )))
        .expect("json");
        assert_eq!(ok["ok"], true);
        assert_eq!(ok["path"], "/data/images/a.png");
        let quota: serde_json::Value =
            serde_json::from_str(&tool_result_for_model(&Err(chat::ErrorKind::RateLimited)))
                .expect("json");
        assert_eq!(quota["error"], "quota_exhausted");
        let failed: serde_json::Value =
            serde_json::from_str(&tool_result_for_model(&Err(chat::ErrorKind::Server)))
                .expect("json");
        assert_eq!(failed["ok"], false);
    }

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
