//! Chat attachments: files the user adds to a message in the composer
//! (paperclip button, drag & drop onto the window, pasted images).
//!
//! Where each step lives (and why):
//!
//! - **Picking is renderer-proof.** The native file dialog is opened by this
//!   core ([`attachments_pick`]) and dropped files arrive through the
//!   window's own drag-drop event in Rust ([`stage_dropped`], wired in
//!   `lib.rs`), so a path never comes from the renderer. A pasted image is
//!   bytes the renderer already holds ([`attachments_stage_bytes`], images
//!   only). Every source is checked against the app data folder and the
//!   sensitive-path deny-list (credential stores, key files, shell startup
//!   files), size-capped and type-checked by its content.
//! - **Images** are decoded, downscaled to [`IMAGE_MAX_SIDE`] on the long
//!   side and re-encoded as JPEG (quality [`IMAGE_JPEG_QUALITY`]) right away,
//!   so a request carries at most a few hundred KB per image. The JPEG lives
//!   under `<app data>/images/attachments/` (inside the asset-protocol scope,
//!   so the composer chip and the message bubble show a thumbnail) and is
//!   sent as an OpenAI `image_url` part (data URL) only to a model that
//!   accepts images ([`crate::chat::ChatModelsConfig::vision`]).
//! - **Documents** (PDF, DOCX, spreadsheets, plain text and code) are staged
//!   as a private copy outside the asset scope; the renderer reads it back
//!   once ([`attachment_read`]) and extracts the TEXT with the libraries the
//!   preview pane already ships (pdf.js, mammoth, SheetJS). The extracted
//!   text, capped here ([`MAX_DOC_CHARS`] per file, [`MAX_TOTAL_DOC_CHARS`]
//!   per message, with an explicit truncation note to the model), is what is
//!   persisted with the user message, so history replays it verbatim. The
//!   staged copy is deleted when the message is sent.
//!
//! Persistence: the user row keeps the typed text in `content` and the
//! attachments as a JSON list in the device-local `messages.attachments`
//! column ([`AttachmentRecord`]). The renderer only ever receives a view
//! without the extracted text ([`AttachmentView`]). Account memory sync never
//! uploads attachment bytes or extracted text: the synced copy of the
//! message is its text plus one placeholder line per attachment
//! ([`sync_content`]).
//!
//! Vision routing: a turn whose user message carries images goes to the
//! configured vision fallback when the selected model is text-only
//! ([`route_model`]); a text-only model never receives an image part
//! ([`text_only_messages`], applied to every request body). Earlier images
//! reach a text-only model as `[Image: <name> — <description>]`, the
//! description being one cheap side request made when the image is sent
//! ([`describe_request_body`]).

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::{Deserialize, Serialize, Serializer};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// Most files attached to one message.
pub const MAX_FILES_PER_MESSAGE: usize = 10;
/// Largest image file accepted (before it is downscaled).
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Largest document file accepted.
pub const MAX_DOC_BYTES: u64 = 20 * 1024 * 1024;
/// Largest sum of the original files of one message.
pub const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
/// Long-side cap of an image sent to the model, in pixels.
pub const IMAGE_MAX_SIDE: u32 = 1568;
/// JPEG quality of the image sent to the model.
pub const IMAGE_JPEG_QUALITY: u8 = 85;
/// Largest image (in pixels) decoded at all: a decompression bomb is
/// refused before it is expanded in memory.
pub const MAX_DECODED_PIXELS: u64 = 50_000_000;
/// Extracted text kept per document, in characters.
pub const MAX_DOC_CHARS: usize = 50_000;
/// Extracted text kept per message (all documents), in characters.
pub const MAX_TOTAL_DOC_CHARS: usize = 120_000;
/// Longest file name kept (characters).
pub const MAX_NAME_CHARS: usize = 120;
/// Most real images in one request to a vision model: the newest ones are
/// sent as images, older ones as their text stand-in.
pub const MAX_IMAGES_PER_REQUEST: usize = 10;
/// Longest stored image description (characters).
pub const MAX_DESCRIPTION_CHARS: usize = 400;
/// Staged entries kept in memory at once (unsent composer attachments).
pub const MAX_STAGED: usize = 64;

/// Told to the model inside a document block that was cut.
pub const TRUNCATED_NOTE: &str =
    "[truncated: the rest of this file was not included because it is too long]";

/// Folder (under the app data root) of the images attached to messages.
pub const IMAGES_SUBDIR: &str = "attachments";
/// Folder (under the app data root) of staged documents.
pub const DOCS_DIR: &str = "attachments";
/// Sub-folder of both for not-yet-sent files.
pub const STAGED_SUBDIR: &str = "staged";

// ---------------------------------------------------------------------------
// Kinds and errors
// ---------------------------------------------------------------------------

/// What an attachment is. Also the telemetry `attachment_added.kind` value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentKind {
    Image,
    Pdf,
    Docx,
    Sheet,
    Text,
    /// A file with an unknown extension whose content is plain UTF-8 text.
    Other,
}

impl AttachmentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Sheet => "sheet",
            Self::Text => "text",
            Self::Other => "other",
        }
    }

    pub fn is_image(self) -> bool {
        self == Self::Image
    }

    /// Size cap of a file of this kind.
    pub fn max_bytes(self) -> u64 {
        if self.is_image() {
            MAX_IMAGE_BYTES
        } else {
            MAX_DOC_BYTES
        }
    }
}

/// Why a file could not be attached (snake_case for the renderer, which
/// turns it into plain words).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachError {
    /// More than [`MAX_FILES_PER_MESSAGE`] files.
    TooMany,
    /// The file is over its kind's cap.
    TooLarge,
    /// The message's files are over [`MAX_TOTAL_BYTES`] together.
    TotalTooLarge,
    /// Not a type the app can read (binary, old Office formats, ...).
    Unsupported,
    /// The file could not be read or decoded.
    Unreadable,
    /// The app's own data, a credential store or a key file.
    NotAllowed,
    /// The attachment is unknown (expired or already sent) or a local failure.
    Protocol,
}

impl AttachError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TooMany => "too_many",
            Self::TooLarge => "too_large",
            Self::TotalTooLarge => "total_too_large",
            Self::Unsupported => "unsupported",
            Self::Unreadable => "unreadable",
            Self::NotAllowed => "not_allowed",
            Self::Protocol => "protocol",
        }
    }
}

const TEXT_EXTENSIONS: &[&str] = &[
    "txt",
    "md",
    "markdown",
    "json",
    "jsonl",
    "yaml",
    "yml",
    "toml",
    "xml",
    "html",
    "htm",
    "css",
    "scss",
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "kt",
    "swift",
    "c",
    "h",
    "cpp",
    "hpp",
    "cc",
    "cs",
    "php",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "sql",
    "log",
    "ini",
    "cfg",
    "conf",
    "tex",
    "rst",
    "srt",
    "vtt",
    "svg",
    "graphql",
    "proto",
    "r",
    "lua",
    "dart",
    "vue",
    "svelte",
    "properties",
    "gradle",
    "dockerfile",
    "makefile",
];
const SHEET_EXTENSIONS: &[&str] = &["xlsx", "xls", "xlsm", "ods", "csv", "tsv"];

/// The lowercase extension of a file name ("" when none).
fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default()
}

/// Image formats decided by MAGIC BYTES (never the extension).
fn sniff_image(bytes: &[u8]) -> Option<image::ImageFormat> {
    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if bytes.starts_with(&PNG) {
        Some(image::ImageFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(image::ImageFormat::Jpeg)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(image::ImageFormat::WebP)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(image::ImageFormat::Gif)
    } else {
        None
    }
}

/// Plain text: no NUL byte in the first 8 KiB (the usual binary sniff).
fn looks_textual(bytes: &[u8]) -> bool {
    !bytes.iter().take(8192).any(|b| *b == 0)
}

/// Decide what a file is from its name and content. Images are recognized
/// by content whatever their extension; documents need both a known
/// extension and a matching content shape.
pub fn classify(name: &str, bytes: &[u8]) -> Result<AttachmentKind, AttachError> {
    if sniff_image(bytes).is_some() {
        return Ok(AttachmentKind::Image);
    }
    let ext = extension_of(name);
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => {
            let head = &bytes[..bytes.len().min(1024)];
            if head.windows(5).any(|w| w == b"%PDF-") {
                Ok(AttachmentKind::Pdf)
            } else {
                Err(AttachError::Unreadable)
            }
        }
        "docx" => {
            if bytes.starts_with(b"PK") {
                Ok(AttachmentKind::Docx)
            } else {
                Err(AttachError::Unreadable)
            }
        }
        "csv" | "tsv" if looks_textual(bytes) => Ok(AttachmentKind::Sheet),
        "csv" | "tsv" => Err(AttachError::Unreadable),
        ext if SHEET_EXTENSIONS.contains(&ext) => Ok(AttachmentKind::Sheet),
        // Old binary Office formats and slides: not readable here.
        "doc" | "ppt" | "pptx" | "key" | "pages" | "numbers" | "zip" | "rar" | "7z" | "exe"
        | "dmg" | "heic" | "heif" | "tif" | "tiff" | "bmp" | "mp3" | "mp4" | "mov" | "wav" => {
            Err(AttachError::Unsupported)
        }
        ext if TEXT_EXTENSIONS.contains(&ext)
            || (ext.is_empty() && TEXT_EXTENSIONS.contains(&stem.as_str())) =>
        {
            if looks_textual(bytes) {
                Ok(AttachmentKind::Text)
            } else {
                Err(AttachError::Unsupported)
            }
        }
        _ => {
            if looks_textual(bytes) && std::str::from_utf8(bytes).is_ok() {
                Ok(AttachmentKind::Other)
            } else {
                Err(AttachError::Unsupported)
            }
        }
    }
}

/// A file name safe to show and to put in a delimiter: no path, no control
/// characters, no quotes or angle brackets, at most [`MAX_NAME_CHARS`].
pub fn clean_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '"' | '<' | '>' | '[' | ']' => '_',
            c => c,
        })
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// Image preparation
// ---------------------------------------------------------------------------

/// Decode an image (GIF: its first frame), downscale it so its long side is
/// at most [`IMAGE_MAX_SIDE`], flatten transparency onto white and encode it
/// as JPEG. Never upscales.
pub fn prepare_image(bytes: &[u8]) -> Result<Vec<u8>, AttachError> {
    let format = sniff_image(bytes).ok_or(AttachError::Unsupported)?;
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODED_PIXELS * 4);
    reader.limits(limits);
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| AttachError::Unreadable)?;
    if u64::from(width) * u64::from(height) > MAX_DECODED_PIXELS {
        return Err(AttachError::TooLarge);
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODED_PIXELS * 4);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| AttachError::Unreadable)?;
    let resized = if width.max(height) > IMAGE_MAX_SIDE {
        decoded.resize(
            IMAGE_MAX_SIDE,
            IMAGE_MAX_SIDE,
            image::imageops::FilterType::Lanczos3,
        )
    } else {
        decoded
    };
    let rgba = resized.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, px) in rgba.enumerate_pixels() {
        let alpha = u16::from(px[3]);
        let blend = |c: u8| ((u16::from(c) * alpha + 255 * (255 - alpha)) / 255) as u8;
        rgb.put_pixel(x, y, image::Rgb([blend(px[0]), blend(px[1]), blend(px[2])]));
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, IMAGE_JPEG_QUALITY)
        .encode_image(&rgb)
        .map_err(|_| AttachError::Protocol)?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/// Sent image attachments: `<root>/images/attachments` (asset scope).
pub fn images_dir(app_data: &Path) -> PathBuf {
    crate::images::images_dir(app_data).join(IMAGES_SUBDIR)
}

/// Not-yet-sent images: `<root>/images/attachments/staged`.
pub fn staged_images_dir(app_data: &Path) -> PathBuf {
    images_dir(app_data).join(STAGED_SUBDIR)
}

/// Not-yet-sent documents: `<root>/attachments/staged` (outside the asset
/// scope: the renderer reads them only through [`attachment_read`]).
pub fn staged_docs_dir(app_data: &Path) -> PathBuf {
    crate::realm::root_of(app_data)
        .join(DOCS_DIR)
        .join(STAGED_SUBDIR)
}

// ---------------------------------------------------------------------------
// Staging (the in-memory registry of composer attachments)
// ---------------------------------------------------------------------------

/// A staged (not yet sent) attachment as the core remembers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedEntry {
    pub kind: AttachmentKind,
    pub name: String,
    /// Size of the ORIGINAL file in bytes.
    pub size: u64,
    /// The staged file: the prepared JPEG for an image, the copy for a
    /// document.
    pub path: PathBuf,
}

/// What the renderer gets for a staged attachment: enough for a chip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StagedAttachment {
    pub id: String,
    pub kind: AttachmentKind,
    pub name: String,
    pub size: u64,
    /// The prepared image (thumbnail through the asset protocol); `None`
    /// for documents.
    pub preview_path: Option<String>,
}

/// A file that could not be attached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RejectedFile {
    pub name: String,
    pub reason: AttachError,
}

/// The outcome of one pick, drop or paste.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct StageResult {
    pub staged: Vec<StagedAttachment>,
    pub rejected: Vec<RejectedFile>,
}

/// Composer attachments staged in this app session (id -> entry).
#[derive(Default)]
pub struct AttachmentsState(Mutex<HashMap<String, StagedEntry>>);

impl AttachmentsState {
    fn insert(&self, id: String, entry: StagedEntry) -> Result<(), AttachError> {
        let mut map = self.0.lock().map_err(|_| AttachError::Protocol)?;
        if map.len() >= MAX_STAGED {
            return Err(AttachError::TooMany);
        }
        map.insert(id, entry);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<StagedEntry> {
        self.0.lock().ok()?.get(id).cloned()
    }

    /// Forget an entry and delete its staged file.
    pub fn discard(&self, id: &str) {
        let entry = self.0.lock().ok().and_then(|mut map| map.remove(id));
        if let Some(entry) = entry {
            let _ = std::fs::remove_file(entry.path);
        }
    }

    fn take(&self, id: &str) -> Option<StagedEntry> {
        self.0.lock().ok()?.remove(id)
    }
}

/// Stage bytes the core already read: classify, size-check, prepare (image)
/// or copy (document) into the staged folders. Returns the new id and entry.
pub fn stage_bytes(
    app_data: &Path,
    raw_name: &str,
    bytes: &[u8],
) -> Result<(String, StagedEntry), AttachError> {
    let name = clean_name(raw_name);
    let kind = classify(&name, bytes)?;
    let size = bytes.len() as u64;
    if size > kind.max_bytes() {
        return Err(AttachError::TooLarge);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = if kind.is_image() {
        let jpeg = prepare_image(bytes)?;
        let dir = staged_images_dir(app_data);
        std::fs::create_dir_all(&dir).map_err(|_| AttachError::Protocol)?;
        let path = dir.join(format!("{id}.jpg"));
        std::fs::write(&path, jpeg).map_err(|_| AttachError::Protocol)?;
        path
    } else {
        let dir = staged_docs_dir(app_data);
        std::fs::create_dir_all(&dir).map_err(|_| AttachError::Protocol)?;
        let path = dir.join(format!("{id}.bin"));
        std::fs::write(&path, bytes).map_err(|_| AttachError::Protocol)?;
        path
    };
    Ok((
        id,
        StagedEntry {
            kind,
            name,
            size,
            path,
        },
    ))
}

/// Read a file the USER chose (native dialog or a drop on the window) and
/// stage it. Refused: the app data folder, the sensitive-path deny-list,
/// anything that is not a regular file, and files over the largest cap
/// (checked before reading, and again while reading).
pub fn stage_path(
    app_data: &Path,
    home: Option<&Path>,
    path: &Path,
) -> Result<(String, StagedEntry), AttachError> {
    let canonical = std::fs::canonicalize(path).map_err(|_| AttachError::Unreadable)?;
    let app_root = std::fs::canonicalize(crate::realm::root_of(app_data))
        .unwrap_or_else(|_| crate::realm::root_of(app_data).to_path_buf());
    if crate::tools::grants::is_protected(&app_root, &canonical)
        || crate::tools::grants::is_sensitive_write_target(home, &canonical)
    {
        return Err(AttachError::NotAllowed);
    }
    let meta = std::fs::metadata(&canonical).map_err(|_| AttachError::Unreadable)?;
    if !meta.is_file() {
        return Err(AttachError::Unsupported);
    }
    let largest = MAX_IMAGE_BYTES.max(MAX_DOC_BYTES);
    if meta.len() > largest {
        return Err(AttachError::TooLarge);
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(&canonical)
        .and_then(|file| file.take(largest + 1).read_to_end(&mut bytes))
        .map_err(|_| AttachError::Unreadable)?;
    if bytes.len() as u64 > largest {
        return Err(AttachError::TooLarge);
    }
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    stage_bytes(app_data, &name, &bytes)
}

/// Stage several user-chosen paths (a pick or a drop) into `state`. At most
/// [`MAX_FILES_PER_MESSAGE`] are staged; the rest are rejected as `too_many`.
pub fn stage_paths(
    state: &AttachmentsState,
    app_data: &Path,
    home: Option<&Path>,
    paths: &[PathBuf],
) -> StageResult {
    let mut result = StageResult::default();
    for path in paths {
        let display = clean_name(
            &path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
        );
        if result.staged.len() >= MAX_FILES_PER_MESSAGE {
            result.rejected.push(RejectedFile {
                name: display,
                reason: AttachError::TooMany,
            });
            continue;
        }
        match stage_path(app_data, home, path).and_then(|(id, entry)| {
            register(state, id, entry.clone()).map(|staged| (staged, entry))
        }) {
            Ok((staged, _)) => result.staged.push(staged),
            Err(reason) => result.rejected.push(RejectedFile {
                name: display,
                reason,
            }),
        }
    }
    result
}

/// Remember a staged entry and build its renderer view. On failure the
/// staged file is removed.
fn register(
    state: &AttachmentsState,
    id: String,
    entry: StagedEntry,
) -> Result<StagedAttachment, AttachError> {
    let staged = StagedAttachment {
        id: id.clone(),
        kind: entry.kind,
        name: entry.name.clone(),
        size: entry.size,
        preview_path: entry
            .kind
            .is_image()
            .then(|| entry.path.display().to_string()),
    };
    let path = entry.path.clone();
    state.insert(id, entry).inspect_err(|_| {
        let _ = std::fs::remove_file(path);
    })?;
    Ok(staged)
}

// ---------------------------------------------------------------------------
// Persisted records
// ---------------------------------------------------------------------------

/// Loads the data URL of an image attachment that may travel as an IMAGE
/// (see `turn::history_messages`).
pub type ImageLoader<'a> = &'a dyn Fn(&AttachmentRecord) -> Option<String>;

/// One attachment of a sent user message, as stored (device-local JSON in
/// `messages.attachments`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentRecord {
    pub id: String,
    pub kind: AttachmentKind,
    pub name: String,
    pub size: u64,
    /// The prepared JPEG of an image (`<root>/images/attachments/<id>.jpg`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The extracted text of a document (already capped).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The extracted text was cut at the cap.
    #[serde(default)]
    pub truncated: bool,
    /// A short description of an image (side request to the vision model),
    /// used as its text stand-in for text-only models.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// What the renderer sees of a stored attachment: never the extracted text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttachmentView<'a> {
    pub id: &'a str,
    pub kind: AttachmentKind,
    pub name: &'a str,
    pub size: u64,
    pub path: Option<&'a str>,
    pub truncated: bool,
}

impl AttachmentRecord {
    pub fn view(&self) -> AttachmentView<'_> {
        AttachmentView {
            id: &self.id,
            kind: self.kind,
            name: &self.name,
            size: self.size,
            path: self.path.as_deref(),
            truncated: self.truncated,
        }
    }
}

/// `serialize_with` for `ChatMessageRow::attachments`: the views only.
pub fn serialize_views<S: Serializer>(
    records: &[AttachmentRecord],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(records.iter().map(AttachmentRecord::view))
}

/// Parse the stored column (`None`/malformed = no attachments).
pub fn decode_records(raw: Option<String>) -> Vec<AttachmentRecord> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// The column value for a list (`None` when empty).
pub fn encode_records(records: &[AttachmentRecord]) -> Option<String> {
    if records.is_empty() {
        None
    } else {
        serde_json::to_string(records).ok()
    }
}

/// One attachment in `chat_send`: the staged id, plus the text the renderer
/// extracted for a document (ignored for images).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AttachmentInput {
    pub id: String,
    #[serde(default)]
    pub text: Option<String>,
}

/// Cut `text` to at most `max` characters; `true` when something was cut.
fn cap_text(text: &str, max: usize) -> (String, bool) {
    match text.char_indices().nth(max) {
        Some((cut, _)) => (text[..cut].to_string(), true),
        None => (text.to_string(), false),
    }
}

/// Turn the composer's staged attachments into stored records, in order:
/// validates the count, that every id is staged and unique, the total size,
/// and caps the extracted text (per file, then per message). Images move
/// from the staged folder to the sent folder; staged document copies are
/// deleted. Nothing is consumed when validation fails.
pub fn commit(
    state: &AttachmentsState,
    app_data: &Path,
    inputs: &[AttachmentInput],
) -> Result<Vec<AttachmentRecord>, AttachError> {
    if inputs.len() > MAX_FILES_PER_MESSAGE {
        return Err(AttachError::TooMany);
    }
    let mut entries = Vec::with_capacity(inputs.len());
    let mut total: u64 = 0;
    for (index, input) in inputs.iter().enumerate() {
        if inputs[..index].iter().any(|other| other.id == input.id) {
            return Err(AttachError::Protocol);
        }
        let entry = state.get(&input.id).ok_or(AttachError::Protocol)?;
        total = total.saturating_add(entry.size);
        entries.push(entry);
    }
    if total > MAX_TOTAL_BYTES {
        return Err(AttachError::TotalTooLarge);
    }
    let sent_dir = images_dir(app_data);
    let mut records = Vec::with_capacity(inputs.len());
    let mut doc_budget = MAX_TOTAL_DOC_CHARS;
    for (input, entry) in inputs.iter().zip(entries) {
        let mut record = AttachmentRecord {
            id: input.id.clone(),
            kind: entry.kind,
            name: entry.name.clone(),
            size: entry.size,
            path: None,
            text: None,
            truncated: false,
            description: None,
        };
        if entry.kind.is_image() {
            std::fs::create_dir_all(&sent_dir).map_err(|_| AttachError::Protocol)?;
            let target = sent_dir.join(format!("{}.jpg", input.id));
            std::fs::rename(&entry.path, &target)
                .or_else(|_| std::fs::copy(&entry.path, &target).map(|_| ()))
                .map_err(|_| AttachError::Protocol)?;
            record.path = Some(target.display().to_string());
        } else {
            let raw = input.text.as_deref().unwrap_or("").replace('\0', "");
            let limit = MAX_DOC_CHARS.min(doc_budget);
            let (text, cut) = cap_text(raw.trim_end(), limit);
            doc_budget -= text.chars().count();
            record.truncated = cut;
            record.text = Some(text);
        }
        records.push(record);
    }
    for input in inputs {
        if let Some(entry) = state.take(&input.id)
            && !entry.kind.is_image()
        {
            let _ = std::fs::remove_file(entry.path);
        }
    }
    Ok(records)
}

// ---------------------------------------------------------------------------
// What the model sees
// ---------------------------------------------------------------------------

/// The text stand-in of an image: `[Image: <name> — <description>]`.
pub fn image_stand_in(record: &AttachmentRecord) -> String {
    match record.description.as_deref().filter(|d| !d.is_empty()) {
        Some(description) => format!("[Image: {} — {}]", record.name, description),
        None => format!("[Image: {}]", record.name),
    }
}

/// The delimited block of a document's extracted text.
pub fn document_block(record: &AttachmentRecord) -> String {
    let text = record.text.as_deref().unwrap_or("").trim_end();
    let body = if text.trim().is_empty() {
        "[no readable text was found in this file]".to_string()
    } else if record.truncated {
        format!("{text}\n{TRUNCATED_NOTE}")
    } else {
        text.to_string()
    };
    format!(
        "<attached_file name=\"{}\">\n{}\n</attached_file>",
        record.name, body
    )
}

/// A user message's content for the model. `image_url(record)` returns the
/// data URL of an image that should be sent as an IMAGE (vision model,
/// within the per-request budget); every other image becomes its stand-in.
/// Plain string content when no image part is present.
pub fn user_content(
    text: &str,
    records: &[AttachmentRecord],
    image_url: &mut dyn FnMut(&AttachmentRecord) -> Option<String>,
) -> serde_json::Value {
    let mut blocks: Vec<String> = Vec::new();
    if !text.trim().is_empty() {
        blocks.push(text.to_string());
    }
    let mut images: Vec<serde_json::Value> = Vec::new();
    for record in records {
        if record.kind.is_image() {
            match image_url(record) {
                Some(url) => images.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": url },
                })),
                None => blocks.push(image_stand_in(record)),
            }
        } else {
            blocks.push(document_block(record));
        }
    }
    let joined = blocks.join("\n\n");
    if images.is_empty() {
        return serde_json::Value::String(joined);
    }
    let mut parts = Vec::with_capacity(images.len() + 1);
    let prompt = if joined.is_empty() {
        "(The user sent only the attached image(s).)".to_string()
    } else {
        joined
    };
    parts.push(serde_json::json!({ "type": "text", "text": prompt }));
    parts.extend(images);
    serde_json::Value::Array(parts)
}

/// The data URL of a stored attachment image, read from disk. Only files
/// inside the attachments folders with a JPEG signature are read.
pub fn image_data_url(app_data: &Path, record: &AttachmentRecord) -> Option<String> {
    let path = PathBuf::from(record.path.as_deref()?);
    let canonical = std::fs::canonicalize(&path).ok()?;
    let root = std::fs::canonicalize(images_dir(app_data)).ok()?;
    if !canonical.starts_with(&root) {
        return None;
    }
    let bytes = std::fs::read(&canonical).ok()?;
    if !bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return None;
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

/// Copy of `messages` safe for a text-only model: every non-text content
/// part (image, audio, video, file) becomes text — the image's own stand-in
/// is unknown here, so a generic `[Image]` note is used — and an array
/// content of only text parts collapses to a string. Defense in depth: the
/// history builder already sends stand-ins to such models.
pub fn text_only_messages(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|message| {
            let Some(parts) = message.get("content").and_then(|c| c.as_array()) else {
                return message.clone();
            };
            let mut texts: Vec<String> = Vec::new();
            for part in parts {
                match part.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                            texts.push(text.to_string());
                        }
                    }
                    Some("image_url") | Some("image") => texts.push("[Image]".to_string()),
                    _ => texts.push("[Attachment]".to_string()),
                }
            }
            let mut copy = message.clone();
            copy["content"] = serde_json::Value::String(texts.join("\n\n"));
            copy
        })
        .collect()
}

/// Whether any message carries a non-text content part.
pub fn has_media_parts(messages: &[serde_json::Value]) -> bool {
    messages.iter().any(|message| {
        message
            .get("content")
            .and_then(|c| c.as_array())
            .is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| part.get("type").and_then(|t| t.as_str()) != Some("text"))
            })
    })
}

/// The synced (account memory) text of a user message: its text plus one
/// placeholder line per attachment. Attachment bytes and extracted text
/// never travel.
pub fn sync_content(text: &str, records: &[AttachmentRecord]) -> String {
    if records.is_empty() {
        return text.to_string();
    }
    let lines: Vec<String> = records
        .iter()
        .map(|record| {
            if record.kind.is_image() {
                image_stand_in(record)
            } else {
                format!("[Attached file: {}]", record.name)
            }
        })
        .collect();
    if text.trim().is_empty() {
        lines.join("\n")
    } else {
        format!("{text}\n\n{}", lines.join("\n"))
    }
}

// ---------------------------------------------------------------------------
// Vision routing
// ---------------------------------------------------------------------------

/// The model a turn is sent to: the user's selection, unless the turn's
/// message carries images and the selection cannot see them, in which case
/// the configured vision fallback (when there is one).
pub fn route_model(
    selected: &str,
    turn_has_images: bool,
    config: &crate::chat::ChatModelsConfig,
) -> String {
    if turn_has_images
        && !config.is_vision(selected)
        && let Some(fallback) = config.vision_fallback.as_deref()
    {
        return fallback.to_string();
    }
    selected.to_string()
}

/// System prompt of the description side request.
pub const DESCRIBE_PROMPT: &str = "Describe this image in one to three short, factual sentences \
     so that someone who cannot see it understands what it shows (include any clearly legible \
     text). Answer with the description only, in the same language as any text in the image, \
     or English otherwise.";

/// Body of the non-streaming description request for one image.
pub fn describe_request_body(model: &str, data_url: &str) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "stream": false,
        "max_tokens": 200,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": DESCRIBE_PROMPT },
            { "role": "user", "content": [
                { "type": "text", "text": "Describe this image." },
                { "type": "image_url", "image_url": { "url": data_url } },
            ]},
        ],
    })
}

/// The description from a chat-completions reply body: one line, no
/// control characters, at most [`MAX_DESCRIPTION_CHARS`]; `None` if empty.
pub fn parse_description(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let raw = value
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?;
    let raw = crate::tool_markup::sanitize_for_ui(raw);
    let collapsed = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace(['[', ']'], "");
    let (text, _) = cap_text(collapsed.trim(), MAX_DESCRIPTION_CHARS);
    (!text.is_empty()).then_some(text)
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/// Count of attachments per kind, in a fixed order (one `attachment_added`
/// event per kind present).
pub fn counts_by_kind(records: &[AttachmentRecord]) -> Vec<(AttachmentKind, usize)> {
    const ORDER: [AttachmentKind; 6] = [
        AttachmentKind::Image,
        AttachmentKind::Pdf,
        AttachmentKind::Docx,
        AttachmentKind::Sheet,
        AttachmentKind::Text,
        AttachmentKind::Other,
    ];
    ORDER
        .iter()
        .map(|kind| (*kind, records.iter().filter(|r| r.kind == *kind).count()))
        .filter(|(_, count)| *count > 0)
        .collect()
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/// Delete staged files (both folders) older than `min_age`: composer
/// attachments that were never sent. Regular files only.
pub fn sweep_staged(
    app_data: &Path,
    min_age: std::time::Duration,
    now: std::time::SystemTime,
) -> usize {
    let mut deleted = 0;
    for dir in [staged_images_dir(app_data), staged_docs_dir(app_data)] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let old = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= min_age);
            if old && std::fs::remove_file(entry.path()).is_ok() {
                deleted += 1;
            }
        }
    }
    deleted
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

use tauri::{AppHandle, Emitter, Manager};

/// The event a drop on the main window produces (a [`StageResult`]).
pub const DROPPED_EVENT: &str = "attachments://dropped";

/// Paperclip: the NATIVE multi-file dialog is opened by the core (the
/// renderer never names a path). An empty result = the user cancelled.
///
/// `async` on purpose: the dialog's blocking call must never run on the
/// main thread.
#[tauri::command]
pub async fn attachments_pick(app: AppHandle) -> Result<StageResult, String> {
    use tauri_plugin_dialog::DialogExt;
    let app_data = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().blocking_pick_files()
    })
    .await
    .map_err(|_| AttachError::Protocol.as_str().to_string())?;
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .collect();
    let state_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::home_dir();
        stage_paths(
            &state_app.state::<AttachmentsState>(),
            &app_data,
            home.as_deref(),
            &paths,
        )
    })
    .await
    .map_err(|_| AttachError::Protocol.as_str().to_string())
}

/// Files dropped on the main window (Rust window event, see `lib.rs`): staged
/// off the main thread, then announced to the window as [`DROPPED_EVENT`].
pub fn stage_dropped(app: &AppHandle, paths: Vec<PathBuf>) {
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let home = std::env::home_dir();
        let result = stage_paths(
            &app.state::<AttachmentsState>(),
            &app_data,
            home.as_deref(),
            &paths,
        );
        let _ = app.emit_to("main", DROPPED_EVENT, result);
    });
}

/// A pasted image (the renderer holds its bytes already): images only.
#[tauri::command]
pub async fn attachments_stage_bytes(
    app: AppHandle,
    name: String,
    data_base64: String,
) -> Result<StagedAttachment, String> {
    let app_data = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let state_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // base64 inflates by 4/3: refuse the oversized payload undecoded.
        if data_base64.len() as u64 > MAX_IMAGE_BYTES / 3 * 4 + 4 {
            return Err(AttachError::TooLarge);
        }
        let bytes = BASE64_STANDARD
            .decode(data_base64.as_bytes())
            .map_err(|_| AttachError::Unreadable)?;
        if sniff_image(&bytes).is_none() {
            return Err(AttachError::Unsupported);
        }
        let (id, entry) = stage_bytes(&app_data, &name, &bytes)?;
        register(&state_app.state::<AttachmentsState>(), id, entry)
    })
    .await
    .map_err(|_| AttachError::Protocol.as_str().to_string())?
    .map_err(|err| err.as_str().to_string())
}

/// The staged copy of a DOCUMENT, for the renderer's text extraction. Raw
/// bytes (no base64). Images are never read back this way.
#[tauri::command]
pub fn attachment_read(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let entry = app
        .state::<AttachmentsState>()
        .get(&id)
        .ok_or_else(|| AttachError::Protocol.as_str().to_string())?;
    if entry.kind.is_image() {
        return Err(AttachError::Protocol.as_str().to_string());
    }
    let bytes =
        std::fs::read(&entry.path).map_err(|_| AttachError::Unreadable.as_str().to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The user removed a chip: forget it and delete its staged file.
#[tauri::command]
pub fn attachment_discard(app: AppHandle, id: String) {
    app.state::<AttachmentsState>().discard(&id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn png(width: u32, height: u32, alpha: u8) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba([200, 10, 10, alpha]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn gif() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(4, 3, image::Rgba([0, 0, 255, 255]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Gif)
            .unwrap();
        out
    }

    fn app() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let app = dir.path().join("app");
        std::fs::create_dir_all(&app).unwrap();
        (dir, app)
    }

    fn record(kind: AttachmentKind, name: &str) -> AttachmentRecord {
        AttachmentRecord {
            id: "a1".into(),
            kind,
            name: name.into(),
            size: 10,
            path: None,
            text: None,
            truncated: false,
            description: None,
        }
    }

    #[test]
    fn classification_uses_content_for_images_and_extension_plus_shape_for_documents() {
        assert_eq!(
            classify("x.txt", &png(2, 2, 255)),
            Ok(AttachmentKind::Image)
        );
        assert_eq!(classify("anim.gif", &gif()), Ok(AttachmentKind::Image));
        assert_eq!(classify("a.pdf", b"%PDF-1.7\n..."), Ok(AttachmentKind::Pdf));
        assert_eq!(
            classify("a.pdf", b"not a pdf"),
            Err(AttachError::Unreadable)
        );
        assert_eq!(
            classify("a.docx", b"PK\x03\x04rest"),
            Ok(AttachmentKind::Docx)
        );
        assert_eq!(classify("a.xlsx", b"PK\x03\x04"), Ok(AttachmentKind::Sheet));
        assert_eq!(classify("a.csv", b"a,b\n1,2"), Ok(AttachmentKind::Sheet));
        assert_eq!(classify("notes.md", b"# hi"), Ok(AttachmentKind::Text));
        assert_eq!(
            classify("main.rs", b"fn main() {}"),
            Ok(AttachmentKind::Text)
        );
        assert_eq!(classify("Dockerfile", b"FROM x"), Ok(AttachmentKind::Text));
        assert_eq!(
            classify("data.weird", b"plain words"),
            Ok(AttachmentKind::Other)
        );
        assert_eq!(
            classify("blob.bin", b"\0\x01\x02"),
            Err(AttachError::Unsupported)
        );
        assert_eq!(
            classify("old.doc", b"\xD0\xCF"),
            Err(AttachError::Unsupported)
        );
        assert_eq!(
            classify("slides.pptx", b"PK"),
            Err(AttachError::Unsupported)
        );
        assert_eq!(classify("code.py", b"x\0y"), Err(AttachError::Unsupported));
    }

    #[test]
    fn names_lose_paths_controls_and_delimiter_characters() {
        assert_eq!(clean_name("/Users/a/report.pdf"), "report.pdf");
        assert_eq!(clean_name("C:\\x\\a\"b<c>[d].txt"), "a_b_c__d_.txt");
        assert_eq!(clean_name("line\nbreak.txt"), "linebreak.txt");
        assert_eq!(clean_name("   "), "file");
        assert_eq!(clean_name(&"n".repeat(500)).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn images_are_downscaled_to_the_long_side_cap_and_reencoded_as_jpeg() {
        let jpeg = prepare_image(&png(3000, 1500, 255)).unwrap();
        assert!(jpeg.starts_with(&[0xFF, 0xD8, 0xFF]));
        let decoded = image::load_from_memory(&jpeg).unwrap();
        assert_eq!(
            (decoded.width(), decoded.height()),
            (IMAGE_MAX_SIDE, IMAGE_MAX_SIDE / 2)
        );
        // Small images are never upscaled.
        let small = image::load_from_memory(&prepare_image(&png(40, 20, 255)).unwrap()).unwrap();
        assert_eq!((small.width(), small.height()), (40, 20));
        // GIF: first frame.
        let first = image::load_from_memory(&prepare_image(&gif()).unwrap()).unwrap();
        assert_eq!((first.width(), first.height()), (4, 3));
        // Transparency is flattened onto white.
        let clear = image::load_from_memory(&prepare_image(&png(8, 8, 0)).unwrap()).unwrap();
        let px = clear.to_rgb8().get_pixel(4, 4).0;
        assert!(px.iter().all(|c| *c > 240), "{px:?}");
        assert_eq!(prepare_image(b"nope"), Err(AttachError::Unsupported));
        let mut broken = png(8, 8, 255);
        broken.truncate(30);
        assert_eq!(prepare_image(&broken), Err(AttachError::Unreadable));
    }

    #[test]
    fn staging_prepares_images_copies_documents_and_enforces_caps() {
        let (_tmp, app) = app();
        let (_, image) = stage_bytes(&app, "photo.png", &png(10, 10, 255)).unwrap();
        assert_eq!(image.kind, AttachmentKind::Image);
        assert!(image.path.starts_with(staged_images_dir(&app)));
        assert!(
            std::fs::read(&image.path)
                .unwrap()
                .starts_with(&[0xFF, 0xD8])
        );
        let (_, doc) = stage_bytes(&app, "a.md", b"# title").unwrap();
        assert!(doc.path.starts_with(staged_docs_dir(&app)));
        assert!(
            !doc.path.starts_with(crate::images::images_dir(&app)),
            "docs stay outside the asset scope"
        );
        assert_eq!(std::fs::read(&doc.path).unwrap(), b"# title");
        let big = vec![b'a'; (MAX_DOC_BYTES + 1) as usize];
        assert_eq!(
            stage_bytes(&app, "big.txt", &big).err(),
            Some(AttachError::TooLarge)
        );
    }

    #[test]
    fn user_chosen_paths_refuse_the_app_folder_secrets_and_non_files() {
        let (tmp, app) = app();
        let home = tmp.path().join("home");
        std::fs::create_dir_all(home.join(".ssh")).unwrap();
        std::fs::write(home.join(".ssh/id_rsa.pem"), b"key").unwrap();
        std::fs::write(app.join("chat.db"), b"db").unwrap();
        std::fs::write(home.join("notes.txt"), b"hello").unwrap();
        let state = AttachmentsState::default();
        let result = stage_paths(
            &state,
            &app,
            Some(&home),
            &[
                home.join("notes.txt"),
                home.join(".ssh/id_rsa.pem"),
                app.join("chat.db"),
                home.clone(),
                home.join("missing.txt"),
            ],
        );
        assert_eq!(result.staged.len(), 1);
        assert_eq!(result.staged[0].name, "notes.txt");
        assert_eq!(result.staged[0].preview_path, None);
        let reasons: Vec<AttachError> = result.rejected.iter().map(|r| r.reason).collect();
        assert_eq!(
            reasons,
            vec![
                AttachError::NotAllowed,
                AttachError::NotAllowed,
                AttachError::Unsupported,
                AttachError::Unreadable
            ]
        );
    }

    #[test]
    fn a_drop_of_more_than_ten_files_stages_ten_and_rejects_the_rest() {
        let (tmp, app) = app();
        let paths: Vec<PathBuf> = (0..12)
            .map(|i| {
                let path = tmp.path().join(format!("f{i}.txt"));
                std::fs::write(&path, b"x").unwrap();
                path
            })
            .collect();
        let state = AttachmentsState::default();
        let result = stage_paths(&state, &app, None, &paths);
        assert_eq!(result.staged.len(), MAX_FILES_PER_MESSAGE);
        assert_eq!(result.rejected.len(), 2);
        assert!(
            result
                .rejected
                .iter()
                .all(|r| r.reason == AttachError::TooMany)
        );
    }

    fn staged(state: &AttachmentsState, app: &Path, name: &str, bytes: &[u8]) -> String {
        let (id, entry) = stage_bytes(app, name, bytes).unwrap();
        register(state, id.clone(), entry).unwrap();
        id
    }

    #[test]
    fn commit_moves_images_caps_text_and_consumes_the_staged_entries() {
        let (_tmp, app) = app();
        let state = AttachmentsState::default();
        let img = staged(&state, &app, "p.png", &png(5, 5, 255));
        let doc = staged(&state, &app, "long.txt", b"x");
        let doc_path = state.get(&doc).unwrap().path;
        let long = "é".repeat(MAX_DOC_CHARS + 5);
        let records = commit(
            &state,
            &app,
            &[
                AttachmentInput {
                    id: img.clone(),
                    text: Some("ignored".into()),
                },
                AttachmentInput {
                    id: doc.clone(),
                    text: Some(long),
                },
            ],
        )
        .unwrap();
        assert_eq!(records[0].kind, AttachmentKind::Image);
        assert_eq!(records[0].text, None);
        let sent = PathBuf::from(records[0].path.clone().unwrap());
        assert!(sent.starts_with(images_dir(&app)) && !sent.starts_with(staged_images_dir(&app)));
        assert!(sent.is_file());
        assert_eq!(
            records[1].text.as_ref().unwrap().chars().count(),
            MAX_DOC_CHARS
        );
        assert!(records[1].truncated);
        assert!(!doc_path.exists(), "the staged document copy is deleted");
        assert!(state.get(&img).is_none() && state.get(&doc).is_none());
        // Sending the same ids again fails: they are consumed.
        assert_eq!(
            commit(
                &state,
                &app,
                &[AttachmentInput {
                    id: img,
                    text: None
                }]
            ),
            Err(AttachError::Protocol)
        );
    }

    #[test]
    fn commit_enforces_the_count_unknown_ids_duplicates_and_the_message_text_budget() {
        let (_tmp, app) = app();
        let state = AttachmentsState::default();
        let many: Vec<AttachmentInput> = (0..11)
            .map(|i| AttachmentInput {
                id: format!("x{i}"),
                text: None,
            })
            .collect();
        assert_eq!(commit(&state, &app, &many), Err(AttachError::TooMany));
        assert_eq!(
            commit(
                &state,
                &app,
                &[AttachmentInput {
                    id: "nope".into(),
                    text: None
                }]
            ),
            Err(AttachError::Protocol)
        );
        let a = staged(&state, &app, "a.txt", b"a");
        assert_eq!(
            commit(
                &state,
                &app,
                &[
                    AttachmentInput {
                        id: a.clone(),
                        text: None
                    },
                    AttachmentInput {
                        id: a.clone(),
                        text: None
                    }
                ]
            ),
            Err(AttachError::Protocol)
        );
        assert!(state.get(&a).is_some(), "a failed commit consumes nothing");
        // Three full documents: the third only gets what is left of the
        // per-message budget.
        let ids: Vec<String> = (0..3)
            .map(|i| staged(&state, &app, &format!("d{i}.txt"), b"d"))
            .collect();
        let inputs: Vec<AttachmentInput> = ids
            .iter()
            .map(|id| AttachmentInput {
                id: id.clone(),
                text: Some("z".repeat(MAX_DOC_CHARS)),
            })
            .collect();
        let records = commit(&state, &app, &inputs).unwrap();
        let total: usize = records
            .iter()
            .map(|r| r.text.as_ref().unwrap().chars().count())
            .sum();
        assert_eq!(total, MAX_TOTAL_DOC_CHARS);
        assert!(!records[1].truncated && records[2].truncated);
    }

    #[test]
    fn commit_refuses_a_message_over_the_total_size() {
        let (_tmp, app) = app();
        let state = AttachmentsState::default();
        let ids: Vec<String> = (0..3)
            .map(|i| {
                let id = format!("big{i}");
                state
                    .insert(
                        id.clone(),
                        StagedEntry {
                            kind: AttachmentKind::Pdf,
                            name: "b.pdf".into(),
                            size: MAX_DOC_BYTES,
                            path: app.join(format!("{id}.bin")),
                        },
                    )
                    .unwrap();
                id
            })
            .collect();
        let inputs: Vec<AttachmentInput> = ids
            .iter()
            .map(|id| AttachmentInput {
                id: id.clone(),
                text: None,
            })
            .collect();
        assert_eq!(
            commit(&state, &app, &inputs),
            Err(AttachError::TotalTooLarge)
        );
    }

    #[test]
    fn user_content_delimits_documents_and_uses_parts_only_for_real_images() {
        let mut doc = record(AttachmentKind::Pdf, "report.pdf");
        doc.text = Some("Q3 revenue".into());
        doc.truncated = true;
        let mut img = record(AttachmentKind::Image, "cat.jpg");
        img.description = Some("A cat on a sofa.".into());
        let records = vec![doc.clone(), img.clone()];

        let text_only = user_content("Summarize", &records, &mut |_| None);
        let text = text_only.as_str().unwrap();
        assert!(text.starts_with("Summarize\n\n<attached_file name=\"report.pdf\">\nQ3 revenue\n"));
        assert!(text.contains(TRUNCATED_NOTE));
        assert!(text.ends_with("[Image: cat.jpg — A cat on a sofa.]"));

        let vision = user_content("Summarize", &records, &mut |_| {
            Some("data:image/jpeg;base64,AA".into())
        });
        let parts = vision.as_array().unwrap();
        assert_eq!(parts[0]["type"], "text");
        assert!(!parts[0]["text"].as_str().unwrap().contains("[Image:"));
        assert_eq!(parts[1]["type"], "image_url");
        assert_eq!(parts[1]["image_url"]["url"], "data:image/jpeg;base64,AA");

        let only_image = user_content("", &[img], &mut |_| Some("data:x".into()));
        assert_eq!(
            only_image[0]["text"],
            "(The user sent only the attached image(s).)"
        );
        let empty_doc = document_block(&record(AttachmentKind::Docx, "e.docx"));
        assert!(empty_doc.contains("no readable text"));
    }

    #[test]
    fn stand_ins_carry_the_description_when_there_is_one() {
        let mut img = record(AttachmentKind::Image, "a.png");
        assert_eq!(image_stand_in(&img), "[Image: a.png]");
        img.description = Some("Red square.".into());
        assert_eq!(image_stand_in(&img), "[Image: a.png — Red square.]");
    }

    #[test]
    fn text_only_messages_strip_every_media_part() {
        let messages = vec![
            serde_json::json!({"role":"system","content":"rules"}),
            serde_json::json!({"role":"user","content":[
                {"type":"text","text":"look"},
                {"type":"image_url","image_url":{"url":"data:image/jpeg;base64,AA"}},
                {"type":"input_audio","input_audio":{}}
            ]}),
        ];
        assert!(has_media_parts(&messages));
        let cleaned = text_only_messages(&messages);
        assert!(!has_media_parts(&cleaned));
        assert_eq!(cleaned[0], messages[0]);
        assert_eq!(cleaned[1]["content"], "look\n\n[Image]\n\n[Attachment]");
        assert!(!serde_json::to_string(&cleaned).unwrap().contains("base64"));
    }

    #[test]
    fn sync_content_never_carries_bytes_or_extracted_text() {
        let mut doc = record(AttachmentKind::Sheet, "q.xlsx");
        doc.text = Some("SECRET CELLS".into());
        let mut img = record(AttachmentKind::Image, "c.jpg");
        img.path = Some("/app/images/attachments/a1.jpg".into());
        img.description = Some("A chart.".into());
        let synced = sync_content("hi", &[doc.clone(), img.clone()]);
        assert_eq!(
            synced,
            "hi\n\n[Attached file: q.xlsx]\n[Image: c.jpg — A chart.]"
        );
        assert!(!synced.contains("SECRET") && !synced.contains("/app/"));
        assert_eq!(sync_content("", &[doc]), "[Attached file: q.xlsx]");
        assert_eq!(sync_content("plain", &[]), "plain");
    }

    #[test]
    fn the_renderer_view_never_includes_the_extracted_text() {
        let mut doc = record(AttachmentKind::Text, "a.txt");
        doc.text = Some("PRIVATE BODY".into());
        doc.description = Some("desc".into());
        let json = serde_json::to_string(&doc.view()).unwrap();
        assert!(!json.contains("PRIVATE") && !json.contains("desc"));
        assert!(json.contains("\"kind\":\"text\""));
        // The stored form keeps it (history replays it).
        let stored = encode_records(std::slice::from_ref(&doc)).unwrap();
        assert_eq!(decode_records(Some(stored)), vec![doc]);
        assert!(decode_records(Some("garbage".into())).is_empty());
        assert_eq!(encode_records(&[]), None);
    }

    #[test]
    fn image_data_urls_are_read_only_from_the_attachments_folder() {
        let (tmp, app) = app();
        let dir = images_dir(&app);
        std::fs::create_dir_all(&dir).unwrap();
        let inside = dir.join("a.jpg");
        std::fs::write(&inside, prepare_image(&png(2, 2, 255)).unwrap()).unwrap();
        let outside = tmp.path().join("b.jpg");
        std::fs::copy(&inside, &outside).unwrap();
        let mut rec = record(AttachmentKind::Image, "a.jpg");
        rec.path = Some(inside.display().to_string());
        assert!(
            image_data_url(&app, &rec)
                .unwrap()
                .starts_with("data:image/jpeg;base64,/9j/")
        );
        rec.path = Some(outside.display().to_string());
        assert_eq!(image_data_url(&app, &rec), None);
        rec.path = Some(dir.join("missing.jpg").display().to_string());
        assert_eq!(image_data_url(&app, &rec), None);
    }

    #[test]
    fn routing_sends_image_turns_of_text_only_models_to_the_vision_fallback() {
        let config =
            crate::chat::parse_chat_models_config(include_str!("../chat-models.json")).unwrap();
        assert_eq!(route_model("glm5.3", true, &config), "glm5.3-flash");
        assert_eq!(route_model("glm5.3", false, &config), "glm5.3");
        assert_eq!(
            route_model("deepseek-v4-flash", true, &config),
            "deepseek-v4-flash"
        );
        assert_eq!(route_model("glm5.3-flash", true, &config), "glm5.3-flash");
        let no_fallback = crate::chat::ChatModelsConfig {
            vision_fallback: None,
            ..config
        };
        assert_eq!(route_model("glm5.3", true, &no_fallback), "glm5.3");
    }

    #[test]
    fn descriptions_are_one_clean_bounded_line() {
        let body = serde_json::json!({"choices":[{"message":{"content":"  A dog\n\n running [fast].  "}}]});
        assert_eq!(
            parse_description(&body.to_string()),
            Some("A dog running fast.".into())
        );
        let long = serde_json::json!({"choices":[{"message":{"content":"w ".repeat(400)}}]});
        assert_eq!(
            parse_description(&long.to_string())
                .unwrap()
                .chars()
                .count(),
            MAX_DESCRIPTION_CHARS
        );
        assert_eq!(parse_description("{}"), None);
        assert_eq!(
            parse_description(r#"{"choices":[{"message":{"content":"   "}}]}"#),
            None
        );
        let req = describe_request_body("glm5.3-flash", "data:image/jpeg;base64,AA");
        assert_eq!(req["stream"], false);
        assert_eq!(req["messages"][1]["content"][1]["type"], "image_url");
    }

    #[test]
    fn telemetry_counts_are_per_kind_in_a_fixed_order() {
        let records = vec![
            record(AttachmentKind::Text, "a"),
            record(AttachmentKind::Image, "b"),
            record(AttachmentKind::Text, "c"),
        ];
        assert_eq!(
            counts_by_kind(&records),
            vec![(AttachmentKind::Image, 1), (AttachmentKind::Text, 2)]
        );
    }

    #[test]
    fn the_staged_sweep_removes_only_old_staged_files() {
        let (_tmp, app) = app();
        let (_, img) = stage_bytes(&app, "p.png", &png(2, 2, 255)).unwrap();
        let (_, doc) = stage_bytes(&app, "a.txt", b"x").unwrap();
        let sent = images_dir(&app).join("kept.jpg");
        std::fs::write(&sent, b"x").unwrap();
        let day = std::time::Duration::from_secs(86_400);
        assert_eq!(sweep_staged(&app, day, std::time::SystemTime::now()), 0);
        let later = std::time::SystemTime::now() + day * 2;
        assert_eq!(sweep_staged(&app, day, later), 2);
        assert!(!img.path.exists() && !doc.path.exists() && sent.exists());
    }
}
