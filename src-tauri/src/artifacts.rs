//! Shared artifacts (F1 of the artifacts design): a link to ONE immutable
//! snapshot of one local file, pushed to the tenant's artifact store.
//!
//! Two commands, both scoped per profile, modeled on `skills_team.rs`:
//!
//! - [`artifacts_request`]: the only way the renderer reads or revokes its
//!   links. The session JWT never leaves the core: the renderer names a
//!   route and the core adds the Bearer. The allowlist is closed
//!   ([`route_allowed`]): `GET /api/auth/me`, `GET /api/artifacts`,
//!   `DELETE /api/artifacts/{id}` on both tenants, plus
//!   `GET /api/admin/artifacts`, `DELETE /api/admin/artifacts/{id}` and
//!   `GET /api/members` on Helmcode only. No body, no redirects, a 20 s
//!   timeout and a 1 MiB reply cap. The reply is `{status, body}`; the
//!   renderer owns the decisions (error copy, list filters).
//! - [`artifact_share`]: the ONLY place that sends file bytes anywhere. The
//!   renderer names a source (`{kind: "file"|"media", path}`) and the share
//!   metadata; the core reads the bytes itself, through the SAME
//!   grant-checked path as the preview (`preview::read_granted_bytes`:
//!   grants, deny-list, `O_NOFOLLOW`, 8 MiB) or, for a generated image, only
//!   from directly inside `app_data/images`. It sniffs the type (extension
//!   and magic bytes must agree), pre-scans text for credentials, validates
//!   the metadata (`deny_unknown_fields`, per-profile scopes, expiry options,
//!   the risk acknowledgement) and POSTs `multipart/form-data` (`meta` JSON
//!   and `file`) to `{platform_base}/api/artifacts`. The renderer never
//!   holds the bytes, so it cannot upload a file outside the grants.
//!
//! Nothing here logs: no path, no content, no token, no link.

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::preview::{self, MAX_PREVIEW_FILE_BYTES};
use crate::tools::Rejection;
use crate::tools::grants::GrantsStore;

/// The owner resource on both tenants.
pub const API_ARTIFACTS: &str = "/api/artifacts";
/// The org admin resource (Helmcode only).
pub const API_ADMIN_ARTIFACTS: &str = "/api/admin/artifacts";
/// The org members list (Helmcode only): the members picker and the
/// "External" badge.
pub const API_MEMBERS: &str = "/api/members";
/// The account endpoint carrying the feature flag / capability.
pub const API_ME: &str = "/api/auth/me";
/// The only tenant with orgs (members, org scope, admin list).
pub const ENTERPRISE_PROFILE: &str = "helmcode";
/// Largest artifact (design 1.1): the preview cap, so anything the user can
/// preview can be shared and there is no second limit to explain.
pub const MAX_ARTIFACT_BYTES: u64 = MAX_PREVIEW_FILE_BYTES;
/// Largest reply body read from the artifacts API.
pub const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// Longest title (runes).
pub const MAX_TITLE_CHARS: usize = 120;
/// Most email recipients per share.
pub const MAX_RECIPIENTS: usize = 20;
/// Most member recipients per share (the picker lists the org).
pub const MAX_MEMBER_RECIPIENTS: usize = 200;
/// Longest accepted email address.
pub const MAX_EMAIL_LEN: usize = 254;
/// Longest accepted member id.
pub const MAX_MEMBER_ID_LEN: usize = 64;
/// Longest file name sent as the multipart file name.
pub const MAX_FILENAME_BYTES: usize = 200;
/// The only risk-copy version this build knows (design 3.4).
pub const RISK_VERSION: &str = "artifacts-risk-v1";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// An upload carries up to 8 MiB, so it gets more time than a list call.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(90);

// ---------------------------------------------------------------- errors --

/// Why an artifacts operation was refused before (or without) a server
/// answer. Reaches the renderer as `{ "code": "...", "detail": "..." }`
/// (plus `reason` for `source_refused`). Details are static: never a path,
/// a token, file content or a link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtifactError {
    /// A route, method, body or metadata outside the allowlist.
    RequestInvalid,
    /// No platform for this profile (or an unknown profile).
    Unavailable,
    /// No session JWT in the vault: sign in again.
    NoSession,
    /// The request did not complete (network, timeout, oversized reply).
    Offline,
    /// Over [`MAX_ARTIFACT_BYTES`].
    TooLarge,
    /// Not on the type allowlist, or extension and bytes disagree.
    UnsupportedType,
    /// A zero-byte file.
    Empty,
    /// The text looks like it holds a credential and `secret_ack` is unset.
    PossibleSecret,
    /// The risk acknowledgement is missing or does not match the scope.
    RiskAckRequired,
    /// The core refused to read the source (outside the grants, symlink,
    /// sensitive path, ...). `reason` is the preview rejection kind.
    SourceRefused { reason: String },
}

impl ArtifactError {
    /// The stable machine code the renderer matches on.
    pub fn code(&self) -> &'static str {
        match self {
            ArtifactError::RequestInvalid => "request_invalid",
            ArtifactError::Unavailable => "unavailable",
            ArtifactError::NoSession => "no_session",
            ArtifactError::Offline => "offline",
            ArtifactError::TooLarge => "too_large",
            ArtifactError::UnsupportedType => "unsupported_type",
            ArtifactError::Empty => "empty",
            ArtifactError::PossibleSecret => "possible_secret",
            ArtifactError::RiskAckRequired => "risk_ack_required",
            ArtifactError::SourceRefused { .. } => "source_refused",
        }
    }
}

impl std::fmt::Display for ArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl Serialize for ArtifactError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap as _;
        let reason = match self {
            ArtifactError::SourceRefused { reason } => Some(reason),
            _ => None,
        };
        let mut map = serializer.serialize_map(Some(if reason.is_some() { 3 } else { 2 }))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("detail", &self.to_string())?;
        if let Some(reason) = reason {
            map.serialize_entry("reason", reason)?;
        }
        map.end()
    }
}

impl From<Rejection> for ArtifactError {
    fn from(rejection: Rejection) -> Self {
        // The preview's own cap reads as the artifact cap (they are equal).
        if rejection.kind == "too_large" {
            return ArtifactError::TooLarge;
        }
        ArtifactError::SourceRefused {
            reason: rejection.kind,
        }
    }
}

// --------------------------------------------------------------- routes --

/// Whether `id` is an artifact id: `^[0-9a-f-]{36}$` (a UUID, lowercase).
pub fn is_valid_artifact_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// The closed route allowlist of [`artifacts_request`], per profile. The
/// enterprise-only routes are refused on any other profile.
pub fn route_allowed(profile_id: &str, method: &str, path: &str) -> bool {
    let enterprise = profile_id == ENTERPRISE_PROFILE;
    let item = |prefix: &str| {
        path.strip_prefix(prefix)
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some_and(is_valid_artifact_id)
    };
    match (method, path) {
        ("GET", API_ME) => true,
        ("GET", API_ARTIFACTS) => true,
        ("GET", API_ADMIN_ARTIFACTS) | ("GET", API_MEMBERS) => enterprise,
        ("DELETE", _) if item(API_ARTIFACTS) => true,
        ("DELETE", _) if item(API_ADMIN_ARTIFACTS) => enterprise,
        _ => false,
    }
}

/// The reply handed to the renderer. A non-JSON or empty body is `null`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtifactResponse {
    pub status: u16,
    pub body: serde_json::Value,
    /// The `X-Total-Count` header (enterprise list paging), when present
    /// and a plain non-negative integer. Omitted otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// `X-Total-Count` as a number: ASCII digits only (no sign, no spaces),
/// anything else is ignored rather than guessed.
fn total_count(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get("x-total-count")?.to_str().ok()?;
    if raw.is_empty() || raw.len() > 19 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

fn client(timeout: Duration) -> Result<reqwest::Client, ArtifactError> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ArtifactError::Offline)
}

async fn read_reply(response: reqwest::Response) -> Result<ArtifactResponse, ArtifactError> {
    use futures_util::StreamExt as _;
    let status = response.status().as_u16();
    let total = total_count(response.headers());
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ArtifactError::Offline)?;
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(ArtifactError::Offline);
        }
    }
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    Ok(ArtifactResponse {
        status,
        body,
        total,
    })
}

/// One owner/admin call: `{base}{path}` with the session Bearer, no body.
pub async fn send(
    base: &str,
    session_token: &str,
    profile_id: &str,
    method: &str,
    path: &str,
) -> Result<ArtifactResponse, ArtifactError> {
    if !route_allowed(profile_id, method, path) {
        return Err(ArtifactError::RequestInvalid);
    }
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| ArtifactError::RequestInvalid)?;
    let response = client(REQUEST_TIMEOUT)?
        .request(method, format!("{}{path}", base.trim_end_matches('/')))
        .bearer_auth(session_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| ArtifactError::Offline)?;
    read_reply(response).await
}

// ------------------------------------------------------------- the meta --

/// What the renderer asks the core to share.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareSource {
    /// `file`: inside an active grant. `media`: an image this app generated.
    pub kind: String,
    pub path: String,
}

/// The explicit acceptance of the risk warning (design 3.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RiskAck {
    pub kind: String,
    pub version: String,
}

/// The share metadata as the renderer sends it (wire contract 8.1, `meta`).
/// `expires_days` is a required integer: [`NO_EXPIRY`] (0) is "no expiry"
/// (members/org scopes only). A null/absent value is refused here: both
/// servers read it as the scope DEFAULT, so letting it through would turn
/// "Sin caducidad" into a silent 90-day expiry. It is parsed wide (`i64`) so
/// negatives and nulls fail in [`checked_meta`] as `RequestInvalid`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShareMeta {
    pub title: String,
    pub scope: String,
    #[serde(default)]
    pub emails: Vec<String>,
    #[serde(default)]
    pub member_ids: Vec<String>,
    #[serde(default)]
    pub expires_days: Option<i64>,
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub risk_ack: Option<RiskAck>,
    #[serde(default)]
    pub secret_ack: Option<bool>,
}

/// The `meta` part as sent upstream (validated and normalized).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WireMeta {
    pub title: String,
    pub scope: String,
    pub emails: Vec<String>,
    pub member_ids: Vec<String>,
    /// Always serialized as an integer; 0 = never (ARTIFACTS.md 3.5).
    pub expires_days: u32,
    pub notify: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk_ack: Option<RiskAck>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret_ack: Option<bool>,
}

/// The scopes a profile may use: Helmcode has orgs, the community does not.
pub fn scope_allowed(profile_id: &str, scope: &str) -> bool {
    match scope {
        "emails" | "public" => true,
        "members" | "org" => profile_id == ENTERPRISE_PROFILE,
        _ => false,
    }
}

/// The wire value for "no expiry" (server policy: members/org only).
pub const NO_EXPIRY: u32 = 0;

/// The expiry options per scope (design 3.5), mirroring the server policy:
/// [`NO_EXPIRY`] only for members/org; emails/public need a positive option.
/// Null/absent and negatives are never allowed.
pub fn expiry_allowed(scope: &str, days: Option<i64>) -> bool {
    let Some(d) = days else { return false };
    match scope {
        "public" => [1, 7, 30].contains(&d),
        "emails" => [1, 7, 30, 90].contains(&d),
        "members" | "org" => [7, 30, 90, i64::from(NO_EXPIRY)].contains(&d),
        _ => false,
    }
}

/// RFC-lite: one `@`, a non-empty local part, a dotted domain, no spaces
/// or control characters, ASCII only, at most [`MAX_EMAIL_LEN`].
pub fn is_valid_email(email: &str) -> bool {
    if email.is_empty() || email.len() > MAX_EMAIL_LEN || !email.is_ascii() {
        return false;
    }
    if email
        .bytes()
        .any(|b| b <= b' ' || b == 0x7f || b"<>()[],;:\\\"".contains(&b))
    {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !domain.contains("..")
        && domain.split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

fn is_valid_member_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_MEMBER_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Validate and normalize the metadata for `profile_id`. `filename` is the
/// default title. Emails are lowercased and deduplicated; the risk
/// acknowledgement is required where the client can already tell (public
/// always; community emails always, every recipient being external there);
/// the server recomputes it anyway (`422 risk_ack_required`).
pub fn checked_meta(
    profile_id: &str,
    meta: ShareMeta,
    filename: &str,
) -> Result<WireMeta, ArtifactError> {
    let invalid = ArtifactError::RequestInvalid;
    if !scope_allowed(profile_id, &meta.scope) || !expiry_allowed(&meta.scope, meta.expires_days) {
        return Err(invalid);
    }
    let mut title = meta.title.trim().to_string();
    if title.is_empty() {
        title = filename.to_string();
    }
    if title.chars().any(char::is_control) || title.chars().count() > MAX_TITLE_CHARS {
        return Err(invalid);
    }

    let mut emails: Vec<String> = Vec::new();
    for raw in &meta.emails {
        let email = raw.trim().to_ascii_lowercase();
        if !is_valid_email(&email) {
            return Err(invalid);
        }
        if !emails.contains(&email) {
            emails.push(email);
        }
    }
    let mut member_ids: Vec<String> = Vec::new();
    for id in &meta.member_ids {
        if !is_valid_member_id(id) {
            return Err(invalid);
        }
        if !member_ids.contains(id) {
            member_ids.push(id.clone());
        }
    }
    match meta.scope.as_str() {
        "emails"
            if emails.is_empty() || emails.len() > MAX_RECIPIENTS || !member_ids.is_empty() =>
        {
            return Err(invalid);
        }
        "members"
            if member_ids.is_empty()
                || member_ids.len() > MAX_MEMBER_RECIPIENTS
                || !emails.is_empty() =>
        {
            return Err(invalid);
        }
        "org" | "public" if !emails.is_empty() || !member_ids.is_empty() => return Err(invalid),
        _ => {}
    }

    if let Some(ack) = &meta.risk_ack
        && (ack.version != RISK_VERSION || !["public", "external"].contains(&ack.kind.as_str()))
    {
        return Err(ArtifactError::RiskAckRequired);
    }
    let ack_kind = meta.risk_ack.as_ref().map(|ack| ack.kind.as_str());
    let required = match meta.scope.as_str() {
        "public" => Some("public"),
        "emails" if profile_id != ENTERPRISE_PROFILE => Some("external"),
        _ => None,
    };
    match (required, ack_kind) {
        (Some(kind), Some(given)) if kind == given => {}
        (Some(_), _) => return Err(ArtifactError::RiskAckRequired),
        // Enterprise emails: externality is decided server-side; an ack the
        // user gave for external recipients is forwarded as is.
        (None, Some("external")) if meta.scope == "emails" => {}
        (None, Some(_)) => return Err(ArtifactError::RiskAckRequired),
        (None, None) => {}
    }

    let notify = meta.notify && matches!(meta.scope.as_str(), "emails" | "members");
    // `expiry_allowed` already pinned it to a small non-negative option.
    let expires_days = meta
        .expires_days
        .and_then(|d| u32::try_from(d).ok())
        .ok_or(ArtifactError::RequestInvalid)?;
    Ok(WireMeta {
        title,
        scope: meta.scope,
        emails,
        member_ids,
        expires_days,
        notify,
        risk_ack: meta.risk_ack,
        secret_ack: meta.secret_ack.filter(|ack| *ack),
    })
}

// ---------------------------------------------------- sniff and scan --

/// A shareable type: what the server will also sniff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sniffed {
    pub content_type: &'static str,
    /// Text-like types get the credential pre-scan.
    pub text: bool,
}

fn utf8_text(bytes: &[u8]) -> bool {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    !body.contains(&0) && std::str::from_utf8(body).is_ok()
}

/// The leading bytes announce a binary type the allowlist knows.
fn binary_magic(bytes: &[u8]) -> bool {
    [
        &b"%PDF-"[..],
        b"\x89PNG\r\n\x1a\n",
        &[0xFF, 0xD8, 0xFF],
        b"GIF87a",
        b"GIF89a",
        b"PK\x03\x04",
    ]
    .iter()
    .any(|magic| bytes.starts_with(magic))
        || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

/// Shareable text: UTF-8, no NUL, no binary magic.
fn plain(bytes: &[u8]) -> bool {
    utf8_text(bytes) && !binary_magic(bytes)
}

/// R20-C: the text files the preview shows as text (renderer
/// `TEXT_EXTENSIONS`, minus `txt` and the `env` credential stores). The
/// servers store md/txt/csv/html only, so these share as text/plain under
/// a `.txt` upload name ([`upload_name`]); the title keeps the real name.
/// A renderer test keeps this list in sync with the preview's.
pub const PLAIN_TEXT_EXTENSIONS: &[&str] = &[
    "log", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "svg", "tsv", "js", "jsx", "ts",
    "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp",
    "cs", "php", "sh", "bash", "zsh", "sql", "css", "scss",
];

/// The multipart file name: the servers type an upload by its extension,
/// so a plain-text-family file travels as `<name>.txt`.
pub fn upload_name(filename: &str) -> String {
    let ext = Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if PLAIN_TEXT_EXTENSIONS.contains(&ext.as_str()) {
        format!("{filename}.txt")
    } else {
        filename.to_string()
    }
}

/// Sniff `bytes` named `filename` against the allowlist (design 1.1):
/// the extension picks the candidate type and the bytes must agree.
pub fn sniff(filename: &str, bytes: &[u8]) -> Result<Sniffed, ArtifactError> {
    let ext = Path::new(filename)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let binary = |content_type| Sniffed {
        content_type,
        text: false,
    };
    let text = |content_type| Sniffed {
        content_type,
        text: true,
    };
    let zip = bytes.starts_with(b"PK\x03\x04");
    let sniffed = match ext.as_str() {
        "pdf" if bytes.starts_with(b"%PDF-") => binary("application/pdf"),
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => binary("image/png"),
        "jpg" | "jpeg" if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) => binary("image/jpeg"),
        "webp" if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            binary("image/webp")
        }
        "gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => {
            binary("image/gif")
        }
        // Text: valid UTF-8 and no binary magic (a polyglot is refused,
        // as the servers do).
        "md" | "markdown" if plain(bytes) => text("text/markdown"),
        "txt" if plain(bytes) => text("text/plain"),
        "csv" if plain(bytes) => text("text/csv"),
        "html" | "htm" if plain(bytes) => text("text/html"),
        ext if PLAIN_TEXT_EXTENSIONS.contains(&ext) && plain(bytes) => text("text/plain"),
        "docx" if zip => {
            binary("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        }
        "xlsx" if zip => {
            binary("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        }
        _ => return Err(ArtifactError::UnsupportedType),
    };
    Ok(sniffed)
}

fn token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// Whether text holds something shaped like a credential (design 7.7):
/// `sk-` / `sk-hke_` keys, GitHub `ghp_` tokens, AWS `AKIA` ids and PEM
/// private keys. A prefix only counts at a word start and followed by a
/// key-length run, so prose like "risk-free" never trips it.
pub fn looks_like_secret(text: &str) -> bool {
    let bytes = text.as_bytes();
    let run =
        |from: usize, ok: fn(u8) -> bool| bytes[from..].iter().take_while(|b| ok(**b)).count();
    for (start, _) in text.char_indices() {
        if start > 0 && token_char(bytes[start - 1]) {
            continue;
        }
        let rest = &bytes[start..];
        if rest.starts_with(b"sk-") && run(start + 3, token_char) >= 16 {
            return true;
        }
        if rest.starts_with(b"ghp_") && run(start + 4, |b| b.is_ascii_alphanumeric()) >= 20 {
            return true;
        }
        if rest.starts_with(b"AKIA")
            && run(start + 4, |b| b.is_ascii_uppercase() || b.is_ascii_digit()) >= 16
        {
            return true;
        }
        if rest.starts_with(b"-----BEGIN ") {
            let line = rest.split(|b| *b == b'\n').next().unwrap_or_default();
            if line.windows(11).any(|w| w == b"PRIVATE KEY") {
                return true;
            }
        }
    }
    false
}

/// The base name only, without control characters, path separators or
/// quotes, capped at [`MAX_FILENAME_BYTES`] on a char boundary (the
/// extension is kept). Used as the multipart file name (extension only)
/// and the default title.
pub fn sanitize_filename(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or_default();
    let clean: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '"' | '\'' | '/' | '\\'))
        .collect();
    let clean = clean.trim().to_string();
    if clean.len() <= MAX_FILENAME_BYTES {
        return clean;
    }
    let ext = Path::new(&clean)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{ext}"))
        .filter(|ext| ext.len() < 16)
        .unwrap_or_default();
    let mut stem = String::new();
    for c in clean.chars() {
        if stem.len() + c.len_utf8() + ext.len() > MAX_FILENAME_BYTES {
            break;
        }
        stem.push(c);
    }
    format!("{stem}{ext}")
}

// ------------------------------------------------------------ the read --

/// A validated upload, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
    pub filename: String,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
    pub meta: WireMeta,
}

/// Read the source bytes: a grant-checked file, or a generated image
/// directly inside `app_data/images`. Never anything else.
pub fn read_source(
    store: &GrantsStore,
    profile_id: &str,
    source: &ShareSource,
    app_data: &Path,
    home: Option<&Path>,
) -> Result<Vec<u8>, ArtifactError> {
    match source.kind.as_str() {
        "file" => Ok(preview::read_granted_bytes(
            store,
            profile_id,
            &source.path,
            app_data,
            home,
        )?),
        "media" => {
            let canonical =
                crate::images::verify_generated_image(app_data, Path::new(&source.path)).map_err(
                    |_| ArtifactError::SourceRefused {
                        reason: "scope".into(),
                    },
                )?;
            Ok(preview::read_no_follow(&canonical)?)
        }
        _ => Err(ArtifactError::RequestInvalid),
    }
}

/// Everything the core checks before an upload, in order: the metadata
/// (cheap, no disk), the read, the size, the type, the secret pre-scan.
pub fn prepare_upload(
    store: &GrantsStore,
    profile_id: &str,
    source: &ShareSource,
    meta: ShareMeta,
    app_data: &Path,
    home: Option<&Path>,
) -> Result<Upload, ArtifactError> {
    let filename = sanitize_filename(&source.path);
    if filename.is_empty() {
        return Err(ArtifactError::RequestInvalid);
    }
    let meta = checked_meta(profile_id, meta, &filename)?;
    let bytes = read_source(store, profile_id, source, app_data, home)?;
    if bytes.len() as u64 > MAX_ARTIFACT_BYTES {
        return Err(ArtifactError::TooLarge);
    }
    if bytes.is_empty() {
        return Err(ArtifactError::Empty);
    }
    let sniffed = sniff(&filename, &bytes)?;
    if sniffed.text
        && meta.secret_ack != Some(true)
        && looks_like_secret(&String::from_utf8_lossy(&bytes))
    {
        return Err(ArtifactError::PossibleSecret);
    }
    Ok(Upload {
        filename: upload_name(&filename),
        content_type: sniffed.content_type,
        bytes,
        meta,
    })
}

/// `POST {base}/api/artifacts` as `multipart/form-data`: `meta` (JSON) and
/// `file` (the bytes; its name carries the extension only).
pub async fn send_upload(
    base: &str,
    session_token: &str,
    upload: Upload,
) -> Result<ArtifactResponse, ArtifactError> {
    let meta = serde_json::to_string(&upload.meta).map_err(|_| ArtifactError::RequestInvalid)?;
    let meta_part = reqwest::multipart::Part::text(meta)
        .mime_str("application/json")
        .map_err(|_| ArtifactError::RequestInvalid)?;
    let file_part = reqwest::multipart::Part::bytes(upload.bytes)
        .file_name(upload.filename)
        .mime_str(upload.content_type)
        .map_err(|_| ArtifactError::RequestInvalid)?;
    let form = reqwest::multipart::Form::new()
        .part("meta", meta_part)
        .part("file", file_part);
    let response = client(UPLOAD_TIMEOUT)?
        .post(format!("{}{API_ARTIFACTS}", base.trim_end_matches('/')))
        .bearer_auth(session_token)
        .header(reqwest::header::ACCEPT, "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|_| ArtifactError::Offline)?;
    read_reply(response).await
}

// ------------------------------------------------------------ commands --

#[tauri::command]
pub async fn artifacts_request(
    profile_id: String,
    method: String,
    path: String,
) -> Result<ArtifactResponse, ArtifactError> {
    if !crate::profile::is_known_profile_id(&profile_id)
        || !route_allowed(&profile_id, &method, &path)
    {
        return Err(ArtifactError::RequestInvalid);
    }
    let base = crate::device_flow::platform_base(&profile_id).ok_or(ArtifactError::Unavailable)?;
    let token = crate::chat::read_session_token(&profile_id).ok_or(ArtifactError::NoSession)?;
    send(&base, &token, &profile_id, &method, &path).await
}

#[tauri::command]
pub async fn artifact_share(
    app: AppHandle,
    profile_id: String,
    source: ShareSource,
    meta: ShareMeta,
) -> Result<ArtifactResponse, ArtifactError> {
    if !crate::profile::is_known_profile_id(&profile_id) {
        return Err(ArtifactError::RequestInvalid);
    }
    let base = crate::device_flow::platform_base(&profile_id).ok_or(ArtifactError::Unavailable)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| ArtifactError::Unavailable)?;
    // Per-user realms: the grants are the signed-in user's (same scoping
    // as `preview_read_file`); `dir` stays the app-data root so the
    // app-data protection and the shared images folder still apply.
    // R20-D: a file in this run's session folders (a website the assistant
    // built) is shareable like any granted file.
    let session = crate::preview::app_session_grant(&app, &profile_id);
    let upload = {
        let profile_id = profile_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let store = crate::preview::realm_grants_in(&dir, &profile_id)
                .map_err(|rej| ArtifactError::SourceRefused { reason: rej.kind })?;
            let store = crate::preview::with_session_grant(store, session);
            let home = std::env::home_dir();
            prepare_upload(&store, &profile_id, &source, meta, &dir, home.as_deref())
        })
        .await
        .map_err(|_| ArtifactError::SourceRefused {
            reason: "io".into(),
        })??
    };
    let token = crate::chat::read_session_token(&profile_id).ok_or(ArtifactError::NoSession)?;
    send_upload(&base, &token, upload).await
}

// ---------------------------------------------------------------- tests --

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::tools::grants;
    use std::fs;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::path::PathBuf;

    const UUID: &str = "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e";

    // -------------------------------------------------- total count --

    #[test]
    fn total_count_reads_only_plain_integers() {
        use reqwest::header::{HeaderMap, HeaderValue};
        let with = |v: &'static str| {
            let mut h = HeaderMap::new();
            h.insert("X-Total-Count", HeaderValue::from_static(v));
            total_count(&h)
        };
        assert_eq!(with("42"), Some(42));
        assert_eq!(with("0"), Some(0));
        for bad in ["", "-1", " 3", "3 ", "1e3", "abc", "99999999999999999999"] {
            assert_eq!(with(bad), None, "{bad:?}");
        }
        assert_eq!(total_count(&HeaderMap::new()), None);
    }

    #[test]
    fn response_omits_total_when_absent_and_forwards_it_when_present() {
        let without = serde_json::to_value(ArtifactResponse {
            status: 200,
            body: serde_json::Value::Null,
            total: None,
        })
        .expect("json");
        assert!(without.get("total").is_none());
        let with = serde_json::to_value(ArtifactResponse {
            status: 200,
            body: serde_json::json!({"artifacts": []}),
            total: Some(7),
        })
        .expect("json");
        assert_eq!(with["total"], 7);
    }

    // ------------------------------------------------------- routes --

    #[test]
    fn route_allowlist_is_closed_and_per_profile() {
        for profile in ["nan", "helmcode"] {
            assert!(route_allowed(profile, "GET", "/api/auth/me"));
            assert!(route_allowed(profile, "GET", "/api/artifacts"));
            assert!(route_allowed(
                profile,
                "DELETE",
                &format!("/api/artifacts/{UUID}")
            ));
        }
        // Enterprise only.
        for (method, path) in [
            ("GET", "/api/admin/artifacts".to_string()),
            ("DELETE", format!("/api/admin/artifacts/{UUID}")),
            ("GET", "/api/members".to_string()),
        ] {
            assert!(route_allowed("helmcode", method, &path), "{method} {path}");
            assert!(!route_allowed("nan", method, &path), "{method} {path}");
        }
        // Everything else is refused.
        for (method, path) in [
            ("POST", "/api/artifacts".to_string()),
            ("PUT", format!("/api/artifacts/{UUID}")),
            ("PATCH", format!("/api/artifacts/{UUID}")),
            ("GET", format!("/api/artifacts/{UUID}")),
            ("DELETE", "/api/artifacts".to_string()),
            ("DELETE", "/api/artifacts/../skills".to_string()),
            ("DELETE", format!("/api/artifacts/{}", UUID.to_uppercase())),
            ("DELETE", format!("/api/artifacts/{UUID}/x")),
            ("DELETE", format!("/api/artifacts/{UUID}?x=1")),
            ("GET", "/api/artifacts?all=1".to_string()),
            ("GET", "/api/skills".to_string()),
            ("GET", "/v1/chat/completions".to_string()),
            ("GET", "https://evil.example/api/artifacts".to_string()),
            ("GET", "/api/artifacts/".to_string()),
            ("get", "/api/artifacts".to_string()),
        ] {
            assert!(!route_allowed("helmcode", method, &path), "{method} {path}");
            assert!(!route_allowed("nan", method, &path), "{method} {path}");
        }
    }

    #[test]
    fn artifact_ids_are_lowercase_uuids_only() {
        assert!(is_valid_artifact_id(UUID));
        assert!(!is_valid_artifact_id(""));
        assert!(!is_valid_artifact_id(&UUID[..35]));
        assert!(!is_valid_artifact_id(&format!("{UUID}0")));
        assert!(!is_valid_artifact_id(
            "0b9c6f1e/2d3a-4b5c-8d7e-9f0a1b2c3d4e"
        ));
        assert!(!is_valid_artifact_id(
            "zb9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e"
        ));
    }

    // --------------------------------------------------------- meta --

    fn meta(scope: &str) -> ShareMeta {
        ShareMeta {
            title: "Report".into(),
            scope: scope.into(),
            emails: vec![],
            member_ids: vec![],
            expires_days: Some(7),
            notify: false,
            risk_ack: None,
            secret_ack: None,
        }
    }

    fn ack(kind: &str) -> Option<RiskAck> {
        Some(RiskAck {
            kind: kind.into(),
            version: RISK_VERSION.into(),
        })
    }

    #[test]
    fn meta_rejects_unknown_fields() {
        let parsed: Result<ShareMeta, _> = serde_json::from_value(serde_json::json!({
            "title": "x", "scope": "public", "expires_days": 7, "path": "/etc/passwd"
        }));
        assert!(parsed.is_err());
        let parsed: Result<ShareMeta, _> = serde_json::from_value(serde_json::json!({
            "title": "x", "scope": "public", "expires_days": 7,
            "risk_ack": {"kind": "public", "version": RISK_VERSION, "extra": true}
        }));
        assert!(parsed.is_err());
        let parsed: Result<ShareSource, _> =
            serde_json::from_value(serde_json::json!({"kind": "file", "path": "/a", "url": "x"}));
        assert!(parsed.is_err());
    }

    #[test]
    fn scopes_follow_the_profile() {
        assert!(scope_allowed("helmcode", "members"));
        assert!(scope_allowed("helmcode", "org"));
        assert!(!scope_allowed("nan", "members"));
        assert!(!scope_allowed("nan", "org"));
        assert!(!scope_allowed("helmcode", "everyone"));
        let mut m = meta("org");
        m.expires_days = Some(30);
        assert_eq!(
            checked_meta("nan", m.clone(), "a.pdf"),
            Err(ArtifactError::RequestInvalid)
        );
        assert!(checked_meta("helmcode", m, "a.pdf").is_ok());
    }

    /// Server contract (ARTIFACTS.md 3.5): null/absent = scope DEFAULT, 0 =
    /// never (members/org only). "Sin caducidad" must go out as integer 0.
    #[test]
    fn expiry_follows_the_server_contract() {
        let with = |scope: &str, days: Option<i64>| {
            let mut m = meta(scope);
            m.expires_days = days;
            match scope {
                "emails" => m.emails = vec!["ana@acme.com".into()],
                "members" => m.member_ids = vec!["u1".into()],
                "public" => m.risk_ack = ack("public"),
                _ => {}
            }
            checked_meta("helmcode", m, "a.pdf")
        };
        // 0 = never: members/org only, and it reaches the wire as integer 0.
        for scope in ["members", "org"] {
            let wire = with(scope, Some(0)).expect("never is offered");
            assert_eq!(wire.expires_days, NO_EXPIRY);
            let json = serde_json::to_value(&wire).unwrap();
            assert_eq!(json["expires_days"], serde_json::json!(0));
            assert!(json["expires_days"].is_u64());
        }
        // Positive options pass through as numbers.
        for (scope, days) in [("public", 7), ("emails", 90), ("members", 30), ("org", 7)] {
            let json = serde_json::to_value(with(scope, Some(days)).unwrap()).unwrap();
            assert_eq!(json["expires_days"], serde_json::json!(days));
        }
        // emails/public need a positive number: 0 is refused.
        for scope in ["emails", "public"] {
            assert_eq!(with(scope, Some(0)), Err(ArtifactError::RequestInvalid));
        }
        // null/absent (= silent server default) and negatives are refused everywhere.
        for scope in ["emails", "public", "members", "org"] {
            assert_eq!(with(scope, None), Err(ArtifactError::RequestInvalid));
            assert_eq!(with(scope, Some(-1)), Err(ArtifactError::RequestInvalid));
            assert_eq!(with(scope, Some(-90)), Err(ArtifactError::RequestInvalid));
        }
        // Options outside the policy stay refused.
        assert_eq!(with("public", Some(90)), Err(ArtifactError::RequestInvalid));
        assert_eq!(with("org", Some(1)), Err(ArtifactError::RequestInvalid));
        assert_eq!(
            with("org", Some(i64::from(u32::MAX) + 1)),
            Err(ArtifactError::RequestInvalid)
        );
        // From the renderer's JSON: explicit null and absence both refused.
        for raw in [
            serde_json::json!({"title": "x", "scope": "org", "expires_days": null}),
            serde_json::json!({"title": "x", "scope": "org"}),
        ] {
            let m: ShareMeta = serde_json::from_value(raw).expect("parses");
            assert_eq!(
                checked_meta("helmcode", m, "a.pdf"),
                Err(ArtifactError::RequestInvalid)
            );
        }
        let m: ShareMeta = serde_json::from_value(
            serde_json::json!({"title": "x", "scope": "org", "expires_days": 0}),
        )
        .unwrap();
        assert_eq!(
            checked_meta("helmcode", m, "a.pdf").unwrap().expires_days,
            0
        );
    }

    #[test]
    fn expiry_options_and_caps_per_scope() {
        assert!(expiry_allowed("public", Some(30)));
        assert!(!expiry_allowed("public", Some(90)));
        assert!(!expiry_allowed("public", None));
        assert!(expiry_allowed("emails", Some(90)));
        assert!(!expiry_allowed("emails", Some(365)));
        assert!(!expiry_allowed("emails", None));
        assert!(!expiry_allowed("members", None));
        assert!(expiry_allowed("members", Some(0)));
        assert!(!expiry_allowed("members", Some(-7)));
        assert!(expiry_allowed("org", Some(90)));
        assert!(!expiry_allowed("org", Some(1)));
        assert!(!expiry_allowed("emails", Some(0)));
    }

    #[test]
    fn public_always_needs_a_matching_versioned_ack() {
        for profile in ["nan", "helmcode"] {
            assert_eq!(
                checked_meta(profile, meta("public"), "a.pdf"),
                Err(ArtifactError::RiskAckRequired)
            );
            let mut m = meta("public");
            m.risk_ack = ack("external");
            assert_eq!(
                checked_meta(profile, m, "a.pdf"),
                Err(ArtifactError::RiskAckRequired)
            );
            let mut m = meta("public");
            m.risk_ack = Some(RiskAck {
                kind: "public".into(),
                version: "artifacts-risk-v0".into(),
            });
            assert_eq!(
                checked_meta(profile, m, "a.pdf"),
                Err(ArtifactError::RiskAckRequired)
            );
            let mut m = meta("public");
            m.risk_ack = ack("public");
            assert!(checked_meta(profile, m, "a.pdf").is_ok());
        }
    }

    #[test]
    fn community_emails_always_need_the_external_ack() {
        let mut m = meta("emails");
        m.emails = vec!["Ana@Example.com".into()];
        assert_eq!(
            checked_meta("nan", m.clone(), "a.pdf"),
            Err(ArtifactError::RiskAckRequired)
        );
        m.risk_ack = ack("external");
        let wire = checked_meta("nan", m, "a.pdf").expect("ok");
        assert_eq!(wire.emails, vec!["ana@example.com".to_string()]);
    }

    #[test]
    fn enterprise_emails_leave_externality_to_the_server() {
        let mut m = meta("emails");
        m.emails = vec!["ana@acme.com".into()];
        assert!(checked_meta("helmcode", m.clone(), "a.pdf").is_ok());
        m.risk_ack = ack("external");
        assert!(checked_meta("helmcode", m.clone(), "a.pdf").is_ok());
        m.risk_ack = ack("public");
        assert_eq!(
            checked_meta("helmcode", m, "a.pdf"),
            Err(ArtifactError::RiskAckRequired)
        );
        let mut m = meta("org");
        m.expires_days = Some(0);
        m.risk_ack = ack("external");
        assert_eq!(
            checked_meta("helmcode", m, "a.pdf"),
            Err(ArtifactError::RiskAckRequired)
        );
    }

    #[test]
    fn recipients_are_validated_deduplicated_and_capped() {
        let mut m = meta("emails");
        m.risk_ack = ack("external");
        m.emails = vec!["a@x.io".into(), " A@X.IO ".into(), "b@y.io".into()];
        assert_eq!(
            checked_meta("nan", m.clone(), "f.pdf").expect("ok").emails,
            vec!["a@x.io".to_string(), "b@y.io".to_string()]
        );
        m.emails = vec![];
        assert_eq!(
            checked_meta("nan", m.clone(), "f.pdf"),
            Err(ArtifactError::RequestInvalid)
        );
        m.emails = (0..=MAX_RECIPIENTS).map(|i| format!("u{i}@x.io")).collect();
        assert_eq!(
            checked_meta("nan", m.clone(), "f.pdf"),
            Err(ArtifactError::RequestInvalid)
        );
        for bad in [
            "nope", "a@b", "a b@x.io", "a@x..io", "<a@x.io>", "a\n@x.io", "ä@x.io", "a@-",
        ] {
            m.emails = vec![bad.into()];
            assert_eq!(
                checked_meta("nan", m.clone(), "f.pdf"),
                Err(ArtifactError::RequestInvalid),
                "{bad}"
            );
        }
        // Emails never ride along with another scope.
        let mut p = meta("public");
        p.risk_ack = ack("public");
        p.emails = vec!["a@x.io".into()];
        assert_eq!(
            checked_meta("nan", p, "f.pdf"),
            Err(ArtifactError::RequestInvalid)
        );
        // Members: ids only, at least one, safe charset.
        let mut mm = meta("members");
        assert_eq!(
            checked_meta("helmcode", mm.clone(), "f.pdf"),
            Err(ArtifactError::RequestInvalid)
        );
        mm.member_ids = vec!["u-1".into(), "u-1".into()];
        assert_eq!(
            checked_meta("helmcode", mm.clone(), "f.pdf")
                .expect("ok")
                .member_ids,
            vec!["u-1"]
        );
        mm.member_ids = vec!["../x".into()];
        assert_eq!(
            checked_meta("helmcode", mm, "f.pdf"),
            Err(ArtifactError::RequestInvalid)
        );
    }

    #[test]
    fn title_defaults_to_the_file_name_and_is_capped() {
        let mut m = meta("org");
        m.expires_days = Some(30);
        m.title = "   ".into();
        assert_eq!(
            checked_meta("helmcode", m.clone(), "q3.pdf")
                .expect("ok")
                .title,
            "q3.pdf"
        );
        m.title = "x".repeat(MAX_TITLE_CHARS);
        assert!(checked_meta("helmcode", m.clone(), "q3.pdf").is_ok());
        m.title = "x".repeat(MAX_TITLE_CHARS + 1);
        assert_eq!(
            checked_meta("helmcode", m.clone(), "q3.pdf"),
            Err(ArtifactError::RequestInvalid)
        );
        m.title = "a\u{0007}b".into();
        assert_eq!(
            checked_meta("helmcode", m, "q3.pdf"),
            Err(ArtifactError::RequestInvalid)
        );
    }

    #[test]
    fn notify_only_travels_with_recipients() {
        let mut m = meta("public");
        m.risk_ack = ack("public");
        m.notify = true;
        assert!(!checked_meta("nan", m, "f.pdf").expect("ok").notify);
        let mut m = meta("emails");
        m.emails = vec!["a@x.io".into()];
        m.risk_ack = ack("external");
        m.notify = true;
        assert!(checked_meta("nan", m, "f.pdf").expect("ok").notify);
    }

    // -------------------------------------------------- sniff / scan --

    #[test]
    fn sniff_needs_extension_and_magic_bytes_to_agree() {
        let png = b"\x89PNG\r\n\x1a\n rest";
        assert_eq!(sniff("a.png", png).expect("png").content_type, "image/png");
        assert_eq!(sniff("a.PNG", png).expect("png").content_type, "image/png");
        assert_eq!(sniff("a.jpg", png), Err(ArtifactError::UnsupportedType));
        assert_eq!(
            sniff("a.pdf", b"%PDF-1.7 x").expect("pdf").content_type,
            "application/pdf"
        );
        assert_eq!(
            sniff("a.pdf", b"<html>"),
            Err(ArtifactError::UnsupportedType)
        );
        assert_eq!(
            sniff("a.jpeg", &[0xFF, 0xD8, 0xFF, 0xE0])
                .expect("jpg")
                .content_type,
            "image/jpeg"
        );
        assert_eq!(
            sniff("a.webp", b"RIFF\0\0\0\0WEBPVP8 ")
                .expect("webp")
                .content_type,
            "image/webp"
        );
        assert_eq!(
            sniff("a.gif", b"GIF89a...").expect("gif").content_type,
            "image/gif"
        );
        let md = sniff("a.md", "# Título\n".as_bytes()).expect("md");
        assert!(md.text);
        assert_eq!(md.content_type, "text/markdown");
        assert!(sniff("a.html", b"<p>hi</p>").expect("html").text);
        assert!(sniff("a.csv", b"\xEF\xBB\xBFa,b\n1,2").expect("csv").text);
        assert_eq!(
            sniff("a.txt", b"bin\0ary"),
            Err(ArtifactError::UnsupportedType)
        );
        assert_eq!(
            sniff("a.txt", b"\xff\xfe"),
            Err(ArtifactError::UnsupportedType)
        );
        assert!(!sniff("a.docx", b"PK\x03\x04...").expect("docx").text);
        assert!(sniff("a.xlsx", b"PK\x03\x04...").is_ok());
        assert_eq!(
            sniff("a.docx", b"%PDF-"),
            Err(ArtifactError::UnsupportedType)
        );
        for name in [
            "a.exe",
            "a",
            "a.zip",
            "a.png.exe",
            "a.bmp",
            "a.xls",
            "prod.env",
        ] {
            assert_eq!(
                sniff(name, b"PK\x03\x04"),
                Err(ArtifactError::UnsupportedType),
                "{name}"
            );
        }
    }

    /// R20-C: every text kind the preview shows is shareable as plain text
    /// (the servers store md/txt/csv/html only, so the rest travel as
    /// text/plain under a `.txt` upload name); bytes must still be text.
    #[test]
    fn plain_text_family_shares_as_text_plain() {
        for name in [
            "a.json", "a.YAML", "a.log", "a.py", "a.sh", "a.svg", "a.tsv", "a.rs",
        ] {
            let sniffed = sniff(name, b"{\"a\": 1}\n").expect(name);
            assert_eq!(sniffed.content_type, "text/plain", "{name}");
            assert!(sniffed.text, "{name}");
        }
        assert_eq!(
            sniff("a.json", b"bin\0ary"),
            Err(ArtifactError::UnsupportedType)
        );
        // A text name over binary magic (a polyglot) is refused, as the
        // servers do.
        assert_eq!(
            sniff("a.json", b"%PDF-1.7 x"),
            Err(ArtifactError::UnsupportedType)
        );
        assert_eq!(
            sniff("a.txt", b"GIF89a"),
            Err(ArtifactError::UnsupportedType)
        );
        // Credential stores by definition: never.
        assert_eq!(
            sniff("prod.env", b"A=1"),
            Err(ArtifactError::UnsupportedType)
        );
    }

    #[test]
    fn upload_name_carries_an_extension_the_servers_accept() {
        assert_eq!(upload_name("config.json"), "config.json.txt");
        assert_eq!(upload_name("notes.md"), "notes.md");
        assert_eq!(upload_name("a.TXT"), "a.TXT");
        assert_eq!(upload_name("informe.pdf"), "informe.pdf");
        assert_eq!(upload_name("main.PY"), "main.PY.txt");
    }

    #[test]
    fn prepares_a_json_file_as_plain_text_and_scans_it_for_secrets() {
        let l = layout();
        let path = l.grant.join("config.json");
        fs::write(&path, b"{\"name\": \"demo\"}").expect("write");
        let upload = prepare(&l, &file(&path), public_meta()).expect("ok");
        assert_eq!(upload.filename, "config.json.txt");
        assert_eq!(upload.content_type, "text/plain");
        let leaky = l.grant.join("keys.yaml");
        fs::write(&leaky, b"key: sk-abcdefghijklmnop1234").expect("write");
        let err = prepare(&l, &file(&leaky), public_meta()).expect_err("secret");
        assert_eq!(err, ArtifactError::PossibleSecret);
    }

    #[test]
    fn secret_scan_catches_key_shapes_but_not_prose() {
        for text in [
            "key: sk-abcdefghijklmnop1234",
            "sk-hke_0123456789abcdef0123",
            "token ghp_ABCDEFGHIJKLMNOPQRSTUV12",
            "AKIAABCDEFGHIJKLMNOP",
            "-----BEGIN RSA PRIVATE KEY-----\nMII",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
        ] {
            assert!(looks_like_secret(text), "{text}");
        }
        for text in [
            "a risk-free plan with desk-top layout",
            "sk-short",
            "task-abcdefghijklmnopqrstu",
            "-----BEGIN CERTIFICATE-----",
            "AKIA is a prefix",
            "",
        ] {
            assert!(!looks_like_secret(text), "{text}");
        }
    }

    #[test]
    fn file_names_are_base_names_without_quotes_or_controls() {
        assert_eq!(
            sanitize_filename("/home/u/proj/informe-q3.pdf"),
            "informe-q3.pdf"
        );
        assert_eq!(sanitize_filename("C:\\Users\\u\\a.md"), "a.md");
        assert_eq!(sanitize_filename("/x/we\"ird\n'name.txt"), "weirdname.txt");
        assert_eq!(sanitize_filename("/x/"), "");
        let long = format!("/x/{}.pdf", "ñ".repeat(300));
        let clean = sanitize_filename(&long);
        assert!(clean.len() <= MAX_FILENAME_BYTES);
        assert!(clean.ends_with(".pdf"));
    }

    // ---------------------------------------------------- the read --

    struct Layout {
        _guard: tempfile::TempDir,
        app_data: PathBuf,
        home: PathBuf,
        grant: PathBuf,
        outside: PathBuf,
    }

    fn layout() -> Layout {
        let guard = tempfile::tempdir().expect("tempdir");
        let base = fs::canonicalize(guard.path()).expect("canon");
        let home = base.join("home");
        let grant = home.join("proj");
        let app_data = home.join("app-data");
        let outside = base.join("outside");
        for dir in [
            &grant,
            &app_data,
            &outside,
            &crate::images::images_dir(&app_data),
        ] {
            fs::create_dir_all(dir).expect("mkdir");
        }
        Layout {
            _guard: guard,
            app_data,
            home,
            grant,
            outside,
        }
    }

    fn store(l: &Layout) -> GrantsStore {
        let mut store = grants::default_store();
        store
            .add_grant(
                "g0".into(),
                "nan",
                l.grant.clone(),
                "2026-11-14T00:00:00Z".into(),
            )
            .expect("grant");
        store
    }

    fn file(path: &Path) -> ShareSource {
        ShareSource {
            kind: "file".into(),
            path: path.display().to_string(),
        }
    }

    fn public_meta() -> ShareMeta {
        let mut m = meta("public");
        m.risk_ack = ack("public");
        m
    }

    fn prepare(l: &Layout, source: &ShareSource, m: ShareMeta) -> Result<Upload, ArtifactError> {
        prepare_upload(&store(l), "nan", source, m, &l.app_data, Some(&l.home))
    }

    #[test]
    fn prepares_a_granted_file_as_an_exact_snapshot() {
        let l = layout();
        let path = l.grant.join("informe.pdf");
        fs::write(&path, b"%PDF-1.7 body").expect("write");
        let upload = prepare(&l, &file(&path), public_meta()).expect("ok");
        assert_eq!(upload.bytes, b"%PDF-1.7 body");
        assert_eq!(upload.filename, "informe.pdf");
        assert_eq!(upload.content_type, "application/pdf");
        assert_eq!(upload.meta.title, "Report");
    }

    #[test]
    fn refuses_files_outside_the_grants_and_other_profiles() {
        let l = layout();
        let path = l.outside.join("secret.pdf");
        fs::write(&path, b"%PDF-1.7").expect("write");
        let err = prepare(&l, &file(&path), public_meta()).expect_err("outside");
        assert_eq!(err.code(), "source_refused");
        let inside = l.grant.join("ok.pdf");
        fs::write(&inside, b"%PDF-1.7").expect("write");
        let err = prepare_upload(
            &store(&l),
            "helmcode",
            &file(&inside),
            public_meta(),
            &l.app_data,
            Some(&l.home),
        )
        .expect_err("other profile");
        assert_eq!(err.code(), "source_refused");
    }

    /// `artifact_share` minus the AppHandle: the realm's grants (the
    /// `preview::realm_grants_in` seam), then `prepare_upload`.
    fn realm_prepare(l: &Layout, path: &Path) -> Result<Upload, ArtifactError> {
        let store = crate::preview::realm_grants_in(&l.app_data, "nan")
            .map_err(|rej| ArtifactError::SourceRefused { reason: rej.kind })?;
        prepare_upload(
            &store,
            "nan",
            &file(path),
            public_meta(),
            &l.app_data,
            Some(&l.home),
        )
    }

    fn login(root: &Path, user: &str) -> PathBuf {
        let identity = crate::realm::Identity {
            id: user.into(),
            email: Some(format!("{user}@example.com")),
        };
        let (store, _) = crate::realm::bind_login_in(root, "nan", &identity).expect("bind");
        crate::profile::save(root, &store).expect("save");
        crate::realm::dir_for_in(root, "nan").expect("realm")
    }

    #[test]
    fn share_reads_only_the_active_realms_grants() {
        let l = layout();
        let path = l.grant.join("informe.pdf");
        fs::write(&path, b"%PDF-1.7 body").expect("write");
        let refused = |r: Result<Upload, ArtifactError>| match r {
            Err(ArtifactError::SourceRefused { reason }) => reason,
            other => panic!("expected source_refused, got {other:?}"),
        };
        // Signed out: no realm, no grants.
        assert_eq!(refused(realm_prepare(&l, &path)), "protocol");
        // Ana grants the folder in her realm: she can share from it.
        let ana = login(&l.app_data, "ana");
        grants::save(&ana, &store(&l)).expect("save");
        assert_eq!(
            realm_prepare(&l, &path).expect("ana").bytes,
            b"%PDF-1.7 body"
        );
        // Bob on the same profile cannot; a root-level store is ignored.
        login(&l.app_data, "bob");
        grants::save(&l.app_data, &store(&l)).expect("stale root store");
        assert_eq!(refused(realm_prepare(&l, &path)), "no_grant");
        // Ana back: her realm grant resolves again.
        login(&l.app_data, "ana");
        assert!(realm_prepare(&l, &path).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_even_to_granted_files() {
        let l = layout();
        let target = l.outside.join("t.pdf");
        fs::write(&target, b"%PDF-1.7").expect("write");
        let link = l.grant.join("link.pdf");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");
        let err = prepare(&l, &file(&link), public_meta()).expect_err("symlink");
        assert_eq!(err.code(), "source_refused");
    }

    #[test]
    fn refuses_files_over_the_8_mib_cap() {
        let l = layout();
        let path = l.grant.join("big.txt");
        fs::write(&path, vec![b'a'; MAX_ARTIFACT_BYTES as usize + 1]).expect("write");
        assert_eq!(
            prepare(&l, &file(&path), public_meta()),
            Err(ArtifactError::TooLarge)
        );
        fs::write(&path, vec![b'a'; MAX_ARTIFACT_BYTES as usize]).expect("write");
        assert!(prepare(&l, &file(&path), public_meta()).is_ok());
    }

    #[test]
    fn refuses_empty_unsupported_and_mismatched_files() {
        let l = layout();
        let empty = l.grant.join("empty.txt");
        fs::write(&empty, b"").expect("write");
        assert_eq!(
            prepare(&l, &file(&empty), public_meta()),
            Err(ArtifactError::Empty)
        );
        let exe = l.grant.join("tool.exe");
        fs::write(&exe, b"MZ").expect("write");
        assert_eq!(
            prepare(&l, &file(&exe), public_meta()),
            Err(ArtifactError::UnsupportedType)
        );
        let fake = l.grant.join("fake.png");
        fs::write(&fake, b"%PDF-1.7").expect("write");
        assert_eq!(
            prepare(&l, &file(&fake), public_meta()),
            Err(ArtifactError::UnsupportedType)
        );
    }

    #[test]
    fn metadata_is_checked_before_the_disk_is_touched() {
        let l = layout();
        let missing = l.outside.join("missing.pdf");
        // Invalid meta wins over an unreadable source: no read happens.
        assert_eq!(
            prepare(&l, &file(&missing), meta("public")),
            Err(ArtifactError::RiskAckRequired)
        );
        let mut m = public_meta();
        m.scope = "org".into();
        assert_eq!(
            prepare(&l, &file(&missing), m),
            Err(ArtifactError::RequestInvalid)
        );
    }

    #[test]
    fn a_credential_in_text_needs_the_secret_ack() {
        let l = layout();
        let path = l.grant.join("notes.md");
        fs::write(&path, b"# Notes\nkey sk-abcdefghijklmnop1234\n").expect("write");
        assert_eq!(
            prepare(&l, &file(&path), public_meta()),
            Err(ArtifactError::PossibleSecret)
        );
        let mut m = public_meta();
        m.secret_ack = Some(true);
        let upload = prepare(&l, &file(&path), m).expect("acked");
        assert_eq!(upload.meta.secret_ack, Some(true));
        // Binary types are never scanned (the server owns that call).
        let pdf = l.grant.join("a.pdf");
        fs::write(&pdf, b"%PDF-1.7 sk-abcdefghijklmnop1234").expect("write");
        assert!(prepare(&l, &file(&pdf), public_meta()).is_ok());
    }

    #[test]
    fn media_sources_are_only_generated_images() {
        let l = layout();
        let image = crate::images::images_dir(&l.app_data).join("gen.png");
        fs::write(&image, b"\x89PNG\r\n\x1a\nxx").expect("write");
        let media = |path: &Path| ShareSource {
            kind: "media".into(),
            path: path.display().to_string(),
        };
        let upload = prepare(&l, &media(&image), public_meta()).expect("ok");
        assert_eq!(upload.content_type, "image/png");
        let elsewhere = l.outside.join("x.png");
        fs::write(&elsewhere, b"\x89PNG\r\n\x1a\nxx").expect("write");
        assert_eq!(
            prepare(&l, &media(&elsewhere), public_meta())
                .expect_err("x")
                .code(),
            "source_refused"
        );
        let other = ShareSource {
            kind: "web".into(),
            path: image.display().to_string(),
        };
        assert_eq!(
            prepare(&l, &other, public_meta()),
            Err(ArtifactError::RequestInvalid)
        );
    }

    // --------------------------------------------------- the wire --

    /// Serve one (status, body) reply; return the raw request.
    pub(crate) fn mock_server(
        status: u16,
        body: String,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        mock_server_with(status, "", body)
    }

    /// [`mock_server`] with extra raw header lines (each ending in CRLF).
    pub(crate) fn mock_server_with(
        status: u16,
        extra_headers: &'static str,
        body: String,
    ) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = Vec::new();
            let mut chunk = [0u8; 65536];
            loop {
                let n = stream.read(&mut chunk).expect("read");
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{extra_headers}content-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).expect("write");
            buf
        });
        (base, handle)
    }

    const TOKEN: &str = "jwt-canary-ZZ9";

    #[test]
    fn upload_speaks_the_multipart_contract_with_the_bearer() {
        let l = layout();
        let path = l.grant.join("informe-q3.pdf");
        fs::write(&path, b"%PDF-1.7 the-report-bytes").expect("write");
        let mut m = meta("emails");
        m.emails = vec!["Ana@Acme.com".into()];
        m.risk_ack = ack("external");
        m.notify = true;
        m.expires_days = Some(30);
        let upload = prepare(&l, &file(&path), m).expect("ok");
        let reply = r#"{"artifact":{"id":"0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e","title":"Report"},"url":"https://share.nan.builders/a/tok"}"#;
        let (base, server) = mock_server(201, reply.into());
        let response =
            tauri::async_runtime::block_on(send_upload(&base, TOKEN, upload)).expect("sent");
        assert_eq!(response.status, 201);
        assert_eq!(response.body["url"], "https://share.nan.builders/a/tok");
        let raw = String::from_utf8_lossy(&server.join().expect("join")).to_string();
        let lower = raw.to_ascii_lowercase();
        assert!(raw.starts_with("POST /api/artifacts HTTP/1.1"), "{raw}");
        assert!(lower.contains(&format!(
            "authorization: bearer {}",
            TOKEN.to_ascii_lowercase()
        )));
        assert!(lower.contains("content-type: multipart/form-data; boundary="));
        assert!(raw.contains("name=\"meta\""));
        assert!(raw.contains("name=\"file\"; filename=\"informe-q3.pdf\""));
        assert!(raw.contains("Content-Type: application/pdf"));
        assert!(raw.contains("%PDF-1.7 the-report-bytes"));
        // The meta is the normalized wire shape, nothing more.
        let start = raw.find("{\"title\"").expect("meta json");
        let end = start + raw[start..].find("\r\n").expect("end");
        let sent: serde_json::Value = serde_json::from_str(&raw[start..end]).expect("json");
        assert_eq!(
            sent,
            serde_json::json!({
                "title": "Report", "scope": "emails", "emails": ["ana@acme.com"],
                "member_ids": [], "expires_days": 30, "notify": true,
                "risk_ack": {"kind": "external", "version": RISK_VERSION}
            })
        );
        // The local path never leaves the machine.
        assert!(!raw.contains(&l.grant.display().to_string()));
    }

    #[test]
    fn owner_calls_carry_the_bearer_and_no_body() {
        let (base, server) = mock_server(200, r#"{"artifacts":[]}"#.into());
        let response = tauri::async_runtime::block_on(send(
            &base,
            TOKEN,
            "nan",
            "DELETE",
            &format!("/api/artifacts/{UUID}"),
        ))
        .expect("sent");
        assert_eq!(response.status, 200);
        let raw = String::from_utf8_lossy(&server.join().expect("join")).to_string();
        assert!(raw.starts_with(&format!("DELETE /api/artifacts/{UUID} HTTP/1.1")));
        assert!(
            raw.to_ascii_lowercase()
                .contains("authorization: bearer jwt-canary-zz9")
        );
        assert!(raw.ends_with("\r\n\r\n"), "no body: {raw}");
    }

    #[test]
    fn list_reply_forwards_the_total_count_header() {
        // Enterprise pages the list: `{artifacts, total}` + X-Total-Count.
        let (base, server) = mock_server_with(
            200,
            "X-Total-Count: 57\r\n",
            r#"{"artifacts":[],"total":57}"#.into(),
        );
        let response =
            tauri::async_runtime::block_on(send(&base, TOKEN, "helmcode", "GET", "/api/artifacts"))
                .expect("sent");
        assert_eq!(response.total, Some(57));
        let _ = server.join();
        // Community sends no header: nothing is forwarded.
        let (base, server) = mock_server(200, r#"{"artifacts":[]}"#.into());
        let response =
            tauri::async_runtime::block_on(send(&base, TOKEN, "nan", "GET", "/api/artifacts"))
                .expect("sent");
        assert_eq!(response.total, None);
        let _ = server.join();
    }

    #[test]
    fn refused_routes_never_reach_the_network() {
        // An unroutable base would fail as offline; a refusal comes first.
        let err = tauri::async_runtime::block_on(send(
            "http://127.0.0.1:9",
            TOKEN,
            "nan",
            "GET",
            "/api/members",
        ))
        .expect_err("refused");
        assert_eq!(err, ArtifactError::RequestInvalid);
    }

    #[test]
    fn oversized_and_non_json_replies() {
        let big = format!("\"{}\"", "a".repeat(MAX_RESPONSE_BYTES + 10));
        let (base, server) = mock_server(200, big);
        let err =
            tauri::async_runtime::block_on(send(&base, TOKEN, "nan", "GET", "/api/artifacts"))
                .expect_err("too big");
        assert_eq!(err, ArtifactError::Offline);
        let _ = server.join();
        let (base, server) = mock_server(502, "<html>bad gateway</html>".into());
        let response =
            tauri::async_runtime::block_on(send(&base, TOKEN, "nan", "GET", "/api/artifacts"))
                .expect("reply");
        assert_eq!(response.status, 502);
        assert_eq!(response.body, serde_json::Value::Null);
        let _ = server.join();
    }

    #[test]
    fn errors_never_carry_paths_tokens_content_or_links() {
        let l = layout();
        let path = l.grant.join("notes.md");
        let canary = "sk-hke_CANARYCANARYCANARY123";
        fs::write(&path, format!("# x\n{canary}\n")).expect("write");
        let mut all = vec![
            prepare(&l, &file(&path), public_meta()).expect_err("secret"),
            prepare(&l, &file(&l.outside.join("nope.pdf")), public_meta()).expect_err("outside"),
        ];
        all.extend([
            ArtifactError::RequestInvalid,
            ArtifactError::Unavailable,
            ArtifactError::NoSession,
            ArtifactError::Offline,
            ArtifactError::TooLarge,
            ArtifactError::UnsupportedType,
            ArtifactError::Empty,
            ArtifactError::RiskAckRequired,
        ]);
        for err in all {
            let json = serde_json::to_string(&err).expect("json");
            let debug = format!("{err:?} {err}");
            for text in [&json, &debug] {
                assert!(!text.contains(canary), "{text}");
                assert!(!text.contains("sk-"), "{text}");
                assert!(!text.contains(TOKEN), "{text}");
                assert!(!text.contains(&l.grant.display().to_string()), "{text}");
                assert!(!text.to_ascii_lowercase().contains("bearer"), "{text}");
                assert!(!text.contains("https://"), "{text}");
            }
        }
    }

    #[test]
    fn the_module_never_logs() {
        // No path, content, token or link can reach a log line if there is
        // no log call at all in the non-test code.
        let source = include_str!("artifacts.rs");
        let code = source.split("#[cfg(test)]").next().expect("code");
        for call in [
            "println!",
            "eprintln!",
            "dbg!",
            "log::",
            "tracing::",
            "print!(",
        ] {
            assert!(!code.contains(call), "artifacts.rs must not log ({call})");
        }
    }
}
