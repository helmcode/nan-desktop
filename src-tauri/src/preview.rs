//! Preview pane backends (S21): the renderer never touches the disk or the
//! network itself, it asks the core.
//!
//! - `preview_read_file(profile_id, path)` → `{base64, size}`: reads ONE
//!   regular file that sits inside an active grant of that profile. The
//!   sensitive deny-list (credential stores, login items, shell startup
//!   files, key files) and the app's own data folder are refused under
//!   every grant scope, files over [`MAX_PREVIEW_FILE_BYTES`] are refused,
//!   and symlinks are never followed (a symlink leaf, or a symlink below
//!   the grant root, is refused; the open itself uses `O_NOFOLLOW`).
//!   This is a user-initiated view of a file the user already granted, so
//!   it does not go through the propose/approve flow of the model's tools.
//! - `preview_reveal_location(profile_id, path)` → `()`: shows the file
//!   selected in the OS file manager (Finder / Explorer / FileManager1)
//!   WITHOUT opening it. Same checks as `preview_read_file` (no size cap),
//!   so it only ever acts on a file the preview could already show. The
//!   renderer holds no opener permission: the reveal lives in the core.
//! - `web_preview_fetch(profile_id, url)` → `{url, title, content_type,
//!   text}`: `POST {platform_base}/v1/fetch {url}` with the profile's
//!   session JWT (the same plumbing as `web_search`). The text is capped
//!   at [`MAX_WEB_TEXT_BYTES`]. Failures are a typed [`Rejection`] whose
//!   `kind` the renderer maps to the open-in-browser fallback; messages
//!   are static and never carry the URL, the page content or the session.
//!
//! Nothing here logs: no URL, no page content, no key material.

use std::io::Read as _;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::tools::Rejection;
use crate::tools::grants::{self, GrantsStore};

/// Largest local file the preview pane may receive (8 MiB).
pub const MAX_PREVIEW_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// Most page text forwarded to the renderer (256 KiB, UTF-8 safe cut).
pub const MAX_WEB_TEXT_BYTES: usize = 256 * 1024;

/// Largest platform reply body read before parsing (the text inside is
/// capped separately). Anything larger is a protocol error.
const MAX_WEB_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Longest URL accepted for a web preview.
const MAX_URL_CHARS: usize = 2048;

// ---------------------------------------------------------------------------
// Local file preview
// ---------------------------------------------------------------------------

/// `preview_read_file` reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FilePreview {
    /// Standard base64 of the exact file bytes.
    pub base64: String,
    pub size: u64,
}

/// Resolve `raw` to a previewable regular file: inside an active grant of
/// `profile_id`, outside the app data folder and the sensitive deny-list,
/// reached without any symlink. Returns the canonical path and its size.
///
/// Both the read and the reveal go through this, so the reveal can never
/// point the file manager at anything the preview could not show.
///
/// Rejections: everything [`grants::resolve_under_grant`] rejects
/// (`traversal`, `protocol`, `io`, `no_grant`, `escape`), plus `scope`
/// (app data dir), `sensitive` (deny-list), `symlink` and `not_file`.
fn resolve_preview_file(
    store: &GrantsStore,
    profile_id: &str,
    raw: &str,
    app_data: &Path,
    home: Option<&Path>,
) -> Result<(PathBuf, u64), Rejection> {
    let (grant_id, canonical) = grants::resolve_under_grant(store, profile_id, raw)?;
    let grant = store
        .grant_by_id(&grant_id)
        .ok_or_else(|| Rejection::new("no_grant", "the grant behind this path is gone"))?;
    if grants::is_protected(app_data, &canonical) {
        return Err(Rejection::new(
            "scope",
            "the app's own data folder is off limits",
        ));
    }
    if grants::is_sensitive_write_target(home, &canonical) {
        return Err(Rejection::new(
            "sensitive",
            "this file is on the sensitive-path deny-list",
        ));
    }
    reject_symlink_traversal(&grant.canonical_path, Path::new(raw.trim()), &canonical)?;
    grants::verify_stable(&grant.canonical_path, &canonical)?;

    let meta = std::fs::symlink_metadata(&canonical)
        .map_err(|_| Rejection::new("io", "cannot stat the file"))?;
    if meta.file_type().is_symlink() {
        return Err(Rejection::new("symlink", "refusing to follow a symlink"));
    }
    if !meta.is_file() {
        return Err(Rejection::new(
            "not_file",
            "only regular files can be previewed",
        ));
    }
    Ok((canonical, meta.len()))
}

/// Read a file for the preview pane. `app_data` and `home` are injected so
/// tests can use tempdirs.
///
/// Rejections: everything [`read_granted_bytes`] rejects.
pub fn read_preview_file(
    store: &GrantsStore,
    profile_id: &str,
    raw: &str,
    app_data: &Path,
    home: Option<&Path>,
) -> Result<FilePreview, Rejection> {
    let bytes = read_granted_bytes(store, profile_id, raw, app_data, home)?;
    Ok(FilePreview {
        size: bytes.len() as u64,
        base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// The exact bytes of a granted file, with every check of
/// [`read_preview_file`] (the same rejections): grant resolution, the
/// app-data and sensitive deny-list, no symlink anywhere, a regular file,
/// the [`MAX_PREVIEW_FILE_BYTES`] cap and an `O_NOFOLLOW` open. The
/// artifacts share reads its snapshot through here, so it can never reach
/// a file the preview could not show.
///
/// Rejections: everything [`resolve_preview_file`] rejects, plus
/// `too_large`.
pub fn read_granted_bytes(
    store: &GrantsStore,
    profile_id: &str,
    raw: &str,
    app_data: &Path,
    home: Option<&Path>,
) -> Result<Vec<u8>, Rejection> {
    let (canonical, len) = resolve_preview_file(store, profile_id, raw, app_data, home)?;
    if len > MAX_PREVIEW_FILE_BYTES {
        return Err(too_large());
    }
    read_no_follow(&canonical)
}

/// Reveal a previewed file in the OS file manager, selecting it. The file
/// is never opened. `reveal` is the per-OS mechanism, injected so tests
/// can observe what would be revealed without launching Finder.
///
/// The path passes the exact checks of [`read_preview_file`] (minus the
/// size cap, which is irrelevant to a reveal), so this only ever acts on
/// a file the user could already see in the preview.
pub fn reveal_preview_file(
    store: &GrantsStore,
    profile_id: &str,
    raw: &str,
    app_data: &Path,
    home: Option<&Path>,
    reveal: impl FnOnce(&Path) -> Result<(), Rejection>,
) -> Result<(), Rejection> {
    let (canonical, _) = resolve_preview_file(store, profile_id, raw, app_data, home)?;
    reveal(&canonical)
}

/// The per-OS reveal, all through `tauri-plugin-opener` called from the
/// core (the renderer has no opener permission of its own):
/// - macOS: `NSWorkspace activateFileViewerSelectingURLs` (Finder, file
///   selected).
/// - Windows: `SHOpenFolderAndSelectItems` (Explorer, file selected).
/// - Linux/BSD: the `org.freedesktop.FileManager1.ShowItems` D-Bus call,
///   then the OpenURI portal; when neither is available, the PARENT folder
///   is opened with the default handler (xdg-open on the directory, never
///   on the file).
fn os_reveal(path: &Path) -> Result<(), Rejection> {
    let failed = || Rejection::new("io", "could not open the containing folder");
    match tauri_plugin_opener::reveal_item_in_dir(path) {
        Ok(()) => Ok(()),
        #[cfg(not(any(target_os = "macos", windows)))]
        Err(_) => {
            let parent = path.parent().ok_or_else(failed)?;
            tauri_plugin_opener::open_path(parent, None::<&str>).map_err(|_| failed())
        }
        #[cfg(any(target_os = "macos", windows))]
        Err(_) => Err(failed()),
    }
}

fn too_large() -> Rejection {
    Rejection::new(
        "too_large",
        format!("file is larger than the {MAX_PREVIEW_FILE_BYTES}-byte preview cap"),
    )
}

/// No symlink traversal: a symlink leaf is refused outright, and when the
/// path the caller gave lies (lexically) under the grant root it must
/// already be canonical, so no symlink BELOW the root was followed.
/// (Aliases ABOVE the root, like macOS `/var` → `/private/var`, are fine:
/// they do not change which granted file is reached.)
fn reject_symlink_traversal(root: &Path, raw: &Path, canonical: &Path) -> Result<(), Rejection> {
    if std::fs::symlink_metadata(raw).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(Rejection::new("symlink", "refusing to follow a symlink"));
    }
    if grants::is_under(root, raw) && raw != canonical {
        return Err(Rejection::new(
            "symlink",
            "the path goes through a symlink inside the folder",
        ));
    }
    Ok(())
}

/// Read at most cap + 1 bytes without following a symlink leaf (a swap
/// after the checks above fails closed).
pub(crate) fn read_no_follow(path: &Path) -> Result<Vec<u8>, Rejection> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(path)
        .map_err(|_| Rejection::new("io", "cannot open the file"))?;
    let mut bytes = Vec::new();
    file.take(MAX_PREVIEW_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Rejection::new("io", "cannot read the file"))?;
    if bytes.len() as u64 > MAX_PREVIEW_FILE_BYTES {
        return Err(too_large());
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn preview_read_file(
    app: AppHandle,
    profile_id: String,
    path: String,
) -> Result<FilePreview, Rejection> {
    if !crate::profile::is_known_profile_id(&profile_id) {
        return Err(Rejection::new("protocol", "unknown profile"));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| Rejection::new("io", "cannot locate the app data folder"))?;
    // Privacy fix: the grants are the signed-in user's (realm); the
    // protection still covers the whole app data root (`dir`).
    let realm = crate::realm::dir_for_in(&dir, &profile_id)
        .map_err(|err| Rejection::new("protocol", err.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = grants::load_or_seed(&realm).map_err(|err| Rejection::new("io", err))?;
        let home = std::env::home_dir();
        read_preview_file(&store, &profile_id, &path, &dir, home.as_deref())
    })
    .await
    .map_err(|_| Rejection::new("io", "preview read was interrupted"))?
}

/// Reveal a previewed file in Finder / Explorer / the Linux file manager.
#[tauri::command]
pub async fn preview_reveal_location(
    app: AppHandle,
    profile_id: String,
    path: String,
) -> Result<(), Rejection> {
    if !crate::profile::is_known_profile_id(&profile_id) {
        return Err(Rejection::new("protocol", "unknown profile"));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| Rejection::new("io", "cannot locate the app data folder"))?;
    // Same realm scoping as `preview_read_file`: the grants are the
    // signed-in user's; the app-data protection covers the whole root.
    let realm = crate::realm::dir_for_in(&dir, &profile_id)
        .map_err(|err| Rejection::new("protocol", err.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = grants::load_or_seed(&realm).map_err(|err| Rejection::new("io", err))?;
        let home = std::env::home_dir();
        reveal_preview_file(&store, &profile_id, &path, &dir, home.as_deref(), os_reveal)
    })
    .await
    .map_err(|_| Rejection::new("io", "reveal was interrupted"))?
}

// ---------------------------------------------------------------------------
// Web preview through the platform fetch wrapper
// ---------------------------------------------------------------------------

/// `web_preview_fetch` reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WebPreview {
    /// Final URL after redirects (falls back to the requested URL).
    pub url: String,
    pub title: Option<String>,
    pub content_type: String,
    /// Readable text (markdown or plain), capped at [`MAX_WEB_TEXT_BYTES`].
    pub text: String,
}

/// Platform `/v1/fetch` reply; tolerant of the field naming.
#[derive(Debug, Default, Deserialize)]
struct FetchReply {
    #[serde(default, alias = "final_url")]
    url: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default, alias = "contentType")]
    content_type: Option<String>,
    #[serde(default, alias = "content", alias = "markdown")]
    text: Option<String>,
}

/// Only absolute http(s) URLs without embedded credentials.
pub fn validate_web_url(url: &str) -> Result<(), Rejection> {
    let invalid = || Rejection::new("invalid_url", "only http and https pages can be previewed");
    let url = url.trim();
    if url.is_empty() || url.chars().count() > MAX_URL_CHARS || url.chars().any(char::is_control) {
        return Err(invalid());
    }
    let lower = url.to_ascii_lowercase();
    let rest = lower
        .strip_prefix("https://")
        .or_else(|| lower.strip_prefix("http://"))
        .ok_or_else(invalid)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(invalid());
    }
    Ok(())
}

fn is_web_url(url: &str) -> bool {
    validate_web_url(url).is_ok()
}

/// Cut `text` to at most `max` bytes on a char boundary.
pub fn cap_text(mut text: String, max: usize) -> String {
    if text.len() > max {
        let mut end = max;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// Map a non-success platform status to a typed, content-free rejection.
fn status_rejection(status: u16) -> Rejection {
    match status {
        401 | 403 => Rejection::new("unauthorized", "the session was not accepted"),
        404 => Rejection::new(
            "not_found",
            "the page or the preview service is not available",
        ),
        429 => Rejection::new("rate_limited", "too many previews, try again later"),
        _ => Rejection::new("unavailable", "the preview service failed"),
    }
}

fn unavailable() -> Rejection {
    Rejection::new("unavailable", "the preview service could not be reached")
}

/// Fetch a page preview through the platform. `base` is the platform base
/// (no trailing slash), `token` the session JWT.
pub async fn fetch_preview(base: &str, token: &str, url: &str) -> Result<WebPreview, Rejection> {
    validate_web_url(url)?;
    let url = url.trim();
    let client = crate::web_search::platform_client().ok_or_else(unavailable)?;
    let response = client
        .post(format!("{base}/v1/fetch"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "url": url }))
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(status_rejection(status));
    }
    let body = read_capped_body(response).await?;
    let reply: FetchReply = serde_json::from_slice(&body)
        .map_err(|_| Rejection::new("protocol", "unexpected reply from the preview service"))?;
    let final_url = reply
        .url
        .filter(|candidate| is_web_url(candidate))
        .unwrap_or_else(|| url.to_string());
    Ok(WebPreview {
        url: final_url,
        title: reply
            .title
            .map(|title| title.trim().to_string())
            .filter(|title| !title.is_empty()),
        content_type: reply
            .content_type
            .filter(|ct| !ct.trim().is_empty())
            .unwrap_or_else(|| "text/plain".into()),
        text: cap_text(reply.text.unwrap_or_default(), MAX_WEB_TEXT_BYTES),
    })
}

async fn read_capped_body(response: reqwest::Response) -> Result<Vec<u8>, Rejection> {
    use futures_util::StreamExt as _;
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| unavailable())?;
        if body.len() + chunk.len() > MAX_WEB_BODY_BYTES {
            return Err(Rejection::new(
                "protocol",
                "the preview service reply is too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[tauri::command]
pub async fn web_preview_fetch(profile_id: String, url: String) -> Result<WebPreview, Rejection> {
    if !crate::profile::is_known_profile_id(&profile_id) {
        return Err(Rejection::new("protocol", "unknown profile"));
    }
    validate_web_url(&url)?;
    let token = crate::chat::read_session_token(&profile_id)
        .ok_or_else(|| Rejection::new("unauthorized", "not signed in"))?;
    let base = crate::device_flow::platform_base(&profile_id)
        .ok_or_else(|| Rejection::new("protocol", "unknown profile"))?;
    fetch_preview(&base, &token, &url).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;

    // ------------------------------------------------------ file preview --

    struct Layout {
        _guard: tempfile::TempDir,
        app_data: PathBuf,
        home: PathBuf,
        grant: PathBuf,
        outside: PathBuf,
    }

    /// Canonical tempdir layout: `home/` (stand-in $HOME), `home/proj` (the
    /// grant), `home/app-data` (protected), `outside/`. Only the unix-gated
    /// tests below use it (macOS trash semantics run everywhere, the rest
    /// need unix); without the gate Linux/Windows CI flags it as dead code.
    #[cfg_attr(not(unix), allow(dead_code))]
    fn layout() -> Layout {
        let guard = tempfile::tempdir().expect("tempdir");
        let base = fs::canonicalize(guard.path()).expect("canon");
        let home = base.join("home");
        let grant = home.join("proj");
        let app_data = home.join("app-data");
        let outside = base.join("outside");
        for dir in [&grant, &app_data, &outside] {
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

    fn store_with(roots: &[&Path]) -> GrantsStore {
        let mut store = grants::default_store();
        for (i, root) in roots.iter().enumerate() {
            store
                .add_grant(
                    format!("g{i}"),
                    "nan",
                    root.to_path_buf(),
                    "2026-11-02T00:00:00Z".into(),
                )
                .expect("grant");
        }
        store
    }

    fn read(l: &Layout, store: &GrantsStore, path: &Path) -> Result<FilePreview, Rejection> {
        read_preview_file(
            store,
            "nan",
            &path.display().to_string(),
            &l.app_data,
            Some(&l.home),
        )
    }

    #[test]
    fn reads_a_file_inside_the_grant_as_exact_base64() {
        let l = layout();
        let file = l.grant.join("photo.png");
        let bytes = [0x89u8, b'P', b'N', b'G', 0, 1, 2, 255];
        fs::write(&file, bytes).expect("write");
        let preview = read(&l, &store_with(&[&l.grant]), &file).expect("inside grant");
        assert_eq!(preview.size, bytes.len() as u64);
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&preview.base64)
                .expect("b64"),
            bytes
        );
    }

    #[test]
    fn refuses_files_outside_every_grant_and_profiles_without_grants() {
        let l = layout();
        let file = l.outside.join("secret.txt");
        fs::write(&file, "x").expect("write");
        let err = read(&l, &store_with(&[&l.grant]), &file).expect_err("outside");
        assert_eq!(err.kind, "escape");
        let err = read(&l, &grants::default_store(), &file).expect_err("no grant");
        assert_eq!(err.kind, "no_grant");
        // Another profile's grant does not count.
        let err = read_preview_file(
            &store_with(&[&l.outside]),
            "helmcode",
            &file.display().to_string(),
            &l.app_data,
            Some(&l.home),
        )
        .expect_err("other profile");
        assert_eq!(err.kind, "no_grant");
    }

    #[test]
    fn refuses_lexical_traversal() {
        let l = layout();
        fs::write(l.outside.join("a.txt"), "x").expect("write");
        let sneaky = l.grant.join("..").join("..").join("outside").join("a.txt");
        let err = read(&l, &store_with(&[&l.grant]), &sneaky).expect_err("dotdot");
        // The refusal is the property; which check fires first is
        // platform-dependent (unix canonicalises .. lexically -> "traversal",
        // Windows resolves the real path first -> "escape"). Both refuse.
        assert!(
            err.kind == "traversal" || err.kind == "escape",
            "unexpected kind {}",
            err.kind
        );
    }

    #[test]
    fn refuses_the_sensitive_deny_list_even_inside_a_grant() {
        let l = layout();
        // A grant on the whole stand-in home (like computer-wide) still
        // never exposes credentials or key files.
        let ssh = l.home.join(".ssh");
        fs::create_dir_all(&ssh).expect("ssh");
        fs::write(ssh.join("id_ed25519"), "key").expect("key");
        fs::write(l.grant.join("server.pem"), "pem").expect("pem");
        fs::write(l.grant.join(".zshrc"), "rc").expect("rc");
        let store = store_with(&[&l.home]);
        for path in [
            ssh.join("id_ed25519"),
            l.grant.join("server.pem"),
            l.grant.join(".zshrc"),
        ] {
            assert_eq!(
                read(&l, &store, &path).expect_err("deny-list").kind,
                "sensitive",
                "{}",
                path.display()
            );
        }
    }

    #[test]
    fn refuses_the_protected_app_data_folder() {
        let l = layout();
        fs::write(l.app_data.join("tools-grants.json"), "{}").expect("write");
        let err = read(
            &l,
            &store_with(&[&l.home]),
            &l.app_data.join("tools-grants.json"),
        )
        .expect_err("protected");
        assert_eq!(err.kind, "scope");
    }

    #[test]
    fn refuses_files_over_the_8_mib_cap() {
        let l = layout();
        let file = l.grant.join("big.bin");
        let handle = fs::File::create(&file).expect("create");
        handle.set_len(MAX_PREVIEW_FILE_BYTES + 1).expect("grow");
        let err = read(&l, &store_with(&[&l.grant]), &file).expect_err("oversize");
        assert_eq!(err.kind, "too_large");
        // Exactly at the cap is fine.
        handle.set_len(MAX_PREVIEW_FILE_BYTES).expect("shrink");
        assert_eq!(
            read(&l, &store_with(&[&l.grant]), &file)
                .expect("at cap")
                .size,
            MAX_PREVIEW_FILE_BYTES
        );
    }

    #[test]
    fn refuses_folders() {
        let l = layout();
        let err = read(&l, &store_with(&[&l.grant]), &l.grant).expect_err("dir");
        assert_eq!(err.kind, "not_file");
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_symlinks() {
        let l = layout();
        let store = store_with(&[&l.grant]);
        let target = l.grant.join("real.txt");
        fs::write(&target, "inside").expect("write");
        fs::write(l.outside.join("secret.txt"), "outside").expect("write");

        // Leaf symlink to a file inside the grant: refused.
        let inner_link = l.grant.join("link.txt");
        std::os::unix::fs::symlink(&target, &inner_link).expect("symlink");
        assert_eq!(
            read(&l, &store, &inner_link).expect_err("leaf").kind,
            "symlink"
        );

        // Leaf symlink escaping the grant: refused (canonical is outside).
        let escape_link = l.grant.join("escape.txt");
        std::os::unix::fs::symlink(l.outside.join("secret.txt"), &escape_link).expect("symlink");
        assert!(read(&l, &store, &escape_link).is_err());

        // Directory symlink inside the grant: refused.
        fs::create_dir_all(l.grant.join("sub")).expect("sub");
        fs::write(l.grant.join("sub").join("f.txt"), "f").expect("write");
        std::os::unix::fs::symlink(l.grant.join("sub"), l.grant.join("alias")).expect("symlink");
        assert_eq!(
            read(&l, &store, &l.grant.join("alias").join("f.txt"))
                .expect_err("dir link")
                .kind,
            "symlink"
        );
    }

    // ------------------------------------------------------------ reveal --

    /// Run the reveal with a recording stand-in for the OS call.
    fn reveal(
        l: &Layout,
        store: &GrantsStore,
        path: &Path,
    ) -> (Result<(), Rejection>, Option<PathBuf>) {
        let mut seen = None;
        let result = reveal_preview_file(
            store,
            "nan",
            &path.display().to_string(),
            &l.app_data,
            Some(&l.home),
            |p| {
                seen = Some(p.to_path_buf());
                Ok(())
            },
        );
        (result, seen)
    }

    #[test]
    fn reveal_selects_the_canonical_file_inside_the_grant() {
        let l = layout();
        let file = l.grant.join("Deck.pdf");
        fs::write(&file, "%PDF").expect("write");
        let (result, seen) = reveal(&l, &store_with(&[&l.grant]), &file);
        result.expect("inside grant");
        // The FILE is handed to the file manager (which selects it in its
        // folder); it is never opened.
        assert_eq!(seen, Some(file));
    }

    #[test]
    fn reveal_is_not_bound_by_the_preview_size_cap() {
        let l = layout();
        let file = l.grant.join("big.bin");
        fs::File::create(&file)
            .expect("create")
            .set_len(MAX_PREVIEW_FILE_BYTES + 1)
            .expect("grow");
        let (result, seen) = reveal(&l, &store_with(&[&l.grant]), &file);
        result.expect("oversize files can still be revealed");
        assert_eq!(seen, Some(file));
    }

    #[test]
    fn reveal_refuses_everything_the_preview_refuses_without_touching_the_os() {
        let l = layout();
        fs::write(l.outside.join("secret.txt"), "x").expect("write");
        fs::write(l.grant.join("server.pem"), "pem").expect("pem");
        fs::write(l.app_data.join("tools-grants.json"), "{}").expect("write");
        let grant_only = store_with(&[&l.grant]);
        let home_wide = store_with(&[&l.home]);
        let cases: [(&GrantsStore, PathBuf, &[&str]); 6] = [
            (&grant_only, l.outside.join("secret.txt"), &["escape"]),
            (
                &grants::default_store(),
                l.grant.join("server.pem"),
                &["no_grant"],
            ),
            (&grant_only, l.grant.join("server.pem"), &["sensitive"]),
            (&home_wide, l.app_data.join("tools-grants.json"), &["scope"]),
            (&grant_only, l.grant.clone(), &["not_file"]),
            (
                &grant_only,
                l.grant
                    .join("..")
                    .join("..")
                    .join("outside")
                    .join("secret.txt"),
                &["traversal", "escape"],
            ),
        ];
        for (store, path, kinds) in cases {
            let (result, seen) = reveal(&l, store, &path);
            let err = result.expect_err("refused");
            assert!(
                kinds.contains(&err.kind.as_str()),
                "{}: {}",
                path.display(),
                err.kind
            );
            assert!(seen.is_none(), "the OS reveal ran for {}", path.display());
        }
        // Another profile's grant does not count either.
        let mut seen = false;
        let err = reveal_preview_file(
            &store_with(&[&l.outside]),
            "helmcode",
            &l.outside.join("secret.txt").display().to_string(),
            &l.app_data,
            Some(&l.home),
            |_| {
                seen = true;
                Ok(())
            },
        )
        .expect_err("other profile");
        assert_eq!(err.kind, "no_grant");
        assert!(!seen);
    }

    #[cfg(unix)]
    #[test]
    fn reveal_never_follows_symlinks() {
        let l = layout();
        let store = store_with(&[&l.grant]);
        fs::write(l.grant.join("real.txt"), "inside").expect("write");
        let link = l.grant.join("link.txt");
        std::os::unix::fs::symlink(l.grant.join("real.txt"), &link).expect("symlink");
        let (result, seen) = reveal(&l, &store, &link);
        assert_eq!(result.expect_err("leaf").kind, "symlink");
        assert!(seen.is_none());
    }

    #[test]
    fn reveal_os_failures_surface_as_a_typed_rejection() {
        let l = layout();
        let file = l.grant.join("a.txt");
        fs::write(&file, "x").expect("write");
        let err = reveal_preview_file(
            &store_with(&[&l.grant]),
            "nan",
            &file.display().to_string(),
            &l.app_data,
            Some(&l.home),
            |_| Err(Rejection::new("io", "could not open the containing folder")),
        )
        .expect_err("os failure");
        assert_eq!(err.kind, "io");
        assert!(!err.message.contains("a.txt"), "no path in the message");
    }

    #[test]
    fn reveal_is_a_registered_core_command_and_the_renderer_gets_no_opener_grant() {
        // The command is wired into the invoke handler...
        assert!(include_str!("lib.rs").contains("preview::preview_reveal_location,"));
        // ...and the renderer holds no opener permission of its own, so the
        // grant-checked core command is the ONLY way to reveal a path.
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).expect("json");
        let perms = caps["permissions"].as_array().expect("permissions");
        for perm in perms {
            let id = perm
                .as_str()
                .or_else(|| perm["identifier"].as_str())
                .unwrap_or("");
            assert!(!id.starts_with("opener:"), "renderer must not hold {id}");
        }
    }

    // ------------------------------------------------------- web preview --

    /// Serve one (status, body) reply; return the raw request.
    fn mock_server(status: u16, body: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = stream.read(&mut chunk).expect("read");
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text
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
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(reply.as_bytes()).expect("write");
            String::from_utf8_lossy(&buf).to_string()
        });
        (base, handle)
    }

    const TOKEN: &str = "jwt-canary-ZZ9";

    fn fetch(base: &str, url: &str) -> Result<WebPreview, Rejection> {
        tauri::async_runtime::block_on(fetch_preview(base, TOKEN, url))
    }

    #[test]
    fn success_returns_the_page_and_speaks_the_wire_contract() {
        let (base, server) = mock_server(
            200,
            r#"{"url":"https://example.com/final","title":" Example ","content_type":"text/markdown","text":"Hello **world**"}"#
                .into(),
        );
        let preview = fetch(&base, "https://example.com/start").expect("ok");
        assert_eq!(
            preview,
            WebPreview {
                url: "https://example.com/final".into(),
                title: Some("Example".into()),
                content_type: "text/markdown".into(),
                text: "Hello **world**".into(),
            }
        );
        let request = server.join().expect("server");
        assert!(request.starts_with("POST /v1/fetch "), "{request}");
        assert!(request.to_ascii_lowercase().contains(&format!(
            "authorization: bearer {}",
            TOKEN.to_ascii_lowercase()
        )));
        assert!(request.contains(r#""url":"https://example.com/start""#));
    }

    #[test]
    fn text_is_capped_at_256_kib_on_a_char_boundary() {
        let long = "é".repeat(MAX_WEB_TEXT_BYTES); // 2 bytes per char
        let body = serde_json::json!({ "text": long, "title": "" }).to_string();
        let (base, server) = mock_server(200, body);
        let preview = fetch(&base, "https://example.com/").expect("ok");
        server.join().expect("server");
        assert!(preview.text.len() <= MAX_WEB_TEXT_BYTES);
        assert!(preview.text.len() > MAX_WEB_TEXT_BYTES - 4);
        assert_eq!(preview.title, None, "blank titles are dropped");
        assert_eq!(
            preview.url, "https://example.com/",
            "falls back to the requested url"
        );
        assert_eq!(preview.content_type, "text/plain");
    }

    #[test]
    fn failures_map_to_typed_kinds() {
        for (status, kind) in [
            (401, "unauthorized"),
            (403, "unauthorized"),
            (404, "not_found"),
            (429, "rate_limited"),
            (500, "unavailable"),
            (502, "unavailable"),
        ] {
            let (base, server) = mock_server(status, r#"{"error":"x"}"#.into());
            let err = fetch(&base, "https://example.com/").expect_err("failure");
            server.join().expect("server");
            assert_eq!(err.kind, kind, "status {status}");
        }
        let (base, server) = mock_server(200, "not json".into());
        assert_eq!(
            fetch(&base, "https://example.com/").expect_err("bad").kind,
            "protocol"
        );
        server.join().expect("server");
    }

    #[test]
    fn unreachable_platform_is_unavailable() {
        let port = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();
        let err =
            fetch(&format!("http://127.0.0.1:{port}"), "https://example.com/").expect_err("down");
        assert_eq!(err.kind, "unavailable");
    }

    #[test]
    fn non_web_urls_are_refused_before_any_request() {
        // No server: an attempted request would be `unavailable`, not
        // `invalid_url`.
        for url in [
            "",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/",
            "https://user:pass@example.com/",
            "https://",
            "https://exa\nmple.com/",
        ] {
            assert_eq!(
                fetch("http://127.0.0.1:9", url).expect_err(url).kind,
                "invalid_url",
                "{url:?}"
            );
        }
        let too_long = format!("https://example.com/{}", "a".repeat(MAX_URL_CHARS));
        assert_eq!(
            fetch("http://127.0.0.1:9", &too_long)
                .expect_err("long")
                .kind,
            "invalid_url"
        );
    }

    #[test]
    fn no_key_material_or_page_content_leaks_into_errors_or_replies() {
        // The platform echoes the token and the page in an error body.
        let echo = format!(r#"{{"error":"bad token {TOKEN}","page":"PAGE-CANARY"}}"#);
        for status in [401, 404, 500] {
            let (base, server) = mock_server(status, echo.clone());
            let err = fetch(&base, "https://example.com/PAGE-CANARY").expect_err("fail");
            server.join().expect("server");
            let wire = serde_json::to_string(&err).expect("json");
            assert!(!wire.contains(TOKEN), "{wire}");
            assert!(!wire.contains("PAGE-CANARY"), "{wire}");
            assert!(!wire.contains("example.com"), "{wire}");
        }
        let (base, server) = mock_server(200, r#"{"text":"ok"}"#.into());
        let reply = serde_json::to_string(&fetch(&base, "https://example.com/").expect("ok"))
            .expect("json");
        server.join().expect("server");
        assert!(!reply.contains(TOKEN));
        assert!(!reply.to_ascii_lowercase().contains("bearer"));
    }
}
