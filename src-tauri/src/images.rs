//! Inline image generation (T5, S5; FLUX since T10c): `flux-3-image-klein`
//! through the DESKTOP-ONLY route
//! `POST {platform_base}/v1/desktop/images/generations` (see
//! [`generations_url`]), served by both tenants' platform APIs to desktop
//! sessions. The server forces the model and `n=1`; the tenant's
//! entitlement and monthly image quota still apply server-side.
//!
//! Architecture mirrors `chat.rs` (S4): the credential is the profile's
//! desktop SESSION JWT from the vault (account `<profile>.session`, the one
//! image editing, web search and memory sync use; the profile is derived
//! from the conversation row, the renderer never sends secrets or URLs). The
//! request is sent from the Rust core as `multipart/form-data` with the
//! public route's fields (`prompt`, `size`, `n=1`; never `model`, see
//! [`generation_parts`]), and the reply is decoded and saved under
//! `app_data_dir/images/<uuid>.<png|jpg>`: the extension follows the image's
//! magic bytes (FLUX answers JPEG, see [`save_image`]). The web renderer
//! never sees the token, any URL, or the image bytes, only status events and
//! the saved file's path:
//!
//! - `images://started` `{conversation_id}` — the task began
//! - `images://done`    `{conversation_id, media_path}` — image saved AND
//!   persisted as an assistant message row (`media_path` column)
//! - `images://error`   `{conversation_id, kind}` — classified failure
//! - `images://stopped` `{conversation_id}` — the user cancelled (or a new
//!   generation superseded the running one in the same conversation)
//!
//! Error kinds are [`ImageErrorKind`] (the edit surface's kinds): 400
//! `invalid_request`, 401 `unauthorized`, 403 `tier_restricted` (the plan
//! does not include images), 404 `not_available` (the route is not mounted
//! for this account), 429 `rate_limited` (the tenant's monthly image quota,
//! so the UI renders a quota message), anything else `server`. `decode` is a
//! `b64_json` payload that fails to base64-decode (or decodes to zero bytes).
//!
//! **Reply shapes.** `b64_json` (the desktop route's contract) is decoded
//! inline. A `{"data":[{"url": "https://..."}]}` reply (a presigned URL the
//! tenant itself issues in its authenticated reply, the shape the public
//! community route answered on 2026-11-02) is still understood: it is
//! downloaded https-only (every redirect hop too), with NO credentials
//! attached (the bearer token only ever goes to the tenant's own platform
//! host), at most 3 redirects and a 20 MiB streaming cap. A non-https URL
//! fails closed with kind `protocol`.
//!
//! Generation takes up to a minute per image, so `image_generate` is a managed
//! task (same cancel-safe registry pattern as the chat streams): exactly one
//! active generation per conversation, a new send aborts the previous one,
//! `image_cancel` aborts it explicitly. Different conversations may generate
//! in parallel.
//!
//! Persistence: on success the core appends ONE assistant message row
//! (`content` = prompt, `model` = [`IMAGE_MODEL`], `media_path` = the saved
//! file) via `chat_store::insert_image_message`. If the DB insert fails the
//! already-written file is deleted — no orphan files. The renderer then
//! loads the image through the Tauri asset protocol (scope pinned to
//! `app_data_dir/images` in `tauri.conf.json`); the bytes themselves never
//! cross the IPC boundary (S4).
//!
//! Round 6: the `generate_image` tool's optional `save_path` copies the PNG
//! into the user's folders through the tools core (`ToolAction::SaveImage`,
//! write_file's rules; outside every grant it falls back to the session temp
//! folder with an approval), and the user's own "Save as…" in the chat goes
//! through [`image_save_as`] (native save dialog opened by the core). Tool
//! images are saved before the reply's artifacts are persisted, so a reply
//! that fails in between leaves an orphan: [`sweep_orphan_images`] removes
//! unreferenced images older than 24 h at startup (best effort).
//!
//! Image EDITING (desktop sessions only, a per-profile route, see
//! [`edits_url`]) lives in `image_edit.rs`; it reuses this module's base,
//! save path, registry and events.
//!
//! Zero telemetry (S8): the only hosts contacted are the conversation
//! profile's own platform base (a compiled-in constant, S2) and, for the
//! `url` reply shape, the presigned storage URL that base returned; in debug
//! builds the `NAN_DESKTOP_MOCK_IMAGES` environment variable may point it at
//! a local mock (`test/mock-images.mjs`). Release builds ignore the variable
//! entirely (S12).

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
use crate::profile;

/// Image failure kinds: the generation route classifies like the edit route
/// (same platform contract), so both surfaces share one set of kinds.
pub type ImageErrorKind = crate::image_edit::EditErrorKind;

/// The image-generation model the desktop route runs on both tenants (the
/// server forces it; it is only stored on the result row).
pub const IMAGE_MODEL: &str = "flux-3-image-klein";

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

/// Join a `/v1/...` route `path` onto `base`. The compiled-in platform
/// bases are bare host roots (`https://cloud-api.nan.builders`); debug mocks
/// may be given with a `/v1` suffix (`http://127.0.0.1:14325/v1`). Either
/// way the wire path carries exactly ONE `/v1` prefix: never `/v1/v1/...`
/// (a 404) and never a path that lost its version prefix.
fn route_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let base = base.strip_suffix("/v1").unwrap_or(base);
    format!("{base}{path}")
}

/// The desktop-only generation endpoint on a platform base:
/// `{base}/v1/desktop/images/generations` on both tenants.
pub fn generations_url(base: &str) -> String {
    route_url(base, profile::DESKTOP_GENERATIONS_PATH)
}

/// The image EDIT endpoint of `profile_id` on a platform base. The tenants
/// mount it on different paths (see [`profile::image_edits_path`]):
/// community `/v1/images/edits`, enterprise `/v1/desktop/images/edits`.
/// `None` for an unknown profile.
pub fn edits_url(base: &str, profile_id: &str) -> Option<String> {
    profile::image_edits_path(profile_id).map(|path| route_url(base, path))
}

/// The base both image routes are called on: the profile's PLATFORM base
/// (debug builds: `NAN_DESKTOP_MOCK_IMAGES`, or the older
/// `NAN_DESKTOP_MOCK_IMAGE_EDITS`, may point it at `test/mock-images.mjs`;
/// release builds ignore both variables).
pub fn images_base(profile_id: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        for var in ["NAN_DESKTOP_MOCK_IMAGES", "NAN_DESKTOP_MOCK_IMAGE_EDITS"] {
            if let Ok(mock) = std::env::var(var) {
                let mock = mock.trim().trim_end_matches('/');
                if !mock.is_empty() {
                    return Some(mock.to_string());
                }
            }
        }
    }
    crate::device_flow::platform_base(profile_id)
}

/// The generation request body, field by field in wire order: `prompt`,
/// `size`, `n=1`. Never `model`: the desktop route forces it server-side.
pub fn generation_parts(prompt: &str, size: &str) -> Vec<(&'static str, String)> {
    vec![
        ("prompt", prompt.to_string()),
        ("size", size.to_string()),
        ("n", "1".to_string()),
    ]
}

/// [`generation_parts`] as a reqwest multipart form.
fn generation_form(prompt: &str, size: &str) -> reqwest::multipart::Form {
    let mut form = reqwest::multipart::Form::new();
    for (name, value) in generation_parts(prompt, size) {
        form = form.text(name, value);
    }
    form
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

/// Debug builds whose images base is the local mock (see [`images_base`])
/// may fetch the mock's loopback http image URL. Always `false` in release
/// builds (S12).
fn mock_images_active() -> bool {
    cfg!(debug_assertions)
        && ["NAN_DESKTOP_MOCK_IMAGES", "NAN_DESKTOP_MOCK_IMAGE_EDITS"]
            .iter()
            .any(|var| std::env::var(var).is_ok_and(|mock| !mock.trim().is_empty()))
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

/// The extensions this app saves images under (see [`save_image`]).
pub const SAVED_EXTENSIONS: [&str; 2] = ["png", "jpg"];

/// Whether `path` carries one of [`SAVED_EXTENSIONS`] (case-insensitive).
pub fn has_saved_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SAVED_EXTENSIONS.iter().any(|e| ext.eq_ignore_ascii_case(e)))
}

/// Resolve `raw` as an image this app generated: a regular `.png` or `.jpg`
/// file (never a symlink) sitting DIRECTLY inside [`images_dir`]. Returns
/// the canonical path. This is the only source the `generate_image` `save_path` copy and
/// the user's "Save as…" accept, so neither can be turned into a way to copy
/// an arbitrary file out of the user's disk.
pub fn verify_generated_image(app_data: &Path, raw: &Path) -> Result<PathBuf, &'static str> {
    let meta =
        std::fs::symlink_metadata(raw).map_err(|_| "the generated image no longer exists")?;
    if !meta.file_type().is_file() {
        return Err("the generated image is not a regular file");
    }
    let canonical =
        std::fs::canonicalize(raw).map_err(|_| "the generated image does not resolve")?;
    let dir = std::fs::canonicalize(images_dir(app_data))
        .map_err(|_| "the generated images folder does not resolve")?;
    if canonical.parent() != Some(dir.as_path()) || !has_saved_extension(&canonical) {
        return Err("only images generated by this app can be saved");
    }
    Ok(canonical)
}

/// Copy a generated image (see [`verify_generated_image`]) to `dest`, a path
/// the user picked in the native save dialog. Refuses to copy an image onto
/// itself. Returns the bytes written.
pub fn copy_generated_image(app_data: &Path, source: &Path, dest: &Path) -> Result<u64, String> {
    let source = verify_generated_image(app_data, source).map_err(str::to_string)?;
    if std::fs::canonicalize(dest).is_ok_and(|dest| dest == source) {
        return Err("the destination is the generated image itself".into());
    }
    let bytes = std::fs::read(&source).map_err(|err| format!("cannot read the image: {err}"))?;
    std::fs::write(dest, &bytes).map_err(|err| format!("cannot write the image: {err}"))?;
    Ok(bytes.len() as u64)
}

/// The save dialog's file-type filter for a generated image: JPEG for a
/// `.jpg` image (FLUX), PNG otherwise. The copy keeps the bytes as they
/// are, so the offered extension must match them.
pub fn save_dialog_filter(source: &Path) -> (&'static str, &'static [&'static str]) {
    const JPEG_EXTENSIONS: &[&str] = &["jpg", "jpeg"];
    const PNG_EXTENSIONS: &[&str] = &["png"];
    let is_jpeg = source
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg"));
    if is_jpeg {
        ("JPEG", JPEG_EXTENSIONS)
    } else {
        ("PNG", PNG_EXTENSIONS)
    }
}

/// The user's own "Save as…" on a generated image in the chat (round 6).
/// The NATIVE save dialog is opened from the core, so the destination never
/// comes from the renderer: no grant scope applies (this is the user's
/// action, not the agent's). The renderer only names which generated image
/// to save, and that source is verified to be one of this app's images.
/// Returns the saved path, or `None` when the user cancelled the dialog.
///
/// `async` on purpose (P0-3): the dialog's blocking call must never run on
/// the main thread.
#[tauri::command]
pub async fn image_save_as(app: AppHandle, source_path: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let app_data = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let source =
        verify_generated_image(&app_data, Path::new(&source_path)).map_err(str::to_string)?;
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "image.png".into());
    let (filter_name, filter_exts) = save_dialog_filter(&source);
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .set_file_name(file_name)
            .add_filter(filter_name, filter_exts)
            .blocking_save_file()
    })
    .await
    .map_err(|_| "the save dialog was interrupted".to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let dest = picked.into_path().map_err(|err| err.to_string())?;
    copy_generated_image(&app_data, &source, &dest)?;
    Ok(Some(dest.display().to_string()))
}

/// Minimum age of an unreferenced image before the startup sweep deletes it.
/// A generation in flight (or a tool reply whose artifacts are not
/// persisted yet) is always far younger than this, so it is never touched.
pub const ORPHAN_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Best-effort orphan sweep (round 6): delete `<app data>/images/<uuid>.<png|jpg>`
/// files that NO message references any more (see
/// [`chat_store::references_file_name`]) and whose mtime is at least
/// `min_age` before `now`. Orphans appear when a conversation fails after
/// the image was generated (the tool's file is saved before the reply's
/// artifacts are). Fail-safe: a missing or unreadable chat store, an
/// unreadable folder or a failing query deletes NOTHING (or stops the
/// sweep); only regular files named exactly `<uuid>.png` or `<uuid>.jpg` are candidates
/// (never symlinks, folders or anything else). Returns how many files were
/// deleted. Never panics.
pub fn sweep_orphan_images(
    app_data: &Path,
    min_age: std::time::Duration,
    now: std::time::SystemTime,
) -> usize {
    // No chat store at all: references are unknowable, keep everything.
    if !app_data.join(chat_store::DB_FILE).is_file() {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(images_dir(app_data)) else {
        return 0;
    };
    let Ok(conn) = chat_store::open_db(app_data) else {
        return 0;
    };
    let mut deleted = 0;
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_file() {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let is_generated_name = SAVED_EXTENSIONS.iter().any(|ext| {
            name.strip_suffix(ext)
                .and_then(|stem| stem.strip_suffix('.'))
                .is_some_and(|stem| uuid::Uuid::parse_str(stem).is_ok())
        });
        if !is_generated_name {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= min_age);
        if !old_enough {
            continue;
        }
        match chat_store::references_file_name(&conn, name) {
            Ok(true) => {}
            Ok(false) => {
                if std::fs::remove_file(entry.path()).is_ok() {
                    deleted += 1;
                }
            }
            // The store cannot answer: stop, never guess.
            Err(_) => break,
        }
    }
    deleted
}

/// Run [`sweep_orphan_images`] once at startup on a background thread (it
/// never delays the window). Logs only the count — never a path or content.
pub fn sweep_orphans_in_background(app_data: PathBuf) {
    let _ = std::thread::Builder::new()
        .name("orphan-image-sweep".into())
        .spawn(move || {
            let now = std::time::SystemTime::now();
            let deleted = sweep_orphan_images(&app_data, ORPHAN_MIN_AGE, now)
                + crate::image_edit::sweep_staged_sources(&app_data, ORPHAN_MIN_AGE, now);
            if deleted > 0 {
                eprintln!("helmcode-desktop: removed {deleted} orphaned generated image(s)");
            }
        });
}

/// The extension an image is saved under, decided by its MAGIC BYTES:
/// `jpg` for JPEG (FLUX answers `media_type: image/jpeg`), `png` for
/// everything else (PNG, and the qwen results). A reply's `media_type`
/// claim is never trusted on its own, like a file extension: bytes that do
/// not start with the JPEG signature are never named `.jpg`.
pub fn saved_extension(bytes: &[u8]) -> &'static str {
    match crate::image_edit::sniff_format(bytes) {
        Some(crate::image_edit::ImageFormat::Jpeg) => "jpg",
        _ => "png",
    }
}

/// Save image bytes as `<dir>/<uuid>.<png|jpg>` (see [`saved_extension`];
/// creating `dir` if missing) and return the absolute path. The uuid file
/// name keeps concurrent generations from colliding and needs no extra
/// metadata in the store.
pub fn save_image(dir: &Path, bytes: &[u8]) -> Result<PathBuf, chat::ErrorKind> {
    std::fs::create_dir_all(dir).map_err(|_| chat::ErrorKind::Protocol)?;
    let path = dir.join(format!(
        "{}.{}",
        uuid::Uuid::new_v4(),
        saved_extension(bytes)
    ));
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
    pub kind: ImageErrorKind,
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
pub(crate) fn reserve_image(state: &ImagesState, conversation_id: i64) -> Result<u64, String> {
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
pub(crate) fn attach_image(
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
pub(crate) fn release_image(state: &ImagesState, conversation_id: i64, generation: u64) {
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

/// The managed generation task: read the vault key, POST
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

    let emit_error = |kind: ImageErrorKind| {
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
        Err(_) => return emit_error(ImageErrorKind::Protocol),
    };
    let path = match save_image(&images_dir(&app_dir), &bytes) {
        Ok(path) => path,
        Err(kind) => return emit_error(kind.into()),
    };
    let media_path = path.to_string_lossy().to_string();
    let conn = match chat_store::open_db(&app_dir) {
        Ok(conn) => conn,
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            return emit_error(ImageErrorKind::Protocol);
        }
    };
    let persisted =
        chat_store::insert_image_message(&conn, conversation_id, &prompt, IMAGE_MODEL, &media_path)
            .and_then(|_| chat_store::touch_conversation(&conn, conversation_id));
    if persisted.is_err() {
        // The row could not be written — delete the file so no orphan is
        // left behind (the renderer only ever shows DB-backed images).
        let _ = std::fs::remove_file(&path);
        return emit_error(ImageErrorKind::Protocol);
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

/// Generate one image for `profile_id` and return the decoded bytes (JPEG
/// from FLUX; see [`save_image`] for the file name): the vault's desktop
/// session + the compiled-in platform base (Rust core only, S4), then
/// `POST {base}/v1/desktop/images/generations`. Shared by the composer's
/// image mode and the chat's `generate_image` tool. No session in the vault
/// is `missing_key`; a 429 is the tenant's monthly image quota
/// (`rate_limited`).
pub async fn request_image(
    profile_id: &str,
    prompt: &str,
    size: &str,
) -> Result<Vec<u8>, ImageErrorKind> {
    let token = chat::read_session_token(profile_id).ok_or(ImageErrorKind::MissingKey)?;
    request_image_with_token(profile_id, &token, prompt, size).await
}

/// [`request_image`] after the vault read: resolve the profile's platform
/// base, POST the generation, then decode (`b64_json`) or download
/// (presigned `url`). Split out so the live smoke test exercises the exact
/// production path with a session supplied from the environment.
pub async fn request_image_with_token(
    profile_id: &str,
    token: &str,
    prompt: &str,
    size: &str,
) -> Result<Vec<u8>, ImageErrorKind> {
    let base = images_base(profile_id).ok_or(ImageErrorKind::Protocol)?;
    generate_at(&base, token, prompt, size, mock_images_active()).await
}

/// The wire flow against one platform base: POST the multipart generation
/// with the session bearer (to `base` ONLY), then decode the `b64_json` or
/// download the presigned `url` WITHOUT credentials. Statuses classify like
/// the edit route ([`crate::image_edit::classify_edit_status`]).
async fn generate_at(
    base: &str,
    token: &str,
    prompt: &str,
    size: &str,
    allow_loopback_http: bool,
) -> Result<Vec<u8>, ImageErrorKind> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(chat::CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|_| ImageErrorKind::Protocol)?;
    // No overall request timeout: a ~1-minute generation must not be killed
    // mid-flight (same policy as the chat streams).
    let response = client
        .post(generations_url(base))
        .bearer_auth(token)
        .multipart(generation_form(prompt, size))
        .send()
        .await
        .map_err(|_| ImageErrorKind::Network)?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(crate::image_edit::classify_edit_status(status));
    }
    let body = response.text().await.map_err(|_| ImageErrorKind::Network)?;
    match parse_reply(&body, allow_loopback_http)? {
        ImageReply::Bytes(bytes) => Ok(bytes),
        ImageReply::Url(url) => Ok(download_with(&url, allow_loopback_http).await?),
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
            "size": { "type": "string", "description": "WIDTHxHEIGHT, each 512-1280 in steps of 16. Default 1024x1024." },
            "save_path": { "type": "string", "description": "Optional. Absolute path of an image file (or a folder; the file keeps the image's own format, .jpg or .png) inside one of the user's working folders to also save the image there, with the same approval as write_file. A path outside the working folders is NOT saved there: ask the user to add that folder first." }
        }, "required": ["prompt"] }
    }})
}

/// The optional `save_path` argument of a `generate_image` call (trimmed;
/// empty or missing → `None`, the image only lands in the chat).
pub fn parse_save_path(arguments: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let path = value.get("save_path")?.as_str()?.trim();
    (!path.is_empty()).then(|| path.to_string())
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

/// [`tool_result_for_model`] plus the outcome of the `save_path` copy
/// (`save`, built by `tools::image_save_for_model`), when one was asked.
#[cfg_attr(not(test), allow(dead_code))]
pub fn tool_result_for_model(result: &Result<PathBuf, ImageErrorKind>) -> String {
    tool_result_with_save(result, None)
}

pub fn tool_result_with_save(
    result: &Result<PathBuf, ImageErrorKind>,
    save: Option<serde_json::Value>,
) -> String {
    match result {
        Ok(path) => {
            let mut reply = serde_json::json!({
                "ok": true,
                "summary": "image created and already shown to the user in the chat",
                "path": path.display().to_string(),
            });
            if let Some(save) = save {
                reply["save"] = save;
            }
            reply.to_string()
        }
        Err(ImageErrorKind::RateLimited) => serde_json::json!({
            "ok": false,
            "error": "quota_exhausted",
            "message": "The monthly image quota is used up. Tell the user; do not retry.",
        })
        .to_string(),
        Err(ImageErrorKind::TierRestricted | ImageErrorKind::NotAvailable) => serde_json::json!({
            "ok": false,
            "error": "not_available",
            "message": "Image generation is not available on the user's plan or account. Tell the user; do not retry.",
        })
        .to_string(),
        Err(kind) => serde_json::json!({
            "ok": false,
            "error": "image_failed",
            "message": format!("Image generation failed ({}). Tell the user; do not retry more than once.", kind.as_str()),
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
) -> Result<PathBuf, ImageErrorKind> {
    let bytes = request_image(profile_id, prompt, size).await?;
    Ok(save_image(&images_dir(app_data), &bytes)?)
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

    // ---- generation_parts (multipart fields of the desktop route) ---------------

    #[test]
    fn generation_parts_are_prompt_size_then_n_1_and_never_the_model() {
        assert_eq!(
            generation_parts("a cat on a roof", "1024x1024"),
            vec![
                ("prompt", "a cat on a roof".to_string()),
                ("size", "1024x1024".to_string()),
                ("n", "1".to_string()),
            ]
        );
        // The desktop route forces the model server-side: never sent.
        assert!(
            !generation_parts("x", "512x512")
                .iter()
                .any(|(name, _)| *name == "model")
        );
    }

    #[test]
    fn generation_parts_carry_the_prompt_verbatim_including_multibyte() {
        let parts = generation_parts("Café ☕, listó", "768x512");
        assert_eq!(parts[0], ("prompt", "Café ☕, listó".to_string()));
        assert_eq!(parts[1], ("size", "768x512".to_string()));
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

    // ---- images_dir + save_image ---------------------------------------------------

    /// A JPEG header (what FLUX answers with `media_type: image/jpeg`).
    const FAKE_JPEG: &[u8] = b"\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01";

    #[test]
    fn images_dir_is_the_images_subdirectory() {
        assert_eq!(
            images_dir(Path::new("/home/u/AppData")),
            PathBuf::from("/home/u/AppData/images")
        );
    }

    #[test]
    fn save_image_writes_exact_bytes_under_a_png_name_for_non_jpeg() {
        let dir = TempDir::new().expect("temp dir");
        let bytes = b"fake png bytes \xF0\x9F\x98\x80";
        let path = save_image(&dir.path().join("nested"), bytes).expect("save");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("png"));
        assert!(path.starts_with(dir.path()));
        assert_eq!(std::fs::read(&path).expect("read"), bytes.to_vec());
        // A real PNG keeps .png too.
        let png = save_image(dir.path(), &tiny_png()).expect("save png");
        assert_eq!(png.extension().and_then(|e| e.to_str()), Some("png"));
    }

    #[test]
    fn save_image_names_jpeg_bytes_jpg() {
        let dir = TempDir::new().expect("temp dir");
        let path = save_image(dir.path(), FAKE_JPEG).expect("save");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("jpg"));
        assert_eq!(std::fs::read(&path).expect("read"), FAKE_JPEG.to_vec());
        let stem = path.file_stem().and_then(|s| s.to_str()).expect("stem");
        assert!(uuid::Uuid::parse_str(stem).is_ok(), "uuid file name");
    }

    #[test]
    fn saved_extension_follows_the_magic_bytes_only() {
        assert_eq!(saved_extension(FAKE_JPEG), "jpg");
        assert_eq!(saved_extension(&tiny_png()), "png");
        // Anything that is not JPEG by its bytes is never named .jpg.
        assert_eq!(saved_extension(b"\xFF\xD8"), "png");
        assert_eq!(saved_extension(b""), "png");
        assert_eq!(saved_extension(b"RIFF\0\0\0\0WEBPVP8 "), "png");
    }

    #[test]
    fn save_image_names_are_unique() {
        let dir = TempDir::new().expect("temp dir");
        let a = save_image(dir.path(), b"one").expect("save a");
        let b = save_image(dir.path(), b"two").expect("save b");
        assert_ne!(a, b, "uuid file names never collide");
    }

    #[test]
    fn the_save_dialog_offers_the_images_own_format() {
        assert_eq!(
            save_dialog_filter(Path::new("/d/images/a.jpg")),
            ("JPEG", &["jpg", "jpeg"][..])
        );
        assert_eq!(
            save_dialog_filter(Path::new("/d/images/a.png")),
            ("PNG", &["png"][..])
        );
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
    fn generation_url_is_the_desktop_route_on_both_tenants() {
        for (id, expected) in [
            (
                "nan",
                "https://cloud-api.nan.builders/v1/desktop/images/generations",
            ),
            (
                "helmcode",
                "https://cloud-api.helmcode.com/v1/desktop/images/generations",
            ),
        ] {
            let base = crate::profile::platform_base_for(id).expect("tenant");
            let url = generations_url(base);
            assert_eq!(url, expected);
            assert!(!url.contains("/v1/v1/"), "no doubled /v1 prefix");
        }
        // A mock root given with /v1 (and a trailing slash) still yields
        // exactly one /v1 prefix.
        assert_eq!(
            generations_url("http://127.0.0.1:1/v1/"),
            "http://127.0.0.1:1/v1/desktop/images/generations"
        );
        assert_eq!(
            generations_url("https://cloud-api.nan.builders/"),
            "https://cloud-api.nan.builders/v1/desktop/images/generations"
        );
        for base in [
            "https://cloud-api.nan.builders/v1",
            "https://cloud-api.nan.builders",
            "http://127.0.0.1:9/v1",
        ] {
            let url = generations_url(base);
            assert!(url.ends_with("/v1/desktop/images/generations"), "{url}");
            assert_eq!(url.matches("/v1/").count(), 1, "{url}");
            // Never the public route any more.
            assert!(!url.ends_with("/v1/images/generations"), "{url}");
        }
    }

    #[test]
    fn edit_urls_are_resolved_per_profile() {
        assert_eq!(
            edits_url("https://cloud-api.nan.builders", "nan").as_deref(),
            Some("https://cloud-api.nan.builders/v1/images/edits")
        );
        assert_eq!(
            edits_url("https://cloud-api.helmcode.com", "helmcode").as_deref(),
            Some("https://cloud-api.helmcode.com/v1/desktop/images/edits")
        );
        // The /v1 rule applies to both paths.
        assert_eq!(
            edits_url("http://127.0.0.1:9/v1/", "helmcode").as_deref(),
            Some("http://127.0.0.1:9/v1/desktop/images/edits")
        );
        assert_eq!(edits_url("https://cloud-api.nan.builders", "other"), None);
    }

    #[test]
    fn the_production_request_path_uses_the_compiled_in_base_unchanged() {
        // `request_image_with_token` resolves the base through
        // `images_base` (the platform base); without the debug mock
        // variables it is the compiled-in constant, so the wire URL is
        // pinned end to end.
        if std::env::var("NAN_DESKTOP_MOCK_IMAGES").is_err()
            && std::env::var("NAN_DESKTOP_MOCK_IMAGE_EDITS").is_err()
            && std::env::var("NAN_DESKTOP_MOCK_PLATFORM").is_err()
        {
            for (id, expected) in [
                (
                    "nan",
                    "https://cloud-api.nan.builders/v1/desktop/images/generations",
                ),
                (
                    "helmcode",
                    "https://cloud-api.helmcode.com/v1/desktop/images/generations",
                ),
            ] {
                let base = images_base(id).expect("base");
                assert_eq!(generations_url(&base), expected);
            }
            assert_eq!(
                edits_url(&images_base("helmcode").expect("base"), "helmcode").as_deref(),
                Some("https://cloud-api.helmcode.com/v1/desktop/images/edits")
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

    /// The desktop session JWT the e2e tenant expects.
    const E2E_KEY: &str = "fake-session-jwt-e2e";

    /// The mock tenant: answers the desktop generation route with the url
    /// shape, pointing at a SEPARATE storage host (another loopback port).
    fn start_tenant(storage_origin: String) -> Loopback {
        Loopback::start(move |path, request| {
            if path != "/v1/desktop/images/generations" {
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

        // Tenant: exactly one multipart POST to the desktop route WITH the
        // session: prompt, size, n=1 and never a model.
        let tenant_requests = tenant.requests();
        assert_eq!(tenant_requests.len(), 1);
        assert_eq!(tenant_requests[0].0, "/v1/desktop/images/generations");
        let request = &tenant_requests[0].1;
        assert!(request.head.starts_with("post "));
        assert!(
            request
                .head
                .contains("content-type: multipart/form-data; boundary=")
        );
        let body = String::from_utf8_lossy(&request.body);
        assert!(body.contains("name=\"prompt\"\r\n\r\nun gato astronauta\r\n"));
        assert!(body.contains("name=\"size\"\r\n\r\n1024x1024\r\n"));
        assert!(body.contains("name=\"n\"\r\n\r\n1\r\n"));
        assert!(!body.contains("name=\"model\""));

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
        let saved = save_image(&images_dir(app_data.path()), &bytes).map_err(ImageErrorKind::from);
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
        // b64_json shape (the desktop route's contract) end to end.
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
        // The platform contract, like the edit route: 429 is the monthly
        // quota, 403 the plan, 404 a route that is not mounted (NOT
        // silently ok), 400 a refused request.
        for (status, kind) in [
            ("429 Too Many Requests", ImageErrorKind::RateLimited),
            ("401 Unauthorized", ImageErrorKind::Unauthorized),
            ("403 Forbidden", ImageErrorKind::TierRestricted),
            ("404 Not Found", ImageErrorKind::NotAvailable),
            ("400 Bad Request", ImageErrorKind::InvalidRequest),
            ("502 Bad Gateway", ImageErrorKind::Server),
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
    fn e2e_a_flux_jpeg_reply_is_saved_as_jpg() {
        // FLUX answers `media_type: image/jpeg` with JPEG bytes: the bytes
        // arrive intact and the saved file is `<uuid>.jpg`.
        let jpeg_b64 = BASE64_STANDARD.encode(FAKE_JPEG);
        let tenant = Loopback::start(move |_, _| {
            let body = format!(
                r#"{{"created":1,"data":[{{"b64_json":"{jpeg_b64}","media_type":"image/jpeg"}}]}}"#
            );
            http_response("200 OK", &[], body.as_bytes())
        });
        let bytes = block_on(generate_at(
            &format!("{}/v1", tenant.origin),
            E2E_KEY,
            "un zorro",
            "1024x1024",
            false,
        ))
        .expect("generation");
        assert_eq!(bytes, FAKE_JPEG.to_vec());
        let app_data = TempDir::new().expect("app data");
        let path = save_image(&images_dir(app_data.path()), &bytes).expect("saved");
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("jpg"));
        // A saved JPEG is one of this app's images (Save as, save_path).
        assert!(verify_generated_image(app_data.path(), &path).is_ok());
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
            Err(ImageErrorKind::Protocol)
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(storage.requests().is_empty());
    }

    // ---- LIVE smoke (manual: real community tenant, real key) ----------------------

    /// Real generation through the app's own path against the community's
    /// desktop route (`https://cloud-api.nan.builders/v1/desktop/images/
    /// generations`). Ignored by default (needs the network and a desktop
    /// session). Run:
    ///
    /// ```sh
    /// NAN_SMOKE_SESSION=<desktop session JWT> \
    ///   cargo test live_smoke -- --ignored --nocapture
    /// ```
    ///
    /// The session is never printed. The image is written to
    /// `NAN_SMOKE_OUT` (default `/tmp/nan-desktop-live-smoke.img`).
    #[test]
    #[ignore = "live network smoke: needs a desktop session (see doc comment)"]
    fn live_smoke_community_generation() {
        assert!(
            std::env::var("NAN_DESKTOP_MOCK_IMAGES").is_err()
                && std::env::var("NAN_DESKTOP_MOCK_IMAGE_EDITS").is_err(),
            "unset the image mock variables: the smoke must hit the real tenant"
        );
        let key = std::env::var("NAN_SMOKE_SESSION").expect("set NAN_SMOKE_SESSION");
        assert!(!key.is_empty());
        let out = std::env::var("NAN_SMOKE_OUT")
            .unwrap_or_else(|_| "/tmp/nan-desktop-live-smoke.img".to_string());

        let base = images_base("nan").expect("nan base");
        println!("live smoke: POST {}", generations_url(&base));
        let started = std::time::Instant::now();
        let result = block_on(request_image_with_token(
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
            serde_json::from_str(&tool_result_for_model(&Err(ImageErrorKind::RateLimited)))
                .expect("json");
        assert_eq!(quota["error"], "quota_exhausted");
        for kind in [ImageErrorKind::TierRestricted, ImageErrorKind::NotAvailable] {
            let plan: serde_json::Value =
                serde_json::from_str(&tool_result_for_model(&Err(kind))).expect("json");
            assert_eq!(plan["error"], "not_available", "{kind:?}");
        }
        let failed: serde_json::Value =
            serde_json::from_str(&tool_result_for_model(&Err(ImageErrorKind::Server)))
                .expect("json");
        assert_eq!(failed["ok"], false);
        assert!(
            failed["message"]
                .as_str()
                .is_some_and(|m| m.contains("(server)"))
        );
    }

    // ---- round 6: save_path + Save as… ---------------------------------------

    #[test]
    fn generate_image_offers_an_optional_save_path() {
        let def = tool_definition();
        let save_path = &def["function"]["parameters"]["properties"]["save_path"];
        assert_eq!(save_path["type"], "string");
        assert!(
            save_path["description"]
                .as_str()
                .is_some_and(|d| d.contains("working folders")),
            "the model learns save_path only works inside working folders"
        );
        assert_eq!(
            parse_save_path(r#"{"prompt":"x","save_path":" /Users/ana/Arte/zorro.png "}"#),
            Some("/Users/ana/Arte/zorro.png".into())
        );
        assert_eq!(parse_save_path(r#"{"prompt":"x"}"#), None);
        assert_eq!(parse_save_path(r#"{"prompt":"x","save_path":"  "}"#), None);
        assert_eq!(parse_save_path(r#"{"prompt":"x","save_path":7}"#), None);
        assert_eq!(parse_save_path("not json"), None);
    }

    #[test]
    fn no_save_path_keeps_the_tool_result_unchanged() {
        let ok = Ok(PathBuf::from("/data/images/a.png"));
        assert_eq!(tool_result_with_save(&ok, None), tool_result_for_model(&ok));
        let plain: serde_json::Value =
            serde_json::from_str(&tool_result_for_model(&ok)).expect("json");
        assert!(plain.get("save").is_none());
        let saved: serde_json::Value = serde_json::from_str(&tool_result_with_save(
            &ok,
            Some(serde_json::json!({ "saved": true })),
        ))
        .expect("json");
        assert_eq!(saved["ok"], true);
        assert_eq!(saved["path"], "/data/images/a.png");
        assert_eq!(saved["save"]["saved"], true);
        // A failed generation never reports a save.
        let failed: serde_json::Value = serde_json::from_str(&tool_result_with_save(
            &Err(ImageErrorKind::Server),
            Some(serde_json::json!({ "saved": true })),
        ))
        .expect("json");
        assert!(failed.get("save").is_none());
    }

    #[test]
    fn save_as_copies_only_images_this_app_generated() {
        let app_data = TempDir::new().expect("app data");
        let saved = save_image(&images_dir(app_data.path()), b"png-bytes").expect("save");
        let out = TempDir::new().expect("out");
        let dest = out.path().join("mine.png");
        assert_eq!(copy_generated_image(app_data.path(), &saved, &dest), Ok(9));
        assert_eq!(std::fs::read(&dest).expect("copy"), b"png-bytes");
        assert!(saved.exists(), "the chat keeps its copy");
        // Anything outside app_data/images is refused.
        let outside = out.path().join("secret.png");
        std::fs::write(&outside, "secret").expect("secret");
        assert!(verify_generated_image(app_data.path(), &outside).is_err());
        assert!(
            copy_generated_image(app_data.path(), &outside, &out.path().join("x.png")).is_err()
        );
        // Not a png, a nested file or a missing one: refused too.
        let images = images_dir(app_data.path());
        std::fs::write(images.join("notes.txt"), "x").expect("txt");
        assert!(verify_generated_image(app_data.path(), &images.join("notes.txt")).is_err());
        std::fs::create_dir_all(images.join("sub")).expect("sub");
        std::fs::write(images.join("sub").join("a.png"), "x").expect("nested");
        assert!(
            verify_generated_image(app_data.path(), &images.join("sub").join("a.png")).is_err()
        );
        assert!(verify_generated_image(app_data.path(), &images.join("gone.png")).is_err());
        // Never onto itself.
        assert!(copy_generated_image(app_data.path(), &saved, &saved).is_err());
        assert_eq!(std::fs::read(&saved).expect("intact"), b"png-bytes");
    }

    #[cfg(unix)]
    #[test]
    fn save_as_refuses_a_symlink_planted_in_the_images_folder() {
        let app_data = TempDir::new().expect("app data");
        let images = images_dir(app_data.path());
        std::fs::create_dir_all(&images).expect("images");
        let out = TempDir::new().expect("out");
        let secret = out.path().join("secret.png");
        std::fs::write(&secret, "secret").expect("secret");
        let link = images.join("planted.png");
        std::os::unix::fs::symlink(&secret, &link).expect("symlink");
        assert!(verify_generated_image(app_data.path(), &link).is_err());
    }

    // ---- round 6: orphan sweep --------------------------------------------------

    /// Backdate a file's mtime by `age`.
    fn age_file(path: &Path, age: std::time::Duration) {
        let file = std::fs::File::options()
            .write(true)
            .open(path)
            .expect("open");
        file.set_modified(std::time::SystemTime::now() - age)
            .expect("set mtime");
    }

    const TWO_DAYS: std::time::Duration = std::time::Duration::from_secs(48 * 60 * 60);

    #[test]
    fn sweep_deletes_old_orphans_and_keeps_referenced_and_fresh_images() {
        let app_data = TempDir::new().expect("app data");
        let dir = images_dir(app_data.path());
        let conn = chat_store::open_db(app_data.path()).expect("db");
        let conv = chat_store::insert_conversation(&conn, "nan", "t").expect("conv");

        // Referenced by an image row (composer image mode; a FLUX JPEG).
        let by_media = save_image(&dir, FAKE_JPEG).expect("jpg");
        assert_eq!(by_media.extension().and_then(|e| e.to_str()), Some("jpg"));
        chat_store::insert_image_message(
            &conn,
            conv,
            "p",
            IMAGE_MODEL,
            &by_media.display().to_string(),
        )
        .expect("image row");
        // Referenced by a tool reply's artifacts.
        let by_artifact = save_image(&dir, b"b").expect("png");
        let reply = chat_store::insert_message(&conn, conv, "assistant", "Aquí está.", Some("m"))
            .expect("reply");
        chat_store::set_message_artifacts(
            &conn,
            reply,
            &[chat_store::Artifact {
                path: by_artifact.display().to_string(),
                kind: chat_store::ArtifactKind::Image,
            }],
        )
        .expect("artifacts");
        // Only quoted in a reply's text: kept too (never guess).
        let by_text = save_image(&dir, b"c").expect("png");
        chat_store::insert_message(
            &conn,
            conv,
            "assistant",
            &format!("Guardada en {}", by_text.display()),
            Some("m"),
        )
        .expect("text row");
        // The leak: generated, then the conversation failed.
        let orphan = save_image(&dir, b"d").expect("png");
        let jpg_orphan = save_image(&dir, FAKE_JPEG).expect("jpg");
        // An orphan still being produced (in flight): fresh, kept.
        let fresh = save_image(&dir, b"e").expect("png");
        // Not a generated name: never a candidate, whatever its age.
        let foreign = dir.join("keep-me.png");
        std::fs::write(&foreign, "x").expect("foreign");
        let foreign_jpg = dir.join("keep-me.jpg");
        std::fs::write(&foreign_jpg, "x").expect("foreign jpg");
        drop(conn);
        for old in [
            &by_media,
            &by_artifact,
            &by_text,
            &orphan,
            &jpg_orphan,
            &foreign,
        ] {
            age_file(old, TWO_DAYS);
        }
        age_file(&foreign_jpg, TWO_DAYS);

        let deleted = sweep_orphan_images(
            app_data.path(),
            ORPHAN_MIN_AGE,
            std::time::SystemTime::now(),
        );
        assert_eq!(deleted, 2);
        assert!(!orphan.exists(), "the old orphan is deleted");
        assert!(!jpg_orphan.exists(), "the old JPEG orphan is deleted");
        for kept in [
            &by_media,
            &by_artifact,
            &by_text,
            &fresh,
            &foreign,
            &foreign_jpg,
        ] {
            assert!(kept.exists(), "{} must be kept", kept.display());
        }
        // Idempotent.
        assert_eq!(
            sweep_orphan_images(
                app_data.path(),
                ORPHAN_MIN_AGE,
                std::time::SystemTime::now()
            ),
            0
        );
        assert_eq!(ORPHAN_MIN_AGE, std::time::Duration::from_secs(86_400));
    }

    #[test]
    fn sweep_never_deletes_when_the_store_is_missing_or_corrupted() {
        // No chat store at all: references are unknowable.
        let app_data = TempDir::new().expect("app data");
        let orphan = save_image(&images_dir(app_data.path()), b"x").expect("png");
        age_file(&orphan, TWO_DAYS);
        assert_eq!(
            sweep_orphan_images(
                app_data.path(),
                ORPHAN_MIN_AGE,
                std::time::SystemTime::now()
            ),
            0
        );
        assert!(orphan.exists());
        // A corrupted chat store: nothing deleted, no panic.
        std::fs::write(
            app_data.path().join(chat_store::DB_FILE),
            b"definitely not sqlite",
        )
        .expect("corrupt db");
        assert_eq!(
            sweep_orphan_images(
                app_data.path(),
                ORPHAN_MIN_AGE,
                std::time::SystemTime::now()
            ),
            0
        );
        assert!(orphan.exists());
        // No images folder: nothing to do, no panic.
        let empty = TempDir::new().expect("empty");
        chat_store::open_db(empty.path()).expect("db");
        assert_eq!(
            sweep_orphan_images(empty.path(), ORPHAN_MIN_AGE, std::time::SystemTime::now()),
            0
        );
    }

    #[test]
    fn sweep_survives_unparsable_artifacts_json() {
        // A row whose artifacts JSON is damaged still protects its image:
        // matching is on the raw column text.
        let app_data = TempDir::new().expect("app data");
        let image = save_image(&images_dir(app_data.path()), b"x").expect("png");
        let conn = chat_store::open_db(app_data.path()).expect("db");
        let conv = chat_store::insert_conversation(&conn, "nan", "t").expect("conv");
        let reply =
            chat_store::insert_message(&conn, conv, "assistant", "", Some("m")).expect("reply");
        conn.execute(
            "UPDATE messages SET artifacts = ?1 WHERE id = ?2",
            rusqlite::params![format!("[{{\"path\": \"{}\"", image.display()), reply],
        )
        .expect("damage");
        drop(conn);
        age_file(&image, TWO_DAYS);
        assert_eq!(
            sweep_orphan_images(
                app_data.path(),
                ORPHAN_MIN_AGE,
                std::time::SystemTime::now()
            ),
            0
        );
        assert!(image.exists());
    }

    #[cfg(unix)]
    #[test]
    fn sweep_never_follows_or_removes_symlinks() {
        let app_data = TempDir::new().expect("app data");
        let dir = images_dir(app_data.path());
        std::fs::create_dir_all(&dir).expect("dir");
        chat_store::open_db(app_data.path()).expect("db");
        let out = TempDir::new().expect("out");
        let target = out.path().join("victim.png");
        std::fs::write(&target, "keep").expect("victim");
        age_file(&target, TWO_DAYS);
        let link = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        assert_eq!(
            sweep_orphan_images(
                app_data.path(),
                ORPHAN_MIN_AGE,
                std::time::SystemTime::now()
            ),
            0
        );
        assert!(target.exists() && link.exists());
    }

    #[test]
    fn image_model_is_flux_on_the_desktop_route() {
        assert_eq!(IMAGE_MODEL, "flux-3-image-klein");
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
