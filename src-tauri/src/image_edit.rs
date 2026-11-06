//! Image EDITING on the profile's platform API, a per-tenant route (see
//! [`images::edits_url`]): community `POST /v1/images/edits`, enterprise
//! `POST /v1/desktop/images/edits`. Both tenants serve it to DESKTOP
//! sessions only, so the request carries the profile's desktop session JWT
//! (vault account `<profile>.session`, the same credential web search and
//! memory sync use), never the inference key.
//!
//! Contract (multipart/form-data): `prompt` (the edit instruction,
//! 1..=2000 chars; OpenAI field name, the platform reads `prompt`),
//! `image[]` (1..=N image files, N set by the tenant's edit model: see
//! [`max_edit_images_for`]), `n=1`. The reply is ALWAYS
//! `{"data":[{"b64_json": ...}]}`; a `url` reply is a protocol error and is
//! never fetched. Status mapping (UI kinds): 400 `invalid_request`, 401
//! `unauthorized`, 403 `tier_restricted`, 404 `not_available` (the feature
//! is not deployed or not enabled for this account, e.g. the enterprise
//! route briefly unmounted), 429 `rate_limited`, anything else `server`.
//!
//! Sources. The renderer only NAMES images; the bytes are read from disk
//! by this core and never cross the IPC boundary. A source is accepted
//! only when it is one of this app's own images:
//!
//! - a chat image (`<app data>/images/<uuid>.<png|jpg>`, a generated or edited
//!   result, referenced by its `media_path` or tool artifact path), or
//! - a STAGED pick (`<app data>/images/staged/<uuid>.<png|jpg|webp>`): the
//!   user's local file, picked with the NATIVE file dialog opened by the
//!   core ([`image_edit_pick`]), which must sit under one of the profile's
//!   folder grants (tools core) and is refused on the sensitive-path
//!   deny-list (credentials, login items, shell startup files, key files)
//!   and inside the app data folder, whatever the grant. The validated
//!   bytes are copied into the staged folder so the tray can show a
//!   thumbnail through the asset protocol (scope `$APPDATA/images/**`).
//!
//! Every source is re-verified at edit time: regular file (never a
//! symlink), inside those two folders, at most [`MAX_EDIT_IMAGE_BYTES`],
//! PNG/JPEG/WebP by magic bytes, 1..=[`max_edit_images_for`] sources for
//! the profile's edit model (FLUX takes ONE image; sending more is a 400,
//! so it is refused locally first).
//!
//! Lifecycle and persistence reuse the generation surface: the same
//! per-conversation registry (`image_cancel` stops an edit too) and the
//! same `images://started|done|error|stopped` events, plus
//! `images://progress {conversation_id, stage}` (`uploading`, `saving`).
//! The result is saved like a generated image (`images::save_image`:
//! `.jpg` for a JPEG reply, `.png` otherwise; R2-independent, the bytes
//! arrive inline) and persisted as a CHILD assistant row whose
//! `parent_message_id` links the message the source image came from.
//!
//! Privacy: the instruction and the image bytes are never logged; nothing
//! in this module logs at all.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::chat;
use crate::chat_store;
use crate::images;
use crate::tools::grants;

/// The model the profile's edit route runs (stored on the result row; the
/// app never sends it). See [`crate::profile::image_edit_model`].
pub fn edit_model_for(profile_id: &str) -> Option<&'static str> {
    crate::profile::image_edit_model(profile_id)
}

/// Most source images per edit for any model (qwen; platform contract).
pub const MAX_EDIT_IMAGES: usize = 3;

/// Most source images an edit on `model` accepts (the bridge's model
/// registry): `flux-3-image-klein` takes exactly ONE (the base);
/// `qwen-image-3.0-pro` 1..=3. Unknown models get the strictest cap.
pub fn max_edit_images_for(model: &str) -> usize {
    match model {
        "qwen-image-3.0-pro" => MAX_EDIT_IMAGES,
        _ => 1,
    }
}

/// Largest source image accepted (20 MiB).
pub const MAX_EDIT_IMAGE_BYTES: u64 = 20 << 20;

/// Longest instruction accepted, in characters (platform contract).
pub const MAX_INSTRUCTION_CHARS: usize = 2000;

/// Largest edit reply body read (base64 of a large PNG plus JSON framing).
pub const MAX_EDIT_RESPONSE_BYTES: u64 = 64 << 20;

/// Folder (under the images folder) holding the user's staged picks.
pub const STAGED_DIR: &str = "staged";

// ---------------------------------------------------------------------------
// Error kinds (serialized snake_case; the renderer maps them to copy)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EditErrorKind {
    // ---- local validation (before any network work) ----
    /// Blank, or longer than [`MAX_INSTRUCTION_CHARS`].
    InvalidInstruction,
    /// No source image.
    NoImages,
    /// More sources than the edit model accepts ([`max_edit_images_for`]).
    TooManyImages,
    /// A source is larger than [`MAX_EDIT_IMAGE_BYTES`].
    ImageTooLarge,
    /// A source is not PNG, JPEG or WebP (magic bytes).
    UnsupportedImage,
    /// A source is not one of this app's images, or a pick sits outside
    /// every folder grant / on the sensitive deny-list.
    SourceNotAllowed,
    /// The parent message is not a row of the conversation.
    InvalidParent,
    // ---- remote ----
    /// No desktop session in the vault for the profile.
    MissingKey,
    /// 401: the session is no longer valid.
    Unauthorized,
    /// 404: editing is not available for this account.
    NotAvailable,
    /// 403: the plan does not include image editing.
    TierRestricted,
    /// 400: the platform refused the request.
    InvalidRequest,
    /// 429.
    RateLimited,
    /// 5xx and any other non-2xx status.
    Server,
    /// Transport failure.
    Network,
    /// Local failure (store, files) or a malformed reply.
    Protocol,
    /// The reply image could not be decoded.
    Decode,
}

impl EditErrorKind {
    /// The wire string (same as the serde form), for command errors.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidInstruction => "invalid_instruction",
            Self::NoImages => "no_images",
            Self::TooManyImages => "too_many_images",
            Self::ImageTooLarge => "image_too_large",
            Self::UnsupportedImage => "unsupported_image",
            Self::SourceNotAllowed => "source_not_allowed",
            Self::InvalidParent => "invalid_parent",
            Self::MissingKey => "missing_key",
            Self::Unauthorized => "unauthorized",
            Self::NotAvailable => "not_available",
            Self::TierRestricted => "tier_restricted",
            Self::InvalidRequest => "invalid_request",
            Self::RateLimited => "rate_limited",
            Self::Server => "server",
            Self::Network => "network",
            Self::Protocol => "protocol",
            Self::Decode => "decode",
        }
    }
}

impl From<chat::ErrorKind> for EditErrorKind {
    fn from(kind: chat::ErrorKind) -> Self {
        match kind {
            chat::ErrorKind::MissingKey => Self::MissingKey,
            chat::ErrorKind::Unauthorized => Self::Unauthorized,
            chat::ErrorKind::RateLimited => Self::RateLimited,
            chat::ErrorKind::Server => Self::Server,
            chat::ErrorKind::Network => Self::Network,
            chat::ErrorKind::Protocol => Self::Protocol,
            chat::ErrorKind::Decode => Self::Decode,
        }
    }
}

/// Classify a non-2xx status of the edits endpoint.
pub fn classify_edit_status(status: u16) -> EditErrorKind {
    match status {
        400 => EditErrorKind::InvalidRequest,
        401 => EditErrorKind::Unauthorized,
        403 => EditErrorKind::TierRestricted,
        404 => EditErrorKind::NotAvailable,
        429 => EditErrorKind::RateLimited,
        _ => EditErrorKind::Server,
    }
}

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

/// Image formats the edit endpoint accepts, detected by magic bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Webp,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }
}

/// Detect PNG / JPEG / WebP from the leading bytes (the extension is never
/// trusted).
pub fn sniff_format(bytes: &[u8]) -> Option<ImageFormat> {
    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.starts_with(&PNG) {
        return Some(ImageFormat::Png);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageFormat::Jpeg);
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(ImageFormat::Webp);
    }
    None
}

/// Trim and bound the instruction: non-blank, at most
/// [`MAX_INSTRUCTION_CHARS`] characters (not bytes).
pub fn validate_instruction(raw: &str) -> Result<String, EditErrorKind> {
    let instruction = raw.trim();
    if instruction.is_empty() || instruction.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(EditErrorKind::InvalidInstruction);
    }
    Ok(instruction.to_string())
}

/// 1..=`max` sources (`max` from [`max_edit_images_for`]).
pub fn validate_source_count(count: usize, max: usize) -> Result<(), EditErrorKind> {
    match count {
        0 => Err(EditErrorKind::NoImages),
        n if n > max => Err(EditErrorKind::TooManyImages),
        _ => Ok(()),
    }
}

/// The staged-picks folder: `<app data>/images/staged`.
pub fn staged_dir(app_data: &Path) -> PathBuf {
    images::images_dir(app_data).join(STAGED_DIR)
}

/// `<uuid>.<ext>` with an allowed image extension.
fn is_app_image_name(name: &str, allowed: &[&str]) -> bool {
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    uuid::Uuid::parse_str(stem).is_ok() && allowed.iter().any(|a| ext.eq_ignore_ascii_case(a))
}

/// Resolve `raw` as an edit source this app owns (see module docs): a
/// regular file (never a symlink) directly inside the images folder
/// (`<uuid>.<png|jpg>`) or the staged folder (`<uuid>.<png|jpg|webp>`), at most
/// [`MAX_EDIT_IMAGE_BYTES`]. Returns the canonical path. Magic bytes are
/// checked by [`load_source`].
pub fn resolve_edit_source(app_data: &Path, raw: &str) -> Result<PathBuf, EditErrorKind> {
    let raw = Path::new(raw.trim());
    let meta = std::fs::symlink_metadata(raw).map_err(|_| EditErrorKind::SourceNotAllowed)?;
    if !meta.file_type().is_file() {
        return Err(EditErrorKind::SourceNotAllowed);
    }
    let canonical = std::fs::canonicalize(raw).map_err(|_| EditErrorKind::SourceNotAllowed)?;
    let images = std::fs::canonicalize(images::images_dir(app_data))
        .map_err(|_| EditErrorKind::SourceNotAllowed)?;
    let staged = images.join(STAGED_DIR);
    let name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let parent = canonical.parent();
    let in_images = parent == Some(images.as_path());
    let in_staged = parent == Some(staged.as_path());
    let owned = (in_images && is_app_image_name(name, &images::SAVED_EXTENSIONS))
        || (in_staged && is_app_image_name(name, &["png", "jpg", "jpeg", "webp"]));
    if !owned {
        return Err(EditErrorKind::SourceNotAllowed);
    }
    if meta.len() > MAX_EDIT_IMAGE_BYTES {
        return Err(EditErrorKind::ImageTooLarge);
    }
    Ok(canonical)
}

/// One source ready to upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditSource {
    pub bytes: Vec<u8>,
    pub format: ImageFormat,
}

/// Read and check a source's bytes (size again, then magic bytes).
fn read_image_file(path: &Path) -> Result<EditSource, EditErrorKind> {
    let bytes = std::fs::read(path).map_err(|_| EditErrorKind::SourceNotAllowed)?;
    if bytes.len() as u64 > MAX_EDIT_IMAGE_BYTES {
        return Err(EditErrorKind::ImageTooLarge);
    }
    let format = sniff_format(&bytes).ok_or(EditErrorKind::UnsupportedImage)?;
    Ok(EditSource { bytes, format })
}

/// [`resolve_edit_source`] + read + magic-byte check.
pub fn load_source(app_data: &Path, raw: &str) -> Result<EditSource, EditErrorKind> {
    let path = resolve_edit_source(app_data, raw)?;
    read_image_file(&path)
}

/// Read only the leading bytes of a file (cheap magic check before the
/// edit task is spawned).
fn sniff_file(path: &Path) -> Result<ImageFormat, EditErrorKind> {
    use std::io::Read as _;
    let mut head = [0u8; 12];
    let mut file = std::fs::File::open(path).map_err(|_| EditErrorKind::SourceNotAllowed)?;
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(_) => return Err(EditErrorKind::SourceNotAllowed),
        }
    }
    sniff_format(&head[..filled]).ok_or(EditErrorKind::UnsupportedImage)
}

/// Everything the command validates before spawning the task: the
/// instruction, the source count against the edit model's cap (`max`, from
/// [`max_edit_images_for`]), and each source (ownership, size, magic).
/// Returns the trimmed instruction and the canonical source paths.
pub fn validate_edit_request(
    app_data: &Path,
    instruction: &str,
    source_paths: &[String],
    max: usize,
) -> Result<(String, Vec<PathBuf>), EditErrorKind> {
    let instruction = validate_instruction(instruction)?;
    validate_source_count(source_paths.len(), max)?;
    let mut paths = Vec::with_capacity(source_paths.len());
    for raw in source_paths {
        let path = resolve_edit_source(app_data, raw)?;
        sniff_file(&path)?;
        paths.push(path);
    }
    Ok((instruction, paths))
}

// ---------------------------------------------------------------------------
// Staging a picked local file (grants + deny-list)
// ---------------------------------------------------------------------------

/// A local file the user picked, copied into the staged folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StagedSource {
    /// The staged copy (`<app data>/images/staged/<uuid>.<ext>`).
    pub path: String,
    /// The picked file's own name, for the tray label.
    pub name: String,
}

/// Validate a picked file through the tools core and stage a copy:
/// it must resolve under one of `profile_id`'s grants, must not be inside
/// the app data folder nor on the sensitive deny-list (ALWAYS enforced,
/// whatever the grant), must be a regular file of at most
/// [`MAX_EDIT_IMAGE_BYTES`] and PNG/JPEG/WebP by magic bytes.
pub fn stage_picked_source(
    app_data: &Path,
    store: &grants::GrantsStore,
    profile_id: &str,
    home: Option<&Path>,
    picked: &Path,
) -> Result<StagedSource, EditErrorKind> {
    let raw = picked.to_str().ok_or(EditErrorKind::SourceNotAllowed)?;
    let (_, canonical) = grants::resolve_under_grant(store, profile_id, raw)
        .map_err(|_| EditErrorKind::SourceNotAllowed)?;
    if grants::is_protected(app_data, &canonical)
        || grants::is_sensitive_write_target(home, &canonical)
    {
        return Err(EditErrorKind::SourceNotAllowed);
    }
    let meta = std::fs::metadata(&canonical).map_err(|_| EditErrorKind::SourceNotAllowed)?;
    if !meta.is_file() {
        return Err(EditErrorKind::SourceNotAllowed);
    }
    if meta.len() > MAX_EDIT_IMAGE_BYTES {
        return Err(EditErrorKind::ImageTooLarge);
    }
    let source = read_image_file(&canonical)?;
    let dir = staged_dir(app_data);
    std::fs::create_dir_all(&dir).map_err(|_| EditErrorKind::Protocol)?;
    let staged = dir.join(format!(
        "{}.{}",
        uuid::Uuid::new_v4(),
        source.format.extension()
    ));
    std::fs::write(&staged, &source.bytes).map_err(|_| EditErrorKind::Protocol)?;
    let name = canonical
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(StagedSource {
        path: staged.display().to_string(),
        name,
    })
}

/// Delete staged picks older than `min_age` (startup, best effort). Only
/// regular files directly inside the staged folder; never follows
/// symlinks. Returns how many were removed.
pub fn sweep_staged_sources(
    app_data: &Path,
    min_age: std::time::Duration,
    now: std::time::SystemTime,
) -> usize {
    let Ok(entries) = std::fs::read_dir(staged_dir(app_data)) else {
        return 0;
    };
    let mut deleted = 0;
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let old_enough = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= min_age);
        if old_enough && std::fs::remove_file(entry.path()).is_ok() {
            deleted += 1;
        }
    }
    deleted
}

// ---------------------------------------------------------------------------
// Request (multipart) + reply
// ---------------------------------------------------------------------------

/// One multipart part of the edit request, in wire order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditPart {
    Text {
        name: &'static str,
        value: String,
    },
    File {
        name: &'static str,
        file_name: String,
        mime: &'static str,
        bytes: Vec<u8>,
    },
}

/// The edit request body, part by part: `prompt` (the instruction — the
/// OpenAI field name the platform reads), one `image[]` per source
/// (`image-<n>.<ext>` with the sniffed MIME type), then `n=1`.
pub fn edit_parts(instruction: &str, sources: Vec<EditSource>) -> Vec<EditPart> {
    let mut parts = vec![EditPart::Text {
        name: "prompt",
        value: instruction.to_string(),
    }];
    for (index, source) in sources.into_iter().enumerate() {
        parts.push(EditPart::File {
            name: "image[]",
            file_name: format!("image-{}.{}", index + 1, source.format.extension()),
            mime: source.format.mime(),
            bytes: source.bytes,
        });
    }
    parts.push(EditPart::Text {
        name: "n",
        value: "1".to_string(),
    });
    parts
}

/// Turn [`edit_parts`] into a reqwest multipart form.
fn edit_form(parts: Vec<EditPart>) -> Result<reqwest::multipart::Form, EditErrorKind> {
    let mut form = reqwest::multipart::Form::new();
    for part in parts {
        form = match part {
            EditPart::Text { name, value } => form.text(name, value),
            EditPart::File {
                name,
                file_name,
                mime,
                bytes,
            } => form.part(
                name,
                reqwest::multipart::Part::bytes(bytes)
                    .file_name(file_name)
                    .mime_str(mime)
                    .map_err(|_| EditErrorKind::Protocol)?,
            ),
        };
    }
    Ok(form)
}

/// Parse the edit reply: `b64_json` only (the platform contract). A `url`
/// reply is never fetched (`protocol`); an undecodable or non-image payload
/// is `decode`.
pub fn parse_edit_response(body: &str) -> Result<Vec<u8>, EditErrorKind> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|_| EditErrorKind::Protocol)?;
    let b64 = value
        .get("data")
        .and_then(|data| data.as_array())
        .and_then(|data| data.first())
        .and_then(|item| item.get("b64_json"))
        .and_then(|b64| b64.as_str())
        .ok_or(EditErrorKind::Protocol)?;
    let bytes = BASE64_STANDARD
        .decode(b64)
        .map_err(|_| EditErrorKind::Decode)?;
    if sniff_format(&bytes).is_none() {
        return Err(EditErrorKind::Decode);
    }
    Ok(bytes)
}

/// POST the edit to `profile_id`'s edit route on `base` (see
/// [`images::edits_url`]) with the session `token` and return the decoded
/// result image. The reply body is read with a [`MAX_EDIT_RESPONSE_BYTES`]
/// cap.
pub async fn edit_at(
    base: &str,
    profile_id: &str,
    token: &str,
    instruction: &str,
    sources: Vec<EditSource>,
) -> Result<Vec<u8>, EditErrorKind> {
    use futures_util::StreamExt as _;
    let url = images::edits_url(base, profile_id).ok_or(EditErrorKind::Protocol)?;
    let form = edit_form(edit_parts(instruction, sources))?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(chat::CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|_| EditErrorKind::Protocol)?;
    // No overall timeout: an edit takes about a minute, like a generation.
    let response = client
        .post(url)
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|_| EditErrorKind::Network)?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(classify_edit_status(status));
    }
    if response
        .content_length()
        .is_some_and(|len| len > MAX_EDIT_RESPONSE_BYTES)
    {
        return Err(EditErrorKind::Decode);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| EditErrorKind::Network)?;
        if body.len() as u64 + chunk.len() as u64 > MAX_EDIT_RESPONSE_BYTES {
            return Err(EditErrorKind::Decode);
        }
        body.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(body).map_err(|_| EditErrorKind::Protocol)?;
    parse_edit_response(&body)
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/// Save the edit result like a generated image (`.jpg` for JPEG bytes) and
/// persist the CHILD row with the `model` that ran the edit (deleting the
/// file again if the row cannot be written). Returns the saved path.
pub fn persist_edit_result(
    app_data: &Path,
    conversation_id: i64,
    parent_message_id: Option<i64>,
    instruction: &str,
    model: &str,
    bytes: &[u8],
) -> Result<PathBuf, EditErrorKind> {
    let path =
        images::save_image(&images::images_dir(app_data), bytes).map_err(EditErrorKind::from)?;
    let media_path = path.to_string_lossy().to_string();
    let persisted = chat_store::open_db(app_data)
        .map_err(|_| EditErrorKind::Protocol)
        .and_then(|conn| {
            chat_store::insert_edited_image_message(
                &conn,
                conversation_id,
                instruction,
                model,
                &media_path,
                parent_message_id,
            )
            .and_then(|_| chat_store::touch_conversation(&conn, conversation_id))
            .map_err(|_| EditErrorKind::Protocol)
        });
    if let Err(kind) = persisted {
        let _ = std::fs::remove_file(&path);
        return Err(kind);
    }
    Ok(path)
}

// ---------------------------------------------------------------------------
// Events + commands
// ---------------------------------------------------------------------------

/// `images://error` for an edit (same event as generation, wider kinds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct EditErrorPayload {
    pub conversation_id: i64,
    pub kind: EditErrorKind,
}

/// `images://progress`: the edit moved to `stage` (`uploading`, `saving`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct EditProgressPayload {
    pub conversation_id: i64,
    pub stage: &'static str,
}

/// Edit images in a conversation. Validates everything locally first (the
/// renderer gets the kind string as the command error), then runs the edit
/// as a managed task in the image registry (one image job per
/// conversation; `image_cancel` stops it). Progress arrives as
/// `images://started|progress|done|error|stopped` events.
#[tauri::command]
pub fn edit_images(
    app: AppHandle,
    window: Window,
    conversation_id: i64,
    parent_message_id: Option<i64>,
    instruction: String,
    source_paths: Vec<String>,
) -> Result<(), String> {
    let app_data = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let conn = chat_store::open_db(&app_data)?;
    let conversation = chat_store::conversation_get(&conn, conversation_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("unknown conversation id: {conversation_id}"))?;
    // The cap follows the model the conversation's tenant edits with (FLUX
    // takes one image): refused here, before the server would 400.
    let model = edit_model_for(&conversation.profile_id)
        .ok_or_else(|| EditErrorKind::Protocol.as_str().to_string())?;
    let (instruction, sources) = validate_edit_request(
        &app_data,
        &instruction,
        &source_paths,
        max_edit_images_for(model),
    )
    .map_err(|kind| kind.as_str().to_string())?;
    if let Some(parent) = parent_message_id
        && !chat_store::message_in_conversation(&conn, conversation_id, parent)
            .map_err(|err| err.to_string())?
    {
        return Err(EditErrorKind::InvalidParent.as_str().to_string());
    }

    let state = app.state::<images::ImagesState>();
    let generation = images::reserve_image(&state, conversation_id)?;
    let handle = tauri::async_runtime::spawn(run_image_edit(
        app.clone(),
        window,
        EditJob {
            conversation_id,
            profile_id: conversation.profile_id,
            model,
            parent_message_id,
            instruction,
            sources,
            generation,
        },
    ));
    images::attach_image(&state, conversation_id, generation, handle)?;
    Ok(())
}

struct EditJob {
    conversation_id: i64,
    profile_id: String,
    model: &'static str,
    parent_message_id: Option<i64>,
    instruction: String,
    sources: Vec<PathBuf>,
    generation: u64,
}

async fn run_image_edit(app: AppHandle, window: Window, job: EditJob) {
    let conversation_id = job.conversation_id;
    let state = app.state::<images::ImagesState>();
    let _ = window.emit(
        "images://started",
        images::ImagesStartedPayload { conversation_id },
    );
    let emit_error = |kind: EditErrorKind| {
        images::release_image(&state, conversation_id, job.generation);
        let _ = window.emit(
            "images://error",
            EditErrorPayload {
                conversation_id,
                kind,
            },
        );
    };
    let Ok(app_data) = app.path().app_data_dir() else {
        return emit_error(EditErrorKind::Protocol);
    };

    // Re-verify and read every source right before the upload.
    let mut sources = Vec::with_capacity(job.sources.len());
    for path in &job.sources {
        match load_source(&app_data, &path.to_string_lossy()) {
            Ok(source) => sources.push(source),
            Err(kind) => return emit_error(kind),
        }
    }
    let Some(token) = chat::read_session_token(&job.profile_id) else {
        return emit_error(EditErrorKind::MissingKey);
    };
    let Some(base) = images::images_base(&job.profile_id) else {
        return emit_error(EditErrorKind::Protocol);
    };
    let _ = window.emit(
        "images://progress",
        EditProgressPayload {
            conversation_id,
            stage: "uploading",
        },
    );
    let bytes = match edit_at(&base, &job.profile_id, &token, &job.instruction, sources).await {
        Ok(bytes) => bytes,
        Err(kind) => return emit_error(kind),
    };
    let _ = window.emit(
        "images://progress",
        EditProgressPayload {
            conversation_id,
            stage: "saving",
        },
    );
    let path = match persist_edit_result(
        &app_data,
        conversation_id,
        job.parent_message_id,
        &job.instruction,
        job.model,
        &bytes,
    ) {
        Ok(path) => path,
        Err(kind) => return emit_error(kind),
    };
    // Staged picks are NOT deleted here: the Image Studio keeps reusing them
    // (history nodes, references) for the whole session. The startup sweep
    // ([`sweep_staged_sources`], 24 h) is what removes them.
    images::release_image(&state, conversation_id, job.generation);
    let _ = window.emit(
        "images://done",
        images::ImagesDonePayload {
            conversation_id,
            media_path: path.to_string_lossy().to_string(),
        },
    );
}

/// "Add image" in the edit tray: the NATIVE file dialog is opened by the
/// core (the picked path never comes from the renderer), the file is
/// validated through the tools-core grants and the deny-list, and a copy
/// is staged for the edit (see [`stage_picked_source`]). Returns `None`
/// when the user cancelled; a refusal is the kind string.
///
/// `async` on purpose (P0-3): the dialog's blocking call must never run on
/// the main thread.
#[tauri::command]
pub async fn image_edit_pick(
    app: AppHandle,
    profile_id: String,
) -> Result<Option<StagedSource>, String> {
    use tauri_plugin_dialog::DialogExt;
    if !crate::profile::is_known_profile_id(&profile_id) {
        return Err(EditErrorKind::Protocol.as_str().to_string());
    }
    let app_data = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| EditErrorKind::Protocol.as_str().to_string())?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| EditErrorKind::SourceNotAllowed.as_str().to_string())?;
    let store = grants::load_or_seed(&app_data)
        .map_err(|_| EditErrorKind::Protocol.as_str().to_string())?;
    let home = std::env::home_dir();
    stage_picked_source(&app_data, &store, &profile_id, home.as_deref(), &path)
        .map(Some)
        .map_err(|kind| kind.as_str().to_string())
}

/// Stage a file the renderer names (Image Studio "Edit image" on a preview
/// of a user file). The path must be absolute; everything else is
/// [`stage_picked_source`]: it must resolve under one of `profile_id`'s
/// grants, the deny-list and the app data folder are always refused, and
/// size and magic bytes are checked. A renderer path therefore reaches
/// exactly what `preview_read_file` can already read, only as a staged copy.
pub fn stage_requested_source(
    app_data: &Path,
    store: &grants::GrantsStore,
    profile_id: &str,
    home: Option<&Path>,
    raw: &str,
) -> Result<StagedSource, EditErrorKind> {
    let raw = raw.trim();
    if raw.is_empty() || !Path::new(raw).is_absolute() {
        return Err(EditErrorKind::SourceNotAllowed);
    }
    stage_picked_source(app_data, store, profile_id, home, Path::new(raw))
}

/// "Edit image" on an image shown in the preview pane: the file is already
/// on screen through its grant, so no dialog is needed; it is validated and
/// staged like a pick (see [`stage_requested_source`]). A refusal is the
/// kind string.
#[tauri::command]
pub async fn image_edit_stage(
    app: AppHandle,
    profile_id: String,
    path: String,
) -> Result<StagedSource, String> {
    if !crate::profile::is_known_profile_id(&profile_id) {
        return Err(EditErrorKind::Protocol.as_str().to_string());
    }
    let app_data = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let store = grants::load_or_seed(&app_data)
        .map_err(|_| EditErrorKind::Protocol.as_str().to_string())?;
    let home = std::env::home_dir();
    stage_requested_source(&app_data, &store, &profile_id, home.as_deref(), &path)
        .map_err(|kind| kind.as_str().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The community's edit model (3 images).
    const QWEN: &str = "qwen-image-3.0-pro";

    /// A tiny valid 1x1 PNG (same fixture as images.rs and the mock).
    const TINY_PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn png() -> Vec<u8> {
        BASE64_STANDARD.decode(TINY_PNG_B64).expect("fixture")
    }
    fn jpeg() -> Vec<u8> {
        vec![
            0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, b'J', b'F', b'I', b'F', 0, 1,
        ]
    }
    fn webp() -> Vec<u8> {
        let mut bytes = b"RIFF\x24\0\0\0WEBPVP8 ".to_vec();
        bytes.extend_from_slice(&[0; 16]);
        bytes
    }

    /// An app data dir with the images folder; returns (tempdir, app_data).
    fn app_data() -> (TempDir, PathBuf) {
        let dir = TempDir::new().expect("temp dir");
        let app = dir.path().join("app");
        std::fs::create_dir_all(images::images_dir(&app)).expect("images dir");
        (dir, app)
    }

    /// [`validate_edit_request`] with the qwen cap (3 images, community).
    fn validate_qwen_request(
        app: &Path,
        instruction: &str,
        paths: &[String],
    ) -> Result<(String, Vec<PathBuf>), EditErrorKind> {
        validate_edit_request(app, instruction, paths, MAX_EDIT_IMAGES)
    }

    /// A chat image `<app>/images/<uuid>.<png|jpg>` with `bytes`.
    fn chat_image(app: &Path, bytes: &[u8]) -> String {
        images::save_image(&images::images_dir(app), bytes)
            .expect("save")
            .display()
            .to_string()
    }

    // ---- URL + body builders ---------------------------------------------------

    #[test]
    fn edits_url_follows_the_profile_with_the_v1_rule() {
        let url = |base: &str, profile: &str| images::edits_url(base, profile).expect("known");
        assert_eq!(
            url("https://cloud-api.nan.builders", "nan"),
            "https://cloud-api.nan.builders/v1/images/edits"
        );
        assert_eq!(
            url("https://cloud-api.nan.builders/", "nan"),
            "https://cloud-api.nan.builders/v1/images/edits"
        );
        assert_eq!(
            url("http://127.0.0.1:14325/v1", "nan"),
            "http://127.0.0.1:14325/v1/images/edits"
        );
        assert_eq!(
            url("https://cloud-api.helmcode.com", "helmcode"),
            "https://cloud-api.helmcode.com/v1/desktop/images/edits"
        );
        assert_eq!(
            url("http://127.0.0.1:14325/v1/", "helmcode"),
            "http://127.0.0.1:14325/v1/desktop/images/edits"
        );
        for base in [
            "https://cloud-api.nan.builders",
            "https://api.nan.builders/v1",
            "http://127.0.0.1:9/v1/",
        ] {
            for (profile, suffix) in [
                ("nan", "/v1/images/edits"),
                ("helmcode", "/v1/desktop/images/edits"),
            ] {
                let full = url(base, profile);
                assert!(full.ends_with(suffix), "{full}");
                assert_eq!(full.matches("/v1/").count(), 1, "{full}");
            }
        }
        assert_eq!(images::edits_url("https://x", "unknown"), None);
    }

    #[test]
    fn production_edits_go_to_each_tenants_platform_api() {
        if std::env::var("NAN_DESKTOP_MOCK_IMAGE_EDITS").is_err()
            && std::env::var("NAN_DESKTOP_MOCK_IMAGES").is_err()
            && std::env::var("NAN_DESKTOP_MOCK_PLATFORM").is_err()
        {
            for (profile, expected) in [
                ("nan", "https://cloud-api.nan.builders/v1/images/edits"),
                (
                    "helmcode",
                    "https://cloud-api.helmcode.com/v1/desktop/images/edits",
                ),
            ] {
                let base = images::images_base(profile).expect("base");
                let url = images::edits_url(&base, profile);
                assert_eq!(url.as_deref(), Some(expected));
            }
        }
    }

    #[test]
    fn the_edit_cap_follows_the_tenants_edit_model() {
        assert_eq!(edit_model_for("nan"), Some("qwen-image-3.0-pro"));
        assert_eq!(edit_model_for("helmcode"), Some("flux-3-image-klein"));
        assert_eq!(edit_model_for("unknown"), None);
        assert_eq!(max_edit_images_for("qwen-image-3.0-pro"), 3);
        // FLUX edits the base only: any reference is a 400 server-side.
        assert_eq!(max_edit_images_for("flux-3-image-klein"), 1);
        // An unknown model gets the strictest cap.
        assert_eq!(max_edit_images_for("something-new"), 1);
    }

    #[test]
    fn a_flux_edit_with_a_reference_is_refused_before_any_network() {
        let (_tmp, app) = app_data();
        let a = chat_image(&app, &png());
        let flux = max_edit_images_for("flux-3-image-klein");
        assert!(validate_edit_request(&app, "snow", std::slice::from_ref(&a), flux).is_ok());
        assert_eq!(
            validate_edit_request(&app, "snow", &[a.clone(), a.clone()], flux),
            Err(EditErrorKind::TooManyImages)
        );
        let qwen = max_edit_images_for("qwen-image-3.0-pro");
        assert!(validate_edit_request(&app, "snow", &[a.clone(), a.clone(), a], qwen).is_ok());
    }

    #[test]
    fn edit_parts_are_prompt_images_then_n_1() {
        let parts = edit_parts(
            "make it snowy",
            vec![
                EditSource {
                    bytes: png(),
                    format: ImageFormat::Png,
                },
                EditSource {
                    bytes: jpeg(),
                    format: ImageFormat::Jpeg,
                },
            ],
        );
        assert_eq!(parts.len(), 4);
        assert_eq!(
            parts[0],
            EditPart::Text {
                name: "prompt",
                value: "make it snowy".into()
            }
        );
        assert_eq!(
            parts[1],
            EditPart::File {
                name: "image[]",
                file_name: "image-1.png".into(),
                mime: "image/png",
                bytes: png()
            }
        );
        assert_eq!(
            parts[2],
            EditPart::File {
                name: "image[]",
                file_name: "image-2.jpg".into(),
                mime: "image/jpeg",
                bytes: jpeg()
            }
        );
        assert_eq!(
            parts[3],
            EditPart::Text {
                name: "n",
                value: "1".into()
            }
        );
        // The model is never sent: the platform picks it.
        assert!(
            !parts
                .iter()
                .any(|part| matches!(part, EditPart::Text { name: "model", .. }))
        );
    }

    #[test]
    fn status_mapping_follows_the_platform_contract() {
        assert_eq!(classify_edit_status(400), EditErrorKind::InvalidRequest);
        assert_eq!(classify_edit_status(401), EditErrorKind::Unauthorized);
        assert_eq!(classify_edit_status(403), EditErrorKind::TierRestricted);
        assert_eq!(classify_edit_status(404), EditErrorKind::NotAvailable);
        assert_eq!(classify_edit_status(429), EditErrorKind::RateLimited);
        for status in [500, 502, 503, 418] {
            assert_eq!(classify_edit_status(status), EditErrorKind::Server);
        }
    }

    #[test]
    fn error_kinds_serialize_as_their_wire_strings() {
        for kind in [
            EditErrorKind::InvalidInstruction,
            EditErrorKind::NoImages,
            EditErrorKind::TooManyImages,
            EditErrorKind::ImageTooLarge,
            EditErrorKind::UnsupportedImage,
            EditErrorKind::SourceNotAllowed,
            EditErrorKind::InvalidParent,
            EditErrorKind::MissingKey,
            EditErrorKind::Unauthorized,
            EditErrorKind::NotAvailable,
            EditErrorKind::TierRestricted,
            EditErrorKind::InvalidRequest,
            EditErrorKind::RateLimited,
            EditErrorKind::Server,
            EditErrorKind::Network,
            EditErrorKind::Protocol,
            EditErrorKind::Decode,
        ] {
            assert_eq!(
                serde_json::to_value(kind).expect("json"),
                serde_json::json!(kind.as_str())
            );
        }
    }

    // ---- reply parsing ------------------------------------------------------------

    #[test]
    fn parses_the_b64_json_reply() {
        let body = format!(r#"{{"created":1,"data":[{{"b64_json":"{TINY_PNG_B64}"}}]}}"#);
        assert_eq!(parse_edit_response(&body), Ok(png()));
    }

    #[test]
    fn url_replies_are_never_fetched_and_garbage_is_classified() {
        assert_eq!(
            parse_edit_response(r#"{"data":[{"url":"https://x.r2.cloudflarestorage.com/a.png"}]}"#),
            Err(EditErrorKind::Protocol)
        );
        assert_eq!(
            parse_edit_response(r#"{"data":[]}"#),
            Err(EditErrorKind::Protocol)
        );
        assert_eq!(parse_edit_response("nope"), Err(EditErrorKind::Protocol));
        assert_eq!(
            parse_edit_response(r#"{"data":[{"b64_json":"!!"}]}"#),
            Err(EditErrorKind::Decode)
        );
        // Valid base64 that is not an image.
        assert_eq!(
            parse_edit_response(r#"{"data":[{"b64_json":"aGVsbG8gcG5n"}]}"#),
            Err(EditErrorKind::Decode)
        );
    }

    // ---- caps -------------------------------------------------------------------------

    #[test]
    fn instruction_is_trimmed_and_capped_at_2000_chars() {
        assert_eq!(validate_instruction("  brighter  "), Ok("brighter".into()));
        assert_eq!(
            validate_instruction(""),
            Err(EditErrorKind::InvalidInstruction)
        );
        assert_eq!(
            validate_instruction(" \n\t "),
            Err(EditErrorKind::InvalidInstruction)
        );
        let exactly = "a".repeat(MAX_INSTRUCTION_CHARS);
        assert_eq!(
            validate_instruction(&exactly).as_deref(),
            Ok(exactly.as_str())
        );
        let over = "a".repeat(MAX_INSTRUCTION_CHARS + 1);
        assert_eq!(
            validate_instruction(&over),
            Err(EditErrorKind::InvalidInstruction)
        );
        // Characters, not bytes: 2000 multibyte chars are fine.
        let accents = "é".repeat(MAX_INSTRUCTION_CHARS);
        assert!(validate_instruction(&accents).is_ok());
    }

    #[test]
    fn one_to_max_images_and_one_more_is_rejected() {
        assert_eq!(validate_source_count(0, 3), Err(EditErrorKind::NoImages));
        for n in 1..=3 {
            assert_eq!(validate_source_count(n, 3), Ok(()));
        }
        assert_eq!(
            validate_source_count(4, 3),
            Err(EditErrorKind::TooManyImages)
        );
        // FLUX: the base only.
        assert_eq!(validate_source_count(1, 1), Ok(()));
        assert_eq!(
            validate_source_count(2, 1),
            Err(EditErrorKind::TooManyImages)
        );
        assert_eq!(validate_source_count(0, 1), Err(EditErrorKind::NoImages));
    }

    #[test]
    fn sniffs_png_jpeg_webp_and_rejects_everything_else() {
        assert_eq!(sniff_format(&png()), Some(ImageFormat::Png));
        assert_eq!(sniff_format(&jpeg()), Some(ImageFormat::Jpeg));
        assert_eq!(sniff_format(&webp()), Some(ImageFormat::Webp));
        assert_eq!(sniff_format(b"GIF89a......"), None);
        assert_eq!(sniff_format(b"%PDF-1.7"), None);
        assert_eq!(sniff_format(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(sniff_format(b""), None);
    }

    #[test]
    fn validate_edit_request_enforces_every_cap() {
        let (_tmp, app) = app_data();
        let a = chat_image(&app, &png());
        let ok = validate_qwen_request(&app, "  snow ", std::slice::from_ref(&a)).expect("valid");
        assert_eq!(ok.0, "snow");
        assert_eq!(ok.1.len(), 1);

        let four = vec![a.clone(), a.clone(), a.clone(), a.clone()];
        assert_eq!(
            validate_qwen_request(&app, "snow", &four),
            Err(EditErrorKind::TooManyImages)
        );
        assert_eq!(
            validate_qwen_request(&app, &"x".repeat(2001), std::slice::from_ref(&a)),
            Err(EditErrorKind::InvalidInstruction)
        );
        assert_eq!(
            validate_qwen_request(&app, "snow", &[]),
            Err(EditErrorKind::NoImages)
        );
    }

    #[test]
    fn oversized_and_non_image_sources_are_rejected() {
        let (_tmp, app) = app_data();
        // Magic bytes win over the .png name.
        let fake = chat_image(&app, b"%PDF-1.7 not an image");
        assert_eq!(
            validate_qwen_request(&app, "x", &[fake]),
            Err(EditErrorKind::UnsupportedImage)
        );
        // One byte over 20 MiB (sparse file: no real disk use).
        let big = images::images_dir(&app).join(format!("{}.png", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&big).expect("create");
        file.set_len(MAX_EDIT_IMAGE_BYTES + 1).expect("set_len");
        assert_eq!(
            validate_qwen_request(&app, "x", &[big.display().to_string()]),
            Err(EditErrorKind::ImageTooLarge)
        );
    }

    #[test]
    fn only_this_apps_images_are_accepted_as_sources() {
        let (tmp, app) = app_data();
        // A file outside the images folder.
        let outside = tmp.path().join("photo.png");
        std::fs::write(&outside, png()).expect("write");
        assert_eq!(
            resolve_edit_source(&app, &outside.display().to_string()),
            Err(EditErrorKind::SourceNotAllowed)
        );
        // A non-uuid name inside the images folder.
        let named = images::images_dir(&app).join("notes.png");
        std::fs::write(&named, png()).expect("write");
        assert_eq!(
            resolve_edit_source(&app, &named.display().to_string()),
            Err(EditErrorKind::SourceNotAllowed)
        );
        // A missing file.
        assert_eq!(
            resolve_edit_source(&app, "/definitely/not/here.png"),
            Err(EditErrorKind::SourceNotAllowed)
        );
        // A symlink planted in the images folder pointing outside.
        #[cfg(unix)]
        {
            let link = images::images_dir(&app).join(format!("{}.png", uuid::Uuid::new_v4()));
            std::os::unix::fs::symlink(&outside, &link).expect("symlink");
            assert_eq!(
                resolve_edit_source(&app, &link.display().to_string()),
                Err(EditErrorKind::SourceNotAllowed)
            );
        }
        // A staged JPEG is fine.
        std::fs::create_dir_all(staged_dir(&app)).expect("staged");
        let staged = staged_dir(&app).join(format!("{}.jpg", uuid::Uuid::new_v4()));
        std::fs::write(&staged, jpeg()).expect("write");
        let loaded = load_source(&app, &staged.display().to_string()).expect("staged ok");
        assert_eq!(loaded.format, ImageFormat::Jpeg);
    }

    // ---- staging picked files (grants + deny-list) -----------------------------------

    fn store_with_grant(profile: &str, root: &Path) -> grants::GrantsStore {
        let mut store = grants::default_store();
        store
            .add_grant(
                "g1".into(),
                profile,
                std::fs::canonicalize(root).expect("canonical"),
                "2026-11-04T00:00:00Z".into(),
            )
            .expect("grant");
        store
    }

    #[test]
    fn a_pick_under_a_grant_is_staged_with_its_sniffed_extension() {
        let (tmp, app) = app_data();
        let granted = tmp.path().join("Photos");
        std::fs::create_dir_all(&granted).expect("dir");
        let picked = granted.join("cat.jpeg");
        std::fs::write(&picked, jpeg()).expect("write");
        let store = store_with_grant("nan", &granted);

        let staged = stage_picked_source(&app, &store, "nan", None, &picked).expect("staged");
        assert_eq!(staged.name, "cat.jpeg");
        let path = PathBuf::from(&staged.path);
        assert!(path.starts_with(staged_dir(&app)));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("jpg"));
        assert_eq!(std::fs::read(&path).expect("read"), jpeg());
        // And the staged copy is a valid edit source.
        assert!(validate_qwen_request(&app, "x", &[staged.path]).is_ok());
    }

    #[test]
    fn a_pick_outside_every_grant_or_for_another_profile_is_refused() {
        let (tmp, app) = app_data();
        let granted = tmp.path().join("Photos");
        let other = tmp.path().join("Elsewhere");
        std::fs::create_dir_all(&granted).expect("dir");
        std::fs::create_dir_all(&other).expect("dir");
        let picked = other.join("a.png");
        std::fs::write(&picked, png()).expect("write");
        let store = store_with_grant("nan", &granted);
        assert_eq!(
            stage_picked_source(&app, &store, "nan", None, &picked),
            Err(EditErrorKind::SourceNotAllowed)
        );
        let inside = granted.join("b.png");
        std::fs::write(&inside, png()).expect("write");
        assert_eq!(
            stage_picked_source(&app, &store, "helmcode", None, &inside),
            Err(EditErrorKind::SourceNotAllowed),
            "grants are per profile"
        );
        assert!(!staged_dir(&app).exists(), "nothing staged");
    }

    #[test]
    fn the_sensitive_deny_list_wins_over_any_grant() {
        let (tmp, app) = app_data();
        let home = tmp.path().join("home");
        let ssh = home.join(".ssh");
        std::fs::create_dir_all(&ssh).expect("dir");
        let picked = ssh.join("id.png");
        std::fs::write(&picked, png()).expect("write");
        // Even a grant on $HOME itself (computer-wide shape) cannot unlock it.
        let store = store_with_grant("nan", &home);
        assert_eq!(
            stage_picked_source(&app, &store, "nan", Some(&home), &picked),
            Err(EditErrorKind::SourceNotAllowed)
        );
        // Key files are refused by extension anywhere (magic bytes aside).
        let key = home.join("server.pem");
        std::fs::write(&key, png()).expect("write");
        assert_eq!(
            stage_picked_source(&app, &store, "nan", Some(&home), &key),
            Err(EditErrorKind::SourceNotAllowed)
        );
    }

    #[test]
    fn picks_inside_the_app_data_folder_are_refused() {
        let (tmp, app) = app_data();
        let image = chat_image(&app, &png());
        let store = store_with_grant("nan", tmp.path());
        assert_eq!(
            stage_picked_source(&app, &store, "nan", None, Path::new(&image)),
            Err(EditErrorKind::SourceNotAllowed)
        );
    }

    #[test]
    fn picks_that_are_too_large_or_not_images_are_refused() {
        let (tmp, app) = app_data();
        let granted = tmp.path().join("Docs");
        std::fs::create_dir_all(&granted).expect("dir");
        let store = store_with_grant("nan", &granted);
        let pdf = granted.join("scan.png");
        std::fs::write(&pdf, b"%PDF-1.7").expect("write");
        assert_eq!(
            stage_picked_source(&app, &store, "nan", None, &pdf),
            Err(EditErrorKind::UnsupportedImage)
        );
        let big = granted.join("huge.png");
        std::fs::File::create(&big)
            .expect("create")
            .set_len(MAX_EDIT_IMAGE_BYTES + 1)
            .expect("set_len");
        assert_eq!(
            stage_picked_source(&app, &store, "nan", None, &big),
            Err(EditErrorKind::ImageTooLarge)
        );
    }

    #[test]
    fn a_requested_path_is_staged_like_a_pick_and_only_when_absolute() {
        let (tmp, app) = app_data();
        let granted = tmp.path().join("Photos");
        std::fs::create_dir_all(&granted).expect("dir");
        let shown = granted.join("dog.png");
        std::fs::write(&shown, png()).expect("write");
        let store = store_with_grant("nan", &granted);

        let shown_path = shown.display().to_string();
        let staged =
            stage_requested_source(&app, &store, "nan", None, &shown_path).expect("staged");
        assert_eq!(staged.name, "dog.png");
        assert!(PathBuf::from(&staged.path).starts_with(staged_dir(&app)));
        assert!(validate_qwen_request(&app, "x", &[staged.path]).is_ok());

        for raw in ["", "   ", "dog.png", "Photos/dog.png"] {
            assert_eq!(
                stage_requested_source(&app, &store, "nan", None, raw),
                Err(EditErrorKind::SourceNotAllowed),
                "{raw:?}"
            );
        }
    }

    #[test]
    fn a_requested_path_gets_the_same_refusals_as_a_pick() {
        let (tmp, app) = app_data();
        let granted = tmp.path().join("Photos");
        let other = tmp.path().join("Elsewhere");
        std::fs::create_dir_all(&granted).expect("dir");
        std::fs::create_dir_all(&other).expect("dir");
        let outside = other.join("a.png");
        std::fs::write(&outside, png()).expect("write");
        let store = store_with_grant("nan", &granted);
        assert_eq!(
            stage_requested_source(&app, &store, "nan", None, &outside.display().to_string()),
            Err(EditErrorKind::SourceNotAllowed)
        );
        // Climbing out of the grant is refused too.
        let climb = format!("{}/../Elsewhere/a.png", granted.display());
        assert_eq!(
            stage_requested_source(&app, &store, "nan", None, &climb),
            Err(EditErrorKind::SourceNotAllowed)
        );
        // App data (the chat's own images) never goes through this path.
        let image = chat_image(&app, &png());
        let wide = store_with_grant("nan", tmp.path());
        assert_eq!(
            stage_requested_source(&app, &wide, "nan", None, &image),
            Err(EditErrorKind::SourceNotAllowed)
        );
        assert!(!staged_dir(&app).exists(), "nothing staged");
    }

    #[test]
    fn the_staged_sweep_removes_only_old_files() {
        let (_tmp, app) = app_data();
        std::fs::create_dir_all(staged_dir(&app)).expect("staged");
        let file = staged_dir(&app).join(format!("{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&file, png()).expect("write");
        let now = std::time::SystemTime::now();
        let day = std::time::Duration::from_secs(24 * 60 * 60);
        assert_eq!(sweep_staged_sources(&app, day, now), 0, "fresh file kept");
        assert!(file.exists());
        assert_eq!(sweep_staged_sources(&app, day, now + day * 2), 1);
        assert!(!file.exists());
        // No staged folder at all: nothing to do.
        let (_tmp2, empty) = app_data();
        assert_eq!(sweep_staged_sources(&empty, day, now), 0);
    }

    #[test]
    fn a_staged_source_survives_a_successful_edit_and_stays_reusable() {
        let (tmp, app) = app_data();
        let granted = tmp.path().join("Photos");
        std::fs::create_dir_all(&granted).expect("dir");
        let picked = granted.join("cat.png");
        std::fs::write(&picked, png()).expect("write");
        let store = store_with_grant("nan", &granted);
        let staged = stage_picked_source(&app, &store, "nan", None, &picked).expect("staged");
        let conn = chat_store::open_db(&app).expect("db");
        let conv = chat_store::insert_conversation(&conn, "nan", "t").expect("conv");

        // First edit succeeds and is persisted…
        assert!(
            validate_qwen_request(&app, "add a hat", std::slice::from_ref(&staged.path)).is_ok()
        );
        persist_edit_result(&app, conv, None, "add a hat", QWEN, &png()).expect("persisted");
        // …and the staged copy is still there for the next one (Studio
        // session); only the 24 h startup sweep removes it.
        assert!(PathBuf::from(&staged.path).exists(), "staged copy kept");
        assert!(
            validate_qwen_request(&app, "add a scarf", std::slice::from_ref(&staged.path)).is_ok()
        );
        let now = std::time::SystemTime::now();
        let day = std::time::Duration::from_secs(24 * 60 * 60);
        assert_eq!(sweep_staged_sources(&app, day, now), 0);
        assert_eq!(sweep_staged_sources(&app, day, now + day * 2), 1);
        assert!(!PathBuf::from(&staged.path).exists());
    }

    // ---- child-message linkage ----------------------------------------------------------

    #[test]
    fn the_result_is_saved_and_persisted_as_a_child_of_its_parent() {
        let (_tmp, app) = app_data();
        let conn = chat_store::open_db(&app).expect("db");
        let conv = chat_store::insert_conversation(&conn, "nan", "t").expect("conv");
        let parent_path = chat_image(&app, &png());
        let parent =
            chat_store::insert_image_message(&conn, conv, "a fox", "qwen-image-2.1", &parent_path)
                .expect("parent");

        let saved = persist_edit_result(&app, conv, Some(parent), "make it snowy", QWEN, &png())
            .expect("persisted");
        assert!(saved.starts_with(images::images_dir(&app)));
        assert_eq!(std::fs::read(&saved).expect("read"), png());
        assert_eq!(saved.extension().and_then(|e| e.to_str()), Some("png"));

        let rows = chat_store::list_messages(&conn, conv).expect("list");
        let child = rows.last().expect("child row");
        assert_eq!(child.parent_message_id, Some(parent));
        assert_eq!(child.content, "make it snowy");
        assert_eq!(child.model.as_deref(), Some(QWEN));
        let saved_text = saved.to_string_lossy().to_string();
        assert_eq!(child.media_path.as_deref(), Some(saved_text.as_str()));
        // The result is itself a valid source for the next edit.
        assert!(validate_qwen_request(&app, "more", &[saved.display().to_string()]).is_ok());
    }

    #[test]
    fn a_flux_jpeg_result_is_saved_as_jpg_and_stays_editable() {
        let (_tmp, app) = app_data();
        let conn = chat_store::open_db(&app).expect("db");
        let conv = chat_store::insert_conversation(&conn, "helmcode", "t").expect("conv");
        let flux = edit_model_for("helmcode").expect("model");
        let saved = persist_edit_result(&app, conv, None, "snow", flux, &jpeg()).expect("saved");
        assert_eq!(saved.extension().and_then(|e| e.to_str()), Some("jpg"));
        assert_eq!(std::fs::read(&saved).expect("read"), jpeg());
        let rows = chat_store::list_messages(&conn, conv).expect("list");
        assert_eq!(rows.last().and_then(|r| r.model.as_deref()), Some(flux));
        // A `.jpg` chat image is a valid source (the next Studio edit).
        let source = load_source(&app, &saved.display().to_string()).expect("source");
        assert_eq!(source.format, ImageFormat::Jpeg);
    }

    #[test]
    fn a_failed_persist_leaves_no_orphan_file() {
        let (_tmp, app) = app_data();
        let conn = chat_store::open_db(&app).expect("db");
        let conv = chat_store::insert_conversation(&conn, "nan", "t").expect("conv");
        let before = std::fs::read_dir(images::images_dir(&app))
            .expect("dir")
            .count();
        assert_eq!(
            persist_edit_result(&app, conv, Some(424242), "x", QWEN, &png()),
            Err(EditErrorKind::Protocol)
        );
        let after = std::fs::read_dir(images::images_dir(&app))
            .expect("dir")
            .count();
        assert_eq!(before, after, "the saved file was removed again");
    }

    // ---- loopback E2E (multipart wire shape + status mapping) ---------------------------

    /// One-request loopback server: returns (base, receiver of the raw
    /// request bytes). Answers `status` with `body`.
    fn serve_once(status: &str, body: String) -> (String, std::sync::mpsc::Receiver<Vec<u8>>) {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}/v1", listener.local_addr().expect("addr"));
        let (tx, rx) = std::sync::mpsc::channel();
        let status = status.to_string();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut raw = Vec::new();
            let mut buf = [0u8; 65536];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                raw.extend_from_slice(&buf[..n]);
                if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..end]).to_lowercase();
                    let length = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if raw.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            let response = format!(
                "HTTP/1.1 {status}\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = tx.send(raw);
        });
        (base, rx)
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn e2e_the_edit_posts_multipart_with_the_session_and_saves_b64() {
        let (base, rx) = serve_once(
            "200 OK",
            format!(r#"{{"created":1,"data":[{{"b64_json":"{TINY_PNG_B64}"}}]}}"#),
        );
        let sources = vec![
            EditSource {
                bytes: png(),
                format: ImageFormat::Png,
            },
            EditSource {
                bytes: webp(),
                format: ImageFormat::Webp,
            },
        ];
        let bytes = block_on(edit_at(
            &base,
            "nan",
            "fake-session-jwt",
            "make it snowy",
            sources,
        ))
        .expect("edit ok");
        assert_eq!(bytes, png());

        let raw = rx.recv().expect("request");
        let text = String::from_utf8_lossy(&raw);
        let lower = text.to_lowercase();
        assert!(
            text.starts_with("POST /v1/images/edits "),
            "{}",
            text.lines().next().unwrap_or_default()
        );
        assert!(lower.contains("authorization: bearer fake-session-jwt"));
        assert!(lower.contains("content-type: multipart/form-data; boundary="));
        assert!(lower.contains("name=\"prompt\"\r\n\r\nmake it snowy\r\n"));
        assert!(!lower.contains("name=\"instruction\""));
        assert_eq!(lower.matches("name=\"image[]\"").count(), 2);
        assert!(lower.contains("filename=\"image-1.png\"\r\ncontent-type: image/png"));
        assert!(lower.contains("filename=\"image-2.webp\"\r\ncontent-type: image/webp"));
        assert!(lower.contains("name=\"n\"\r\n\r\n1\r\n"));
        assert!(!lower.contains("name=\"model\""));
    }

    #[test]
    fn e2e_statuses_map_to_ui_kinds() {
        for (status, kind) in [
            ("400 Bad Request", EditErrorKind::InvalidRequest),
            ("401 Unauthorized", EditErrorKind::Unauthorized),
            ("403 Forbidden", EditErrorKind::TierRestricted),
            ("404 Not Found", EditErrorKind::NotAvailable),
            ("502 Bad Gateway", EditErrorKind::Server),
            ("503 Service Unavailable", EditErrorKind::Server),
        ] {
            for profile in ["nan", "helmcode"] {
                let (base, _rx) = serve_once(status, r#"{"error":"x"}"#.into());
                let sources = vec![EditSource {
                    bytes: png(),
                    format: ImageFormat::Png,
                }];
                assert_eq!(
                    block_on(edit_at(&base, profile, "t", "x", sources)),
                    Err(kind),
                    "{profile} {status}"
                );
            }
        }
    }

    #[test]
    fn e2e_the_enterprise_edit_posts_to_the_desktop_twin_and_keeps_jpeg() {
        let jpeg_b64 = BASE64_STANDARD.encode(jpeg());
        let (base, rx) = serve_once(
            "200 OK",
            format!(r#"{{"created":1,"data":[{{"b64_json":"{jpeg_b64}"}}]}}"#),
        );
        let sources = vec![EditSource {
            bytes: png(),
            format: ImageFormat::Png,
        }];
        let bytes = block_on(edit_at(&base, "helmcode", "jwt", "snow", sources)).expect("edit ok");
        assert_eq!(bytes, jpeg());
        let raw = rx.recv().expect("request");
        let text = String::from_utf8_lossy(&raw);
        assert!(
            text.starts_with("POST /v1/desktop/images/edits "),
            "{}",
            text.lines().next().unwrap_or_default()
        );
        assert_eq!(text.to_lowercase().matches("name=\"image[]\"").count(), 1);
    }

    #[test]
    fn e2e_an_unknown_profile_never_reaches_the_network() {
        let sources = vec![EditSource {
            bytes: png(),
            format: ImageFormat::Png,
        }];
        assert_eq!(
            block_on(edit_at("http://127.0.0.1:9", "other", "t", "x", sources)),
            Err(EditErrorKind::Protocol)
        );
    }
}
