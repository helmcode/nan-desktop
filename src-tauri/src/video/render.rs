//! MP4 export (R-V1, contract §2): the desktop's side of the platform's
//! render service. Rendering happens ONLY on the tenant's servers.
//!
//! - The bundle is a deterministic, stored (uncompressed) zip of the
//!   project (everything but `exports/`), built in memory and checked
//!   against [`MAX_BUNDLE_BYTES`] (90 MiB, the upload body limit) BEFORE
//!   anything is sent.
//! - The routes are a closed set ([`Route`]) on the profile's platform base,
//!   always with the session JWT read in the core: the renderer names a
//!   project and a render id, never a URL, a route or a token.
//! - The status the renderer sees never includes the presigned download
//!   URL: [`download`] asks for a fresh status and streams the MP4 itself
//!   (https only, no credentials, redirects re-checked, size-capped, magic
//!   checked) into the project's `exports/` folder.
//! - Every failure is a typed [`ExportError`] the renderer maps to plain
//!   Spanish/English copy (quota, subscription, size, rate limits...).
//!
//! Nothing here logs: no URL, no token, no project content.

use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::library;
use super::project;

/// The render routes (contract §2), relative to the platform base.
pub const RENDERS: &str = "/v1/desktop/renders";
/// Largest bundle the API accepts (contract amendment: 90 MiB).
pub const MAX_BUNDLE_BYTES: usize = 90 * 1024 * 1024;
/// Largest MP4 downloaded (a 10 minute 1080p60 film fits comfortably).
pub const MAX_MP4_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Largest JSON reply read from the API.
const MAX_REPLY_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The upload window (contract §4: the proxy's read timeout is 600 s).
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Upload chunk (progress granularity).
const UPLOAD_CHUNK: usize = 256 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_REDIRECTS: usize = 3;

/// A typed export failure (the renderer owns the copy).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportError {
    /// `quota_exhausted`, `subscription_required`, `too_large`,
    /// `invalid_project`, `too_many_active`, `rate_limited`, `canceled`,
    /// `upload_failed`, `render_failed`, `timeout`, `not_found`,
    /// `no_session`, `offline`, `server`, `unavailable`, `io`, `invalid`,
    /// `expired`.
    pub kind: String,
    /// Seconds to wait before trying again (429 `Retry-After`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
    /// Render seconds left this period (402 quota).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_seconds: Option<u64>,
    /// When the allowance renews (402 quota), RFC 3339.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub period_end: Option<String>,
}

impl ExportError {
    pub fn new(kind: &str) -> Self {
        Self {
            kind: kind.to_string(),
            retry_after: None,
            remaining_seconds: None,
            period_end: None,
        }
    }
}

impl From<crate::tools::Rejection> for ExportError {
    fn from(rejection: crate::tools::Rejection) -> Self {
        match rejection.kind.as_str() {
            "too_large" => ExportError::new("too_large"),
            "not_found" => ExportError::new("not_found"),
            "invalid" => ExportError::new("invalid_project"),
            _ => ExportError::new("io"),
        }
    }
}

/// The closed set of calls this module makes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Create,
    Status(String),
    Cancel(String),
    Quota,
}

/// A render id as the API issues it: 1..=64 of `[A-Za-z0-9_-]`.
pub fn valid_render_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Route {
    /// `(method, path)`; `None` for an id the API could not have issued.
    pub fn target(&self) -> Option<(reqwest::Method, String)> {
        match self {
            Route::Create => Some((reqwest::Method::POST, RENDERS.to_string())),
            Route::Quota => Some((reqwest::Method::GET, format!("{RENDERS}/quota"))),
            Route::Status(id) if valid_render_id(id) && id != "quota" => {
                Some((reqwest::Method::GET, format!("{RENDERS}/{id}")))
            }
            Route::Cancel(id) if valid_render_id(id) && id != "quota" => {
                Some((reqwest::Method::POST, format!("{RENDERS}/{id}/cancel")))
            }
            _ => None,
        }
    }
}

// ------------------------------------------------------------- bundle --

/// The files of the render bundle, sorted: `video.json`, `index.html`,
/// `theme.css` (if any), every scene and every asset. Never `exports/`.
pub fn bundle_files(dir: &Path) -> Result<Vec<(String, Vec<u8>)>, ExportError> {
    let meta = library::read_meta(dir)?;
    let mut names: Vec<String> = vec!["video.json".into(), "index.html".into(), "theme.css".into()];
    names.extend(
        meta.scenes
            .iter()
            .map(|s| format!("compositions/{}.html", s.id)),
    );
    names.extend(library::list_assets(dir).into_keys());
    names.sort();
    names.dedup();
    let mut files = Vec::new();
    for name in names {
        match library::read_file(dir, &name, library::MAX_ASSET_BYTES)? {
            Some(bytes) => files.push((name, bytes)),
            None if name == "theme.css" => {}
            None => return Err(ExportError::new("invalid_project")),
        }
    }
    Ok(files)
}

/// A deterministic STORED zip (no compression, fixed 1980-01-01 times,
/// UTF-8 names), refusing to grow past `cap` bytes.
pub fn zip_stored(files: &[(String, Vec<u8>)], cap: usize) -> Result<Vec<u8>, ExportError> {
    let too_large = || ExportError::new("too_large");
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    const TIME: u16 = 0;
    const DATE: u16 = (1 << 5) | 1; // 1980-01-01
    const FLAGS: u16 = 1 << 11; // UTF-8 names
    for (name, data) in files {
        let crc = crc32fast::hash(data);
        let size = u32::try_from(data.len()).map_err(|_| too_large())?;
        let offset = u32::try_from(out.len()).map_err(|_| too_large())?;
        let name_len =
            u16::try_from(name.len()).map_err(|_| ExportError::new("invalid_project"))?;
        let mut local = Vec::with_capacity(30 + name.len());
        local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes());
        local.extend_from_slice(&FLAGS.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes()); // stored
        local.extend_from_slice(&TIME.to_le_bytes());
        local.extend_from_slice(&DATE.to_le_bytes());
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&size.to_le_bytes());
        local.extend_from_slice(&size.to_le_bytes());
        local.extend_from_slice(&name_len.to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes());
        local.extend_from_slice(name.as_bytes());
        if out.len() + local.len() + data.len() > cap {
            return Err(too_large());
        }
        out.extend_from_slice(&local);
        out.extend_from_slice(data);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // made by
        central.extend_from_slice(&20u16.to_le_bytes()); // needed
        central.extend_from_slice(&FLAGS.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&TIME.to_le_bytes());
        central.extend_from_slice(&DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&name_len.to_le_bytes());
        central.extend_from_slice(&[0u8; 6]); // extra, comment, disk
        central.extend_from_slice(&[0u8; 2]); // internal attrs
        central.extend_from_slice(&[0u8; 4]); // external attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let count = u16::try_from(files.len()).map_err(|_| too_large())?;
    let central_offset = u32::try_from(out.len()).map_err(|_| too_large())?;
    let central_size = u32::try_from(central.len()).map_err(|_| too_large())?;
    if out.len() + central.len() + 22 > cap {
        return Err(too_large());
    }
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]); // disk numbers
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

/// The `meta` part of the create call (contract §2).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RenderMeta {
    pub duration_s: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub quality: String,
    pub title: String,
}

/// Validate the project for export and build `(meta, bundle)`.
pub fn prepare(dir: &Path, quality: &str) -> Result<(RenderMeta, Vec<u8>), ExportError> {
    if !matches!(quality, "standard" | "draft") {
        return Err(ExportError::new("invalid"));
    }
    let meta = library::read_meta(dir)?;
    let assets = library::list_assets(dir);
    project::validate_meta(&meta, &|rel| assets.contains_key(rel))
        .map_err(|_| ExportError::new("invalid_project"))?;
    // The same checks as the preview: every scene passes the rules.
    super::preview::assemble_project(dir).map_err(ExportError::from)?;
    let files = bundle_files(dir)?;
    let bundle = zip_stored(&files, MAX_BUNDLE_BYTES)?;
    let (width, height) = meta.aspect.size();
    Ok((
        RenderMeta {
            duration_s: meta.duration(),
            width,
            height,
            fps: meta.fps,
            quality: quality.to_string(),
            title: meta.title.clone(),
        },
        bundle,
    ))
}

// --------------------------------------------------------------- HTTP --

/// What the create call returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Started {
    pub render_id: String,
    pub charge_seconds: u64,
}

/// The status as the renderer sees it (no download URL).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub status: String,
    pub progress: f64,
    pub error: Option<String>,
    /// The MP4 is ready to download.
    pub ready: bool,
    pub size_bytes: Option<u64>,
    pub expires_at: Option<String>,
    /// Seconds this render costs (refunded when it fails or is canceled).
    pub charge_seconds: Option<u64>,
}

/// The monthly allowance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quota {
    pub included_seconds: u64,
    pub used_seconds: u64,
    pub remaining_seconds: u64,
    pub period_end: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StatusWire {
    status: String,
    #[serde(default)]
    progress: Option<f64>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    download_url: Option<String>,
    #[serde(default)]
    size_bytes: Option<u64>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    charge_seconds: Option<u64>,
}

const STATUSES: &[&str] = &["queued", "rendering", "done", "failed", "canceled"];
const RENDER_ERRORS: &[&str] = &["render_failed", "timeout", "invalid_project"];

fn status_from(wire: StatusWire) -> Result<(Status, Option<String>), ExportError> {
    if !STATUSES.contains(&wire.status.as_str()) {
        return Err(ExportError::new("server"));
    }
    let error = wire.error.map(|e| {
        if RENDER_ERRORS.contains(&e.as_str()) {
            e
        } else {
            "render_failed".into()
        }
    });
    let url = wire.download_url.filter(|_| wire.status == "done");
    Ok((
        Status {
            ready: url.is_some(),
            progress: wire
                .progress
                .filter(|p| p.is_finite())
                .unwrap_or(0.0)
                .clamp(0.0, 1.0),
            status: wire.status,
            error,
            size_bytes: wire.size_bytes,
            expires_at: wire.expires_at,
            charge_seconds: wire.charge_seconds,
        },
        url,
    ))
}

/// A non-2xx reply as a typed error (contract §2 and §4). `route` matters
/// for 404: the enterprise API answers a missing credential with 404, so on
/// the create and quota routes (which never name a render) a 404 means
/// "sign in again"; on a render's own routes it means the render is gone.
pub fn classify(
    route: &Route,
    status: u16,
    body: &serde_json::Value,
    retry_after: Option<u64>,
) -> ExportError {
    let code = body.get("error").and_then(|e| e.as_str()).unwrap_or("");
    let mut err = match (status, code) {
        (401, _) => ExportError::new("no_session"),
        (402, "render_quota_exhausted") => ExportError::new("quota_exhausted"),
        (402, _) => ExportError::new("subscription_required"),
        (404, _) if matches!(route, Route::Create | Route::Quota) => ExportError::new("no_session"),
        (404, _) => ExportError::new("not_found"),
        (409, _) => ExportError::new("canceled"),
        (413, _) => ExportError::new("too_large"),
        (422, _) => ExportError::new("invalid_project"),
        (429, "too_many_active_renders") => ExportError::new("too_many_active"),
        (429, _) => ExportError::new("rate_limited"),
        (400, "upload_failed") => ExportError::new("upload_failed"),
        (400, _) => ExportError::new("invalid_project"),
        (503, "busy") => ExportError::new("busy"),
        (503, _) => ExportError::new("unavailable"),
        _ => ExportError::new("server"),
    };
    if status == 429 || status == 503 {
        err.retry_after = retry_after.map(|s| s.min(24 * 60 * 60));
    }
    if err.kind == "quota_exhausted" {
        err.remaining_seconds = body.get("remaining_seconds").and_then(|v| v.as_u64());
        err.period_end = body
            .get("period_end")
            .and_then(|v| v.as_str())
            .filter(|s| s.len() <= 40)
            .map(str::to_string);
    }
    err
}

fn client(timeout: Duration) -> Result<reqwest::Client, ExportError> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ExportError::new("offline"))
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let raw = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    raw.trim().parse().ok()
}

/// Send one call and read its JSON reply (or the typed error).
async fn call(
    base: &str,
    token: &str,
    route: &Route,
    body: Option<reqwest::multipart::Form>,
) -> Result<(u16, serde_json::Value), ExportError> {
    use futures_util::StreamExt as _;
    let (method, path) = route.target().ok_or_else(|| ExportError::new("invalid"))?;
    let timeout = if body.is_some() {
        UPLOAD_TIMEOUT
    } else {
        REQUEST_TIMEOUT
    };
    let mut request = client(timeout)?
        .request(method, format!("{}{path}", base.trim_end_matches('/')))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(form) = body {
        request = request.multipart(form);
    }
    let response = request
        .send()
        .await
        .map_err(|_| ExportError::new("offline"))?;
    let status = response.status().as_u16();
    let wait = retry_after(response.headers());
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ExportError::new("offline"))?;
        if bytes.len() + chunk.len() > MAX_REPLY_BYTES {
            return Err(ExportError::new("server"));
        }
        bytes.extend_from_slice(&chunk);
    }
    let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    if !(200..300).contains(&status) {
        return Err(classify(route, status, &json, wait));
    }
    Ok((status, json))
}

/// The bundle as a streamed multipart part that reports `(sent, total)`
/// as reqwest pulls each chunk.
fn bundle_part(
    bundle: Vec<u8>,
    progress: impl Fn(u64, u64) + Send + Sync + 'static,
) -> reqwest::multipart::Part {
    let total = bundle.len() as u64;
    let chunks: Vec<Vec<u8>> = bundle.chunks(UPLOAD_CHUNK).map(<[u8]>::to_vec).collect();
    let mut sent = 0u64;
    let stream = futures_util::stream::iter(chunks.into_iter().map(move |chunk| {
        sent += chunk.len() as u64;
        progress(sent, total);
        Ok::<_, std::io::Error>(chunk)
    }));
    reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), total)
}

/// `POST /v1/desktop/renders` with the bundle.
pub async fn start(
    base: &str,
    token: &str,
    meta: &RenderMeta,
    bundle: Vec<u8>,
    progress: impl Fn(u64, u64) + Send + Sync + 'static,
) -> Result<Started, ExportError> {
    let meta_json = serde_json::to_string(meta).map_err(|_| ExportError::new("invalid"))?;
    let form = reqwest::multipart::Form::new()
        .part(
            "meta",
            reqwest::multipart::Part::text(meta_json)
                .mime_str("application/json")
                .map_err(|_| ExportError::new("invalid"))?,
        )
        .part(
            "bundle",
            bundle_part(bundle, progress)
                .file_name("project.zip")
                .mime_str("application/zip")
                .map_err(|_| ExportError::new("invalid"))?,
        );
    let (_, json) = call(base, token, &Route::Create, Some(form)).await?;
    let id = json.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    if !valid_render_id(id) {
        return Err(ExportError::new("server"));
    }
    Ok(Started {
        render_id: id.to_string(),
        charge_seconds: json
            .get("charge_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
    })
}

/// `GET /v1/desktop/renders/{id}`: the renderer's view, and the presigned
/// URL kept in the core.
pub async fn status(
    base: &str,
    token: &str,
    id: &str,
) -> Result<(Status, Option<String>), ExportError> {
    let (_, json) = call(base, token, &Route::Status(id.to_string()), None).await?;
    let wire: StatusWire = serde_json::from_value(json).map_err(|_| ExportError::new("server"))?;
    status_from(wire)
}

/// `POST /v1/desktop/renders/{id}/cancel` (204; a finished render is a
/// no-op on the server).
pub async fn cancel(base: &str, token: &str, id: &str) -> Result<(), ExportError> {
    call(base, token, &Route::Cancel(id.to_string()), None)
        .await
        .map(|_| ())
}

/// `GET /v1/desktop/renders/quota`.
pub async fn quota(base: &str, token: &str) -> Result<Quota, ExportError> {
    let (_, json) = call(base, token, &Route::Quota, None).await?;
    serde_json::from_value(json).map_err(|_| ExportError::new("server"))
}

// ----------------------------------------------------------- download --

/// Whether a download URL (and every redirect hop) may be fetched: https
/// only; the debug mock may serve plain http on loopback.
pub fn download_url_allowed(url: &str, allow_loopback_http: bool) -> bool {
    if allow_loopback_http
        && (url.starts_with("http://127.0.0.1:") || url.starts_with("http://127.0.0.1/"))
    {
        return true;
    }
    // Production: the tenants' R2 buckets only (presigned S3-style URLs).
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none()
        && parsed
            .host_str()
            .is_some_and(|host| host.ends_with(R2_HOST_SUFFIX) && host.len() > R2_HOST_SUFFIX.len())
}

/// The only hosts a rendered MP4 is downloaded from (Cloudflare R2).
pub const R2_HOST_SUFFIX: &str = ".r2.cloudflarestorage.com";

/// A free `exports/` name for a title: `<slug>.mp4`, `<slug>-2.mp4`...
pub fn export_name(dir: &Path, title: &str) -> String {
    let mut slug = crate::tools::website::slug(title);
    if slug == "site" {
        slug = "video".into();
    }
    slug.truncate(60);
    let slug = slug.trim_end_matches('-').to_string();
    let existing = library::list_exports(dir);
    (1..)
        .map(|n| {
            if n == 1 {
                format!("{slug}.mp4")
            } else {
                format!("{slug}-{n}.mp4")
            }
        })
        .find(|name| !existing.contains_key(name))
        .unwrap_or_else(|| "video.mp4".into())
}

/// Stream a presigned MP4 into `exports/<name>` (temp file + rename): no
/// credentials, redirects re-checked, capped, `ftyp` magic checked.
/// `progress(received, total)` is called as bytes arrive.
pub async fn download(
    url: &str,
    dir: &Path,
    name: &str,
    allow_loopback_http: bool,
    progress: impl Fn(u64, Option<u64>),
) -> Result<u64, ExportError> {
    use futures_util::StreamExt as _;
    if !download_url_allowed(url, allow_loopback_http) || !library::valid_export_name(name) {
        return Err(ExportError::new("invalid"));
    }
    let client = reqwest::Client::builder()
        .https_only(!allow_loopback_http)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > MAX_REDIRECTS
                || !download_url_allowed(attempt.url().as_str(), allow_loopback_http)
            {
                attempt.error("redirect refused")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| ExportError::new("offline"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| ExportError::new("offline"))?;
    let status = response.status().as_u16();
    if status == 403 || status == 404 || status == 410 {
        return Err(ExportError::new("expired"));
    }
    if !(200..300).contains(&status) {
        return Err(ExportError::new("server"));
    }
    let total = response.content_length();
    if total.is_some_and(|t| t > MAX_MP4_BYTES) {
        return Err(ExportError::new("too_large"));
    }
    let exports = dir.join("exports");
    if !std::fs::symlink_metadata(&exports).is_ok_and(|m| m.file_type().is_dir()) {
        std::fs::create_dir(&exports).map_err(|_| ExportError::new("io"))?;
    }
    let tmp = exports.join(format!(".{}.part", uuid::Uuid::new_v4().simple()));
    let result = async {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| ExportError::new("io"))?;
        let mut received: u64 = 0;
        let mut head = Vec::with_capacity(12);
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ExportError::new("offline"))?;
            received += chunk.len() as u64;
            if received > MAX_MP4_BYTES {
                return Err(ExportError::new("too_large"));
            }
            if head.len() < 12 {
                head.extend_from_slice(&chunk[..chunk.len().min(12 - head.len())]);
            }
            file.write_all(&chunk).map_err(|_| ExportError::new("io"))?;
            progress(received, total);
        }
        if head.len() < 12 || &head[4..8] != b"ftyp" {
            return Err(ExportError::new("server"));
        }
        file.sync_all().map_err(|_| ExportError::new("io"))?;
        Ok(received)
    }
    .await;
    match result {
        Ok(size) => {
            let target = exports.join(name);
            std::fs::rename(&tmp, &target).map_err(|_| {
                let _ = std::fs::remove_file(&tmp);
                ExportError::new("io")
            })?;
            Ok(size)
        }
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::library::tests::fresh_project;
    use std::io::{BufRead as _, BufReader, Read as _};
    use std::net::TcpListener;

    #[test]
    fn routes_are_a_closed_set() {
        assert_eq!(Route::Create.target().unwrap().1, "/v1/desktop/renders");
        assert_eq!(
            Route::Quota.target().unwrap().1,
            "/v1/desktop/renders/quota"
        );
        assert_eq!(
            Route::Status("r_1-a".into()).target().unwrap().1,
            "/v1/desktop/renders/r_1-a"
        );
        let (method, path) = Route::Cancel("abc".into()).target().unwrap();
        assert_eq!(
            (method, path.as_str()),
            (reqwest::Method::POST, "/v1/desktop/renders/abc/cancel")
        );
        for bad in ["", "../x", "a/b", "quota", "a?b", &"a".repeat(65), "a b"] {
            assert!(Route::Status(bad.into()).target().is_none(), "{bad}");
            assert!(Route::Cancel(bad.into()).target().is_none(), "{bad}");
        }
    }

    #[test]
    fn every_api_error_maps_to_a_typed_kind() {
        let body = |code: &str| serde_json::json!({ "error": code });
        let quota = classify(
            &Route::Create,
            402,
            &serde_json::json!({"error":"render_quota_exhausted","remaining_seconds":12,"period_end":"2026-12-01T00:00:00Z"}),
            None,
        );
        assert_eq!(quota.kind, "quota_exhausted");
        assert_eq!(quota.remaining_seconds, Some(12));
        assert_eq!(quota.period_end.as_deref(), Some("2026-12-01T00:00:00Z"));
        for (status, code, kind) in [
            (402, "subscription_required", "subscription_required"),
            (413, "bundle_too_large", "too_large"),
            (413, "", "too_large"),
            (422, "invalid_meta", "invalid_project"),
            (422, "invalid_bundle", "invalid_project"),
            (409, "canceled", "canceled"),
            (400, "upload_failed", "upload_failed"),
            (401, "", "no_session"),
            (404, "", "not_found"),
            (500, "", "server"),
            (503, "", "unavailable"),
        ] {
            assert_eq!(
                classify(&Route::Status("r".into()), status, &body(code), None).kind,
                kind,
                "{status} {code}"
            );
        }
        let busy = classify(
            &Route::Create,
            429,
            &body("too_many_active_renders"),
            Some(30),
        );
        assert_eq!(
            (busy.kind.as_str(), busy.retry_after),
            ("too_many_active", Some(30))
        );
        let limited = classify(&Route::Create, 429, &body("rate_limited"), Some(999_999));
        assert_eq!(
            (limited.kind.as_str(), limited.retry_after),
            ("rate_limited", Some(86_400))
        );
        // 503s are retryable and friendly; a 404 on create/quota is the
        // enterprise "no credential".
        let busy = classify(&Route::Create, 503, &body("busy"), Some(20));
        assert_eq!((busy.kind.as_str(), busy.retry_after), ("busy", Some(20)));
        assert_eq!(
            classify(&Route::Create, 503, &body("storage_unavailable"), None).kind,
            "unavailable"
        );
        assert_eq!(
            classify(&Route::Quota, 503, &body("unavailable"), None).kind,
            "unavailable"
        );
        assert_eq!(
            classify(&Route::Create, 404, &body(""), None).kind,
            "no_session"
        );
        assert_eq!(
            classify(&Route::Quota, 404, &body(""), None).kind,
            "no_session"
        );
        assert_eq!(
            classify(&Route::Cancel("r".into()), 404, &body(""), None).kind,
            "not_found"
        );
        // Only a quota error carries quota fields.
        assert_eq!(
            classify(&Route::Create, 402, &body("subscription_required"), None).remaining_seconds,
            None
        );
    }

    #[test]
    fn the_status_never_exposes_the_download_url() {
        let wire: StatusWire = serde_json::from_value(serde_json::json!({
            "id": "r1", "status": "done", "progress": 1.0, "error": null,
            "download_url": "https://r2.example/x.mp4?sig", "size_bytes": 1234, "expires_at": "2026-11-24T00:00:00Z"
        })).unwrap();
        let (status, url) = status_from(wire).unwrap();
        assert!(status.ready);
        assert_eq!(url.as_deref(), Some("https://r2.example/x.mp4?sig"));
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains("r2.example"), "{json}");
        let failed: StatusWire = serde_json::from_value(
            serde_json::json!({"status":"failed","progress":7,"error":"weird <b>"}),
        )
        .unwrap();
        let (status, url) = status_from(failed).unwrap();
        assert_eq!(
            (status.error.as_deref(), status.progress, status.ready, url),
            (Some("render_failed"), 1.0, false, None)
        );
        let odd: StatusWire =
            serde_json::from_value(serde_json::json!({"status":"hacked"})).unwrap();
        assert!(status_from(odd).is_err());
    }

    #[test]
    fn the_bundle_is_a_valid_deterministic_zip_without_exports() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        std::fs::write(dir.join("exports/old.mp4"), b"\0\0\0\x18ftypmp42").unwrap();
        let files = bundle_files(&dir).unwrap();
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "compositions/intro.html",
                "compositions/outro.html",
                "index.html",
                "video.json"
            ]
        );
        let zip = zip_stored(&files, MAX_BUNDLE_BYTES).unwrap();
        assert_eq!(
            zip,
            zip_stored(&files, MAX_BUNDLE_BYTES).unwrap(),
            "deterministic"
        );
        // Parse it back with the zip crate's format rules: local headers,
        // central directory and the end record line up.
        assert_eq!(&zip[0..4], b"PK\x03\x04");
        let eocd = zip.len() - 22;
        assert_eq!(&zip[eocd..eocd + 4], b"PK\x05\x06");
        let count = u16::from_le_bytes([zip[eocd + 10], zip[eocd + 11]]) as usize;
        assert_eq!(count, files.len());
        let cd_offset = u32::from_le_bytes(zip[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
        let mut at = cd_offset;
        for (name, data) in &files {
            assert_eq!(&zip[at..at + 4], b"PK\x01\x02");
            let name_len = u16::from_le_bytes([zip[at + 28], zip[at + 29]]) as usize;
            assert_eq!(&zip[at + 46..at + 46 + name_len], name.as_bytes());
            let local = u32::from_le_bytes(zip[at + 42..at + 46].try_into().unwrap()) as usize;
            let local_name_len = u16::from_le_bytes([zip[local + 26], zip[local + 27]]) as usize;
            let start = local + 30 + local_name_len;
            assert_eq!(&zip[start..start + data.len()], data.as_slice());
            assert_eq!(
                u32::from_le_bytes(zip[at + 16..at + 20].try_into().unwrap()),
                crc32fast::hash(data)
            );
            at += 46 + name_len;
        }
        // And a real zip reader agrees.
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip.clone())).unwrap();
        assert_eq!(archive.len(), files.len());
        for (name, data) in &files {
            let mut entry = archive.by_name(name).unwrap();
            let mut read = Vec::new();
            entry.read_to_end(&mut read).unwrap();
            assert_eq!(&read, data);
        }
        assert_eq!(zip_stored(&files, 100).unwrap_err().kind, "too_large");
    }

    #[test]
    fn prepare_checks_quality_and_builds_meta() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        let (meta, bundle) = prepare(&dir, "standard").unwrap();
        assert_eq!(
            meta,
            RenderMeta {
                duration_s: 5.0,
                width: 1920,
                height: 1080,
                fps: 30,
                quality: "standard".into(),
                title: "Demo".into()
            }
        );
        assert!(!bundle.is_empty());
        assert_eq!(prepare(&dir, "ultra").unwrap_err().kind, "invalid");
        // A remote reference written behind the app's back never ships.
        for remote in [
            "https://cdn.example/a.png",
            "//cdn.example/a.png",
            "http://x/a.png",
        ] {
            let original = std::fs::read_to_string(dir.join("compositions/outro.html")).unwrap();
            std::fs::write(
                dir.join("compositions/outro.html"),
                original.replace("</h1>", &format!("</h1><img src=\"{remote}\" alt=\"\">")),
            )
            .unwrap();
            assert_eq!(
                prepare(&dir, "standard").unwrap_err().kind,
                "invalid_project",
                "{remote}"
            );
            std::fs::write(dir.join("compositions/outro.html"), original).unwrap();
        }
        std::fs::write(
            dir.join("compositions/intro.html"),
            "<template><script src=x></script></template>",
        )
        .unwrap();
        assert_eq!(prepare(&dir, "draft").unwrap_err().kind, "invalid_project");
    }

    #[test]
    fn export_names_never_collide() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        assert_eq!(export_name(&dir, "Mi Vídeo"), "mi-video.mp4");
        std::fs::write(dir.join("exports/mi-video.mp4"), b"x").unwrap();
        assert_eq!(export_name(&dir, "Mi Vídeo"), "mi-video-2.mp4");
        assert_eq!(export_name(&dir, "¡¡"), "video.mp4");
    }

    /// A one-shot loopback server: answers with `reply` and returns the
    /// request head it received.
    fn serve_once(reply: Vec<u8>) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let length = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let mut stream = stream;
            stream.write_all(&reply).unwrap();
            format!("{head}\n{}", String::from_utf8_lossy(&body))
        });
        (url, handle)
    }

    fn http(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn start_posts_meta_and_bundle_with_the_session_bearer() {
        let (base, server) = serve_once(http(
            "202 Accepted",
            "Content-Type: application/json\r\n",
            br#"{"id":"r-1","status":"queued","charge_seconds":5}"#,
        ));
        let meta = RenderMeta {
            duration_s: 4.2,
            width: 1080,
            height: 1920,
            fps: 30,
            quality: "standard".into(),
            title: "Hola".into(),
        };
        let progress = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = progress.clone();
        let started = tauri::async_runtime::block_on(start(
            &base,
            "jwt-123",
            &meta,
            b"PK\x03\x04zip".to_vec(),
            move |sent, total| seen.lock().unwrap().push((sent, total)),
        ))
        .unwrap();
        assert_eq!(progress.lock().unwrap().last().copied(), Some((7, 7)));
        assert_eq!(
            started,
            Started {
                render_id: "r-1".into(),
                charge_seconds: 5
            }
        );
        let request = server.join().unwrap();
        assert!(
            request.starts_with("POST /v1/desktop/renders HTTP/1.1"),
            "{request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer jwt-123")
        );
        assert!(request.contains("name=\"meta\""));
        assert!(request.contains("\"duration_s\":4.2"));
        assert!(request.contains("name=\"bundle\"; filename=\"project.zip\""));
        assert!(request.contains("application/zip"));
    }

    #[test]
    fn errors_and_retry_after_come_back_typed() {
        let (base, server) = serve_once(http(
            "429 Too Many Requests",
            "Retry-After: 42\r\nContent-Type: application/json\r\n",
            br#"{"error":"too_many_active_renders"}"#,
        ));
        let err = tauri::async_runtime::block_on(quota(&base, "t")).unwrap_err();
        assert_eq!(
            (err.kind.as_str(), err.retry_after),
            ("too_many_active", Some(42))
        );
        server.join().unwrap();
        let (base, server) = serve_once(http("200 OK", "Content-Type: application/json\r\n", br#"{"included_seconds":7200,"used_seconds":2160,"remaining_seconds":5040,"period_end":"2026-12-01T00:00:00Z"}"#));
        let q = tauri::async_runtime::block_on(quota(&base, "t")).unwrap();
        assert_eq!(q.remaining_seconds, 5040);
        assert!(
            server
                .join()
                .unwrap()
                .starts_with("GET /v1/desktop/renders/quota")
        );
        // A redirect is never followed for API calls.
        let (base, server) = serve_once(http(
            "302 Found",
            "Location: https://evil.example/\r\n",
            b"",
        ));
        assert_eq!(
            tauri::async_runtime::block_on(cancel(&base, "t", "r1"))
                .unwrap_err()
                .kind,
            "server"
        );
        assert!(
            server
                .join()
                .unwrap()
                .starts_with("POST /v1/desktop/renders/r1/cancel")
        );
    }

    #[test]
    fn downloads_stream_to_exports_without_credentials_and_check_the_magic() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        let mp4 = [b"\0\0\0\x18ftypmp42".as_slice(), &[7u8; 5000]].concat();
        let (base, server) = serve_once(http("200 OK", "Content-Type: video/mp4\r\n", &mp4));
        let seen = std::sync::Mutex::new(Vec::new());
        let size = tauri::async_runtime::block_on(download(
            &format!("{base}/x.mp4"),
            &dir,
            "demo.mp4",
            true,
            |r, t| seen.lock().unwrap().push((r, t)),
        ))
        .unwrap();
        assert_eq!(size, mp4.len() as u64);
        assert_eq!(std::fs::read(dir.join("exports/demo.mp4")).unwrap(), mp4);
        assert_eq!(
            seen.lock().unwrap().last().copied(),
            Some((mp4.len() as u64, Some(mp4.len() as u64)))
        );
        let request = server.join().unwrap();
        assert!(
            !request.to_ascii_lowercase().contains("authorization"),
            "no credentials on a presigned URL"
        );
        // Not an MP4: nothing is kept.
        let (base, server) = serve_once(http("200 OK", "", b"<html>not a video</html>"));
        assert_eq!(
            tauri::async_runtime::block_on(download(
                &format!("{base}/x"),
                &dir,
                "bad.mp4",
                true,
                |_, _| {}
            ))
            .unwrap_err()
            .kind,
            "server"
        );
        server.join().unwrap();
        assert!(!dir.join("exports/bad.mp4").exists());
        assert_eq!(library::list_exports(&dir).len(), 1);
        assert!(
            std::fs::read_dir(dir.join("exports")).unwrap().all(|e| !e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part"))
        );
        // Only R2 hosts in production.
        for (url, ok) in [
            (
                "https://acc.r2.cloudflarestorage.com/renders/x.mp4?X-Amz-Signature=a",
                true,
            ),
            ("https://bucket.acc.eu.r2.cloudflarestorage.com/x.mp4", true),
            ("https://evil.example/x.mp4", false),
            ("https://r2.cloudflarestorage.com.evil.example/x.mp4", false),
            ("https://.r2.cloudflarestorage.com/x", false),
            ("https://user:pw@acc.r2.cloudflarestorage.com/x.mp4", false),
            ("https://acc.r2.cloudflarestorage.com:8443/x.mp4", false),
            ("http://acc.r2.cloudflarestorage.com/x.mp4", false),
        ] {
            assert_eq!(download_url_allowed(url, false), ok, "{url}");
        }
        // Expired link, http in production, bad names.
        let (base, server) = serve_once(http("403 Forbidden", "", b""));
        assert_eq!(
            tauri::async_runtime::block_on(download(
                &format!("{base}/x"),
                &dir,
                "e.mp4",
                true,
                |_, _| {}
            ))
            .unwrap_err()
            .kind,
            "expired"
        );
        server.join().unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(download(
                "http://127.0.0.1:1/x",
                &dir,
                "e.mp4",
                false,
                |_, _| {}
            ))
            .unwrap_err()
            .kind,
            "invalid"
        );
        assert_eq!(
            tauri::async_runtime::block_on(download(
                "https://a.r2.cloudflarestorage.com/x",
                &dir,
                "../e.mp4",
                false,
                |_, _| {}
            ))
            .unwrap_err()
            .kind,
            "invalid"
        );
    }

    /// End to end against the mock platform (`node test/mock-renders.mjs`):
    /// `VIDEO_MOCK_RENDERS=http://127.0.0.1:14330 cargo test --lib
    /// export_round_trip_against_the_mock -- --ignored`.
    #[test]
    #[ignore]
    fn export_round_trip_against_the_mock() {
        let base = std::env::var("VIDEO_MOCK_RENDERS").expect("VIDEO_MOCK_RENDERS");
        let (_tmp, _realm, _id, dir) = fresh_project();
        tauri::async_runtime::block_on(async {
            let before = quota(&base, "fake-jwt").await.unwrap();
            let (meta, bundle) = prepare(&dir, "draft").unwrap();
            let started = start(&base, "fake-jwt", &meta, bundle, |_, _| {})
                .await
                .unwrap();
            assert_eq!(started.charge_seconds, 5);
            assert_eq!(
                quota(&base, "fake-jwt").await.unwrap().used_seconds,
                before.used_seconds + 5
            );
            assert_eq!(
                start(&base, "wrong", &meta, Vec::new(), |_, _| {})
                    .await
                    .unwrap_err()
                    .kind,
                "no_session"
            );
            let mut seen = Vec::new();
            let url = loop {
                let (status, url) = status(&base, "fake-jwt", &started.render_id).await.unwrap();
                seen.push(status.status.clone());
                if let Some(url) = url {
                    break url;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            };
            assert!(seen.contains(&"rendering".to_string()), "{seen:?}");
            let (done, _) = status(&base, "fake-jwt", &started.render_id).await.unwrap();
            assert_eq!(done.charge_seconds, Some(5));
            let name = export_name(&dir, "Demo");
            let size = download(&url, &dir, &name, true, |_, _| {}).await.unwrap();
            assert_eq!(size, 4096);
            assert!(library::list_exports(&dir).contains_key("demo.mp4"));
            // Cancel refunds an unfinished render; quota and too-large refusals are typed.
            let (meta, bundle) = prepare(&dir, "standard").unwrap();
            let second = start(&base, "fake-jwt", &meta, bundle, |_, _| {})
                .await
                .unwrap();
            let used = quota(&base, "fake-jwt").await.unwrap().used_seconds;
            cancel(&base, "fake-jwt", &second.render_id).await.unwrap();
            assert_eq!(
                quota(&base, "fake-jwt").await.unwrap().used_seconds,
                used - 5
            );
            let (status, _) = status(&base, "fake-jwt", &second.render_id).await.unwrap();
            assert_eq!(status.status, "canceled");
            let mut trigger = meta.clone();
            trigger.title = "trigger-402".into();
            let (_, bundle) = prepare(&dir, "standard").unwrap();
            assert_eq!(
                start(&base, "fake-jwt", &trigger, bundle, |_, _| {})
                    .await
                    .unwrap_err()
                    .kind,
                "subscription_required"
            );
            trigger.title = "trigger-429".into();
            let (_, bundle) = prepare(&dir, "standard").unwrap();
            let limited = start(&base, "fake-jwt", &trigger, bundle, |_, _| {})
                .await
                .unwrap_err();
            assert_eq!(
                (limited.kind.as_str(), limited.retry_after),
                ("rate_limited", Some(120))
            );
            let mut long = meta.clone();
            long.duration_s = 599.0;
            let (_, bundle) = prepare(&dir, "standard").unwrap();
            let quota_err = start(&base, "fake-jwt", &long, bundle, |_, _| {}).await;
            if let Err(err) = quota_err {
                assert_eq!(err.kind, "quota_exhausted");
                assert!(err.period_end.is_some());
            }
            trigger.title = "trigger-busy".into();
            let (_, bundle) = prepare(&dir, "standard").unwrap();
            let busy = start(&base, "fake-jwt", &trigger, bundle, |_, _| {})
                .await
                .unwrap_err();
            assert_eq!((busy.kind.as_str(), busy.retry_after), ("busy", Some(20)));
            assert_eq!(status_err(&base).await, "not_found");
        });
    }

    async fn status_err(base: &str) -> String {
        status(base, "fake-jwt", "missing").await.unwrap_err().kind
    }
}
