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
//!
//! The renderer never names a filesystem path: projects are ids, files are
//! paths from a closed set, and the core resolves both inside the active
//! user's realm.

pub mod library;
pub mod preview;
pub mod project;
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
