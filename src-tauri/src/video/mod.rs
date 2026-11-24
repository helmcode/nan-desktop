//! Videos (R-V1): HyperFrames compositions the assistant authors and the
//! user customizes, previewed in a sandboxed player and exported to MP4 by
//! the platform's render service. Architecture and security:
//! `docs/VIDEO.md`.
//!
//! - [`project`]: the format (`video.json`, scenes, variables, generated
//!   `index.html`) and every validation rule.
//! - [`library`]: the per-user library on disk (ids, closed file set, no
//!   symlinks, atomic writes, validate-then-write changes).
//! - [`preview`]: one self-contained, network-free preview document per
//!   project, served through the `nan-site` scheme (`crate::site_preview`).
//! - [`tool`]: the model's `create_video` / `edit_video`.
//! - [`templates`]: the bundled gallery of example videos.
//! - [`editor`]: the simple editor (values, scenes, audio, picked files).
//! - [`render`]: MP4 export through the platform's render service.
//!
//! The renderer never names a filesystem path: projects are ids, files are
//! paths from a closed set, and the core resolves both inside the active
//! user's realm.

pub mod context;
pub mod editor;
pub mod library;
pub mod preview;
pub mod project;
pub mod render;
pub mod templates;
pub mod tool;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::tools::Rejection;

/// Emitted after the assistant created or changed a video, so the chat can
/// open it in the side panel: `{conversation_id, project_id, title}`.
pub const CHANGED_EVENT: &str = "video://changed";

/// Largest kokoro reply read for a voice-over (about 10 minutes of WAV).
const MAX_VOICE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct ChangedPayload {
    pub conversation_id: i64,
    pub project_id: String,
    pub title: String,
}

/// The realm folder of the active, bound user of `profile_id`.
fn realm_dir(app: &AppHandle, profile_id: &str) -> Result<std::path::PathBuf, Rejection> {
    if !crate::profile::is_known_profile_id(profile_id) {
        return Err(Rejection::new("protocol", "unknown profile"));
    }
    crate::realm::dir_for(app, profile_id).map_err(|err| Rejection::new("protocol", err))
}

/// Synthesize a voice-over with kokoro (the same request `tts_speak`
/// sends), returning the WAV bytes. The key never leaves the core.
async fn speak(profile_id: &str, text: &str, voice: &str) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt as _;
    crate::tts::validate_voice(voice).map_err(|_| "unknown voice".to_string())?;
    let failed = || "the voice-over could not be generated; try again later".to_string();
    let key = crate::chat::read_profile_key(profile_id).map_err(|_| failed())?;
    let base = crate::chat::inference_base(profile_id).ok_or_else(failed)?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(
            crate::chat::CONNECT_TIMEOUT_SECS,
        ))
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| failed())?;
    let response = client
        .post(format!("{base}/audio/speech"))
        .bearer_auth(&key)
        .json(&crate::tts::speech_body(voice, text))
        .send()
        .await
        .map_err(|_| failed())?;
    if !response.status().is_success() {
        return Err(failed());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| failed())?;
        if bytes.len() + chunk.len() > MAX_VOICE_BYTES {
            return Err("the voice-over is too long".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if tool::wav_seconds(&bytes).is_none() {
        return Err(failed());
    }
    Ok(bytes)
}

/// Run `create_video` / `edit_video` for the chat tool loop. Returns the
/// tool-message content and, on success, the project id (the chat records
/// it and the side panel opens it).
pub async fn run_model_tool(
    app: &AppHandle,
    app_data: &std::path::Path,
    profile_id: &str,
    conversation_id: i64,
    name: &str,
    arguments: &str,
) -> (String, Option<String>) {
    let plan = match name {
        tool::CREATE => tool::parse_create(arguments),
        _ => tool::parse_edit(arguments),
    };
    let plan = match plan {
        Ok(plan) => plan,
        Err(message) => {
            return (
                tool::failure_for_model(&Rejection::new("invalid", message)),
                None,
            );
        }
    };
    let realm = match realm_dir(app, profile_id) {
        Ok(realm) => realm,
        Err(err) => return (tool::failure_for_model(&err), None),
    };
    let read_only = plan.read_only;
    let speak = |text: String, voice: String| {
        let profile_id = profile_id.to_string();
        async move { speak(&profile_id, &text, &voice).await }
    };
    let image = |from: &str| {
        let path = crate::images::verify_generated_image(app_data, std::path::Path::new(from))
            .map_err(|m| format!("{m} (pass the path generate_image returned)"))?;
        std::fs::read(path).map_err(|_| "cannot read the generated image".to_string())
    };
    match tool::run(&realm, plan, speak, image).await {
        Ok((id, result)) => {
            if !read_only {
                let _ = app.emit(
                    CHANGED_EVENT,
                    ChangedPayload {
                        conversation_id,
                        project_id: id.clone(),
                        title: result["title"].as_str().unwrap_or_default().to_string(),
                    },
                );
            }
            (result.to_string(), (!read_only).then_some(id))
        }
        Err(err) => (tool::failure_for_model(&err), None),
    }
}

// ------------------------------------------------------------ commands --

/// The library list, most recently changed first.
#[tauri::command]
pub async fn video_list(
    app: AppHandle,
    profile_id: String,
) -> Result<Vec<library::ProjectSummary>, Rejection> {
    let realm = realm_dir(&app, &profile_id)?;
    tauri::async_runtime::spawn_blocking(move || library::list_projects(&realm))
        .await
        .map_err(|_| Rejection::new("io", "interrupted"))
}

/// Assemble a project's sandboxed preview and register it; the renderer
/// shows the returned URL in the player and releases the token
/// (`preview_release_site`) when the player goes away.
#[tauri::command]
pub async fn video_preview(
    app: AppHandle,
    profile_id: String,
    project_id: String,
) -> Result<preview::PreviewInfo, Rejection> {
    let realm = realm_dir(&app, &profile_id)?;
    let (meta, doc) = tauri::async_runtime::spawn_blocking(move || {
        let dir = library::project_dir(&realm, &project_id)?;
        preview::assemble_project(&dir)
    })
    .await
    .map_err(|_| Rejection::new("io", "interrupted"))??;
    let registry = app
        .try_state::<crate::site_preview::SiteRegistry>()
        .ok_or_else(|| Rejection::new("io", "preview unavailable"))?;
    let token = registry.register_video(doc.into_bytes());
    Ok(preview::info(&meta, crate::site_preview::site_url(&token)))
}

fn locale(raw: &str) -> &'static str {
    if raw == "en" { "en" } else { "es" }
}

fn aspect(raw: Option<String>) -> Result<Option<project::Aspect>, Rejection> {
    raw.map(|a| {
        project::Aspect::parse(&a).ok_or_else(|| Rejection::new("invalid", "unknown aspect"))
    })
    .transpose()
}

/// The template gallery in the user's language.
#[tauri::command]
pub fn video_templates(locale: String) -> Vec<templates::TemplateSummary> {
    templates::list(self::locale(&locale))
}

/// A template's sandboxed preview (the gallery's live thumbnail and
/// detail view), in `aspect` and the user's language.
#[tauri::command]
pub async fn video_template_preview(
    app: AppHandle,
    template_id: String,
    aspect: Option<String>,
    locale: String,
) -> Result<preview::PreviewInfo, Rejection> {
    let aspect = self::aspect(aspect)?;
    let (meta, doc) = tauri::async_runtime::spawn_blocking(move || {
        let m = templates::materialize(&template_id, aspect, self::locale(&locale))?;
        let asset = |rel: &str| {
            m.assets
                .iter()
                .find(|(p, _)| p == rel)
                .map(|(_, b)| b.clone())
        };
        let doc = preview::assemble(&preview::Parts {
            meta: &m.meta,
            theme: &m.theme,
            scenes: &m.scenes,
            asset: &asset,
        })?;
        Ok::<_, Rejection>((m.meta, doc))
    })
    .await
    .map_err(|_| Rejection::new("io", "interrupted"))??;
    let registry = app
        .try_state::<crate::site_preview::SiteRegistry>()
        .ok_or_else(|| Rejection::new("io", "preview unavailable"))?;
    let token = registry.register_video(doc.into_bytes());
    Ok(preview::info(&meta, crate::site_preview::site_url(&token)))
}

/// "Use this template": a new project from it; returns the project id.
#[tauri::command]
pub async fn video_create_from_template(
    app: AppHandle,
    profile_id: String,
    template_id: String,
    aspect: Option<String>,
    locale: String,
) -> Result<String, Rejection> {
    let realm = realm_dir(&app, &profile_id)?;
    let aspect = self::aspect(aspect)?;
    tauri::async_runtime::spawn_blocking(move || {
        create_from_template_in(&realm, &template_id, aspect, self::locale(&locale))
    })
    .await
    .map_err(|_| Rejection::new("io", "interrupted"))?
}

/// [`video_create_from_template`] without the app (testable).
pub fn create_from_template_in(
    realm: &std::path::Path,
    template_id: &str,
    aspect: Option<project::Aspect>,
    locale: &str,
) -> Result<String, Rejection> {
    let m = templates::materialize(template_id, aspect, locale)?;
    let id = library::new_project_id();
    let dir = library::create_project_dir(realm, &id)?;
    let change = library::Change {
        meta: Some(m.meta),
        theme: Some(m.theme),
        scenes: m.scenes.into_iter().collect(),
        assets: m.assets,
    };
    if let Err(err) = library::apply(&dir, change) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(err);
    }
    Ok(id)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Rejection> + Send + 'static,
) -> Result<T, Rejection> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| Rejection::new("io", "interrupted"))?
}

/// The editor's view of a project.
#[tauri::command]
pub async fn video_get(
    app: AppHandle,
    profile_id: String,
    project_id: String,
) -> Result<editor::ProjectView, Rejection> {
    let realm = realm_dir(&app, &profile_id)?;
    blocking(move || {
        let dir = library::project_dir(&realm, &project_id)?;
        editor::view(&dir, &project_id)
    })
    .await
}

/// Apply an editor change; returns the new view.
#[tauri::command]
pub async fn video_update(
    app: AppHandle,
    profile_id: String,
    project_id: String,
    patch: editor::EditorPatch,
) -> Result<editor::ProjectView, Rejection> {
    let realm = realm_dir(&app, &profile_id)?;
    blocking(move || {
        let dir = library::project_dir(&realm, &project_id)?;
        editor::apply_patch(&dir, &patch)?;
        editor::view(&dir, &project_id)
    })
    .await
}

/// Pick a file in the NATIVE dialog for a slot (logo/image field, music,
/// voice-over). `None` when the user cancelled. The renderer never sends a
/// path.
#[tauri::command]
pub async fn video_pick_asset(
    app: AppHandle,
    profile_id: String,
    project_id: String,
    slot: editor::Slot,
) -> Result<Option<editor::ProjectView>, Rejection> {
    use tauri_plugin_dialog::DialogExt;
    let realm = realm_dir(&app, &profile_id)?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| Rejection::new("io", "cannot locate the app data folder"))?;
    let (name, extensions) = slot.filter();
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter(name, extensions)
            .blocking_pick_file()
    })
    .await
    .map_err(|_| Rejection::new("io", "interrupted"))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|_| Rejection::new("not_allowed", "this file cannot be used"))?;
    blocking(move || {
        let dir = library::project_dir(&realm, &project_id)?;
        let home = std::env::home_dir();
        let bytes =
            editor::read_picked(&app_data, home.as_deref(), &path, library::MAX_ASSET_BYTES)?;
        editor::import_picked(&dir, &slot, &path, bytes)?;
        editor::view(&dir, &project_id).map(Some)
    })
    .await
}

/// Delete a project (the renderer confirms with the user first).
#[tauri::command]
pub async fn video_delete(
    app: AppHandle,
    profile_id: String,
    project_id: String,
) -> Result<(), Rejection> {
    let realm = realm_dir(&app, &profile_id)?;
    blocking(move || library::delete_project(&realm, &project_id)).await
}

// ------------------------------------------------------------- export --

/// Emitted while the bundle uploads: `{project_id, sent, total}`.
pub const UPLOAD_EVENT: &str = "video://upload";

#[derive(Debug, Clone, Serialize)]
struct UploadProgress {
    project_id: String,
    sent: u64,
    total: u64,
}

/// Emitted while an MP4 downloads: `{project_id, received, total}`.
pub const DOWNLOAD_EVENT: &str = "video://download";

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    project_id: String,
    received: u64,
    total: Option<u64>,
}

/// The platform base and session JWT of the active profile (core only).
fn platform(profile_id: &str) -> Result<(String, String), render::ExportError> {
    if !crate::profile::is_known_profile_id(profile_id) {
        return Err(render::ExportError::new("invalid"));
    }
    let base = crate::device_flow::platform_base(profile_id)
        .ok_or_else(|| render::ExportError::new("unavailable"))?;
    let token = crate::chat::read_session_token(profile_id)
        .ok_or_else(|| render::ExportError::new("no_session"))?;
    Ok((base, token))
}

fn export_realm(
    app: &AppHandle,
    profile_id: &str,
) -> Result<std::path::PathBuf, render::ExportError> {
    realm_dir(app, profile_id).map_err(|_| render::ExportError::new("no_session"))
}

/// Debug builds pointed at the local mock platform may download its
/// loopback http URL; release builds: https only.
fn mock_download_allowed() -> bool {
    cfg!(debug_assertions)
        && std::env::var("NAN_DESKTOP_MOCK_PLATFORM").is_ok_and(|m| !m.trim().is_empty())
}

/// An optional export format from the renderer (`16:9`, `9:16`, `1:1`).
fn parse_aspect(raw: Option<&str>) -> Result<Option<project::Aspect>, render::ExportError> {
    match raw {
        None => Ok(None),
        Some(raw) => project::Aspect::parse(raw)
            .map(Some)
            .ok_or_else(|| render::ExportError::new("invalid")),
    }
}

/// Zip the project, check the 90 MiB cap, and start a server render.
/// `aspect` renders it in another format than its own (in memory; the
/// project is never changed).
#[tauri::command]
pub async fn video_export_start(
    app: AppHandle,
    profile_id: String,
    project_id: String,
    quality: String,
    aspect: Option<String>,
) -> Result<render::Started, render::ExportError> {
    let aspect = parse_aspect(aspect.as_deref())?;
    let realm = export_realm(&app, &profile_id)?;
    let (base, token) = platform(&profile_id)?;
    let project_for_events = project_id.clone();
    let (meta, bundle) = tauri::async_runtime::spawn_blocking(move || {
        let dir = library::project_dir(&realm, &project_id)?;
        render::prepare(&dir, &quality, aspect)
    })
    .await
    .map_err(|_| render::ExportError::new("io"))??;
    let emitter = app.clone();
    let pid = project_for_events.clone();
    let body_sent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sent_flag = body_sent.clone();
    let upload = tauri::async_runtime::spawn(async move {
        render::start(&base, &token, &meta, bundle, move |sent, total| {
            if sent >= total {
                sent_flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            let _ = emitter.emit(
                UPLOAD_EVENT,
                UploadProgress {
                    project_id: pid.clone(),
                    sent,
                    total,
                },
            );
        })
        .await
    });
    let uploads = app.state::<UploadsState>();
    uploads.insert(
        &project_for_events,
        upload.inner().abort_handle(),
        body_sent,
    );
    let result = upload.await;
    uploads.remove(&project_for_events);
    // An aborted upload closed the connection before the server admitted
    // the render: nothing was charged.
    result.unwrap_or_else(|_| Err(render::ExportError::new("canceled")))
}

/// Uploads in flight, by project: "Cancel" during the upload aborts the
/// request (the connection closes, the server never admits the render).
/// Once the whole body is sent the server may already have admitted (and
/// charged) the render, so the upload can no longer be aborted: it runs to
/// its reply, whose render id the renderer keeps (and can cancel, which
/// refunds).
type Upload = (
    tokio::task::AbortHandle,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
);

#[derive(Default)]
pub struct UploadsState(std::sync::Mutex<std::collections::HashMap<String, Upload>>);

impl UploadsState {
    fn insert(
        &self,
        project_id: &str,
        handle: tokio::task::AbortHandle,
        body_sent: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) {
        // A previous upload of the same project is only stopped while its
        // body is still going out: once sent, the server may have admitted
        // (and charged) it, so it runs to its reply.
        if let Ok(mut map) = self.0.lock()
            && let Some((previous, sent)) = map.insert(project_id.to_string(), (handle, body_sent))
            && !sent.load(std::sync::atomic::Ordering::SeqCst)
        {
            previous.abort();
        }
    }

    fn remove(&self, project_id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(project_id);
        }
    }

    /// Abort a project's upload while its body is still being sent;
    /// whether it was aborted.
    pub fn abort(&self, project_id: &str) -> bool {
        let Ok(mut map) = self.0.lock() else {
            return false;
        };
        let sent = match map.get(project_id) {
            Some((_, sent)) => sent.load(std::sync::atomic::Ordering::SeqCst),
            None => return false,
        };
        if sent {
            return false;
        }
        if let Some((handle, _)) = map.remove(project_id) {
            handle.abort();
        }
        true
    }
}

/// Cancel an export while its bundle is still uploading.
#[tauri::command]
pub fn video_export_abort(app: AppHandle, project_id: String) -> bool {
    library::valid_project_id(&project_id) && app.state::<UploadsState>().abort(&project_id)
}

/// A render's status (never its download URL).
#[tauri::command]
pub async fn video_export_status(
    profile_id: String,
    render_id: String,
) -> Result<render::Status, render::ExportError> {
    let (base, token) = platform(&profile_id)?;
    render::status(&base, &token, &render_id)
        .await
        .map(|(status, _)| status)
}

#[tauri::command]
pub async fn video_export_cancel(
    profile_id: String,
    render_id: String,
) -> Result<(), render::ExportError> {
    let (base, token) = platform(&profile_id)?;
    render::cancel(&base, &token, &render_id).await
}

#[tauri::command]
pub async fn video_export_quota(profile_id: String) -> Result<render::Quota, render::ExportError> {
    let (base, token) = platform(&profile_id)?;
    render::quota(&base, &token).await
}

/// Download a finished render into the project's `exports/` folder (a
/// fresh status gives the presigned URL, which never leaves the core).
#[tauri::command]
pub async fn video_export_download(
    app: AppHandle,
    profile_id: String,
    project_id: String,
    render_id: String,
    aspect: Option<String>,
) -> Result<editor::ExportView, render::ExportError> {
    let aspect = parse_aspect(aspect.as_deref())?;
    let realm = export_realm(&app, &profile_id)?;
    let (base, token) = platform(&profile_id)?;
    let (status, url) = render::status(&base, &token, &render_id).await?;
    let url = match (status.status.as_str(), url) {
        ("done", Some(url)) => url,
        ("done", None) => return Err(render::ExportError::new("expired")),
        _ => return Err(render::ExportError::new("not_ready")),
    };
    let dir = library::project_dir(&realm, &project_id)?;
    let title = library::read_meta(&dir)?.title;
    let name = render::export_name(&dir, &title, aspect);
    let emitter = app.clone();
    let pid = project_id.clone();
    let size = render::download(
        &url,
        &dir,
        &name,
        mock_download_allowed(),
        move |received, total| {
            let _ = emitter.emit(
                DOWNLOAD_EVENT,
                DownloadProgress {
                    project_id: pid.clone(),
                    received,
                    total,
                },
            );
        },
    )
    .await?;
    Ok(editor::ExportView { name, size })
}

/// The absolute path of an exported MP4 (validated name, real file).
fn export_path(
    app: &AppHandle,
    profile_id: &str,
    project_id: &str,
    name: &str,
) -> Result<std::path::PathBuf, Rejection> {
    if !library::valid_export_name(name) {
        return Err(Rejection::new("invalid", "unknown file"));
    }
    let realm = realm_dir(app, profile_id)?;
    let dir = library::project_dir(&realm, project_id)?;
    let path = dir.join("exports").join(name);
    if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file()) {
        return Err(Rejection::new("not_found", "the file no longer exists"));
    }
    Ok(path)
}

/// Open an exported MP4 with the system's video player.
#[tauri::command]
pub fn video_export_open(
    app: AppHandle,
    profile_id: String,
    project_id: String,
    name: String,
) -> Result<(), Rejection> {
    let path = export_path(&app, &profile_id, &project_id, &name)?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|_| Rejection::new("io", "the video could not be opened"))
}

/// Show an exported MP4 selected in Finder / Explorer / the file manager.
#[tauri::command]
pub fn video_export_reveal(
    app: AppHandle,
    profile_id: String,
    project_id: String,
    name: String,
) -> Result<(), Rejection> {
    let path = export_path(&app, &profile_id, &project_id, &name)?;
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|_| Rejection::new("io", "the folder could not be shown"))
}

/// "Save a copy as...": the native save dialog, then a plain copy.
#[tauri::command]
pub async fn video_export_save_as(
    app: AppHandle,
    profile_id: String,
    project_id: String,
    name: String,
) -> Result<bool, Rejection> {
    use tauri_plugin_dialog::DialogExt;
    let source = export_path(&app, &profile_id, &project_id, &name)?;
    let dialog_app = app.clone();
    let suggested = name.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        dialog_app
            .dialog()
            .file()
            .add_filter("MP4", &["mp4"])
            .set_file_name(&suggested)
            .blocking_save_file()
    })
    .await
    .map_err(|_| Rejection::new("io", "interrupted"))?;
    let Some(dest) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(false);
    };
    blocking(move || {
        std::fs::copy(&source, &dest)
            .map(|_| true)
            .map_err(|_| Rejection::new("io", "the copy could not be saved"))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn using_a_template_creates_a_complete_project_in_the_chosen_format() {
        let tmp = tempfile::tempdir().unwrap();
        let realm = tmp.path().join("realm");
        std::fs::create_dir(&realm).unwrap();
        let id = create_from_template_in(
            &realm,
            "product-promo",
            Some(project::Aspect::Portrait),
            "en",
        )
        .unwrap();
        let dir = library::project_dir(&realm, &id).unwrap();
        let meta = library::read_meta(&dir).unwrap();
        assert_eq!(meta.template.as_deref(), Some("product-promo"));
        assert_eq!(meta.aspect, project::Aspect::Portrait);
        assert_eq!(meta.title, "Product promo");
        let assets = library::list_assets(&dir);
        assert!(assets.contains_key("assets/logo.svg"));
        assert!(assets.contains_key("assets/fonts/inter-900.woff2"));
        let intro = library::read_text(&dir, "compositions/intro.html", 1 << 20)
            .unwrap()
            .unwrap();
        assert!(intro.contains("data-width=\"1080\" data-height=\"1920\""));
        // Ready to preview and to export.
        preview::assemble_project(&dir).unwrap();
        render::prepare(&dir, "standard", None).unwrap();
        assert!(create_from_template_in(&realm, "nope", None, "es").is_err());
        assert_eq!(library::list_projects(&realm).len(), 1);
    }

    #[test]
    fn an_upload_can_be_aborted_by_project() {
        let uploads = UploadsState::default();
        let task = tauri::async_runtime::spawn(async {
            std::future::pending::<()>().await;
        });
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        uploads.insert("p1", task.inner().abort_handle(), sent);
        assert!(!uploads.abort("p2"));
        assert!(uploads.abort("p1"));
        assert!(tauri::async_runtime::block_on(task).is_err(), "aborted");
        assert!(!uploads.abort("p1"), "only once");
        // Once the whole body is sent, the upload runs to its reply.
        let task = tauri::async_runtime::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        });
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        uploads.insert("p3", task.inner().abort_handle(), sent);
        assert!(!uploads.abort("p3"));
        assert!(tauri::async_runtime::block_on(task).is_ok(), "not aborted");
        // Nor does a second export of the same project stop it.
        let first = tauri::async_runtime::spawn(async {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        });
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
        uploads.insert("p4", first.inner().abort_handle(), sent);
        let second = tauri::async_runtime::spawn(async {});
        let fresh = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        uploads.insert("p4", second.inner().abort_handle(), fresh);
        assert!(
            tauri::async_runtime::block_on(first).is_ok(),
            "sent upload kept"
        );
    }
}
