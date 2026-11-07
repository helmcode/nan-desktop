// nan-desktop Tauri v2 core: command registry and window setup.
//
// All HTTP, credentials and filesystem access live in this Rust core; the
// renderer only invokes the commands registered below and listens to the
// events they emit. Credentials live in the encrypted vault (`credentials`):
// one AES-256-GCM file whose master key is the app's only keychain item.
//
// Zero telemetry (S8): the app only talks to the two locked tenants' own
// URLs (plus the debug-only mock overrides documented in `device_flow` and
// `chat`).

mod chat;
mod chat_store;
mod conn_test;
// Credential vault: one encrypted file, one master key (round 5).
mod credentials;
mod device_flow;
// Image editing (`/v1/images/edits`, desktop sessions only).
mod image_edit;
mod images;
// Safe URL handling: open_external validation + main-window navigation
// guard (external review B3).
mod links;
// Conversation memory: account-synced (default) or this-device-only.
mod memory;
// Preview pane backends (S21): granted-file reads + platform page fetch.
mod preview;
mod profile;
// Local skills (T14/S1): store, bundle validation and the context block.
mod skills;
// Incremental SSE parser shared by the streaming chat surface.
mod sse;
mod stt;
// Tool-call markup leaked into content (DSML): streaming filter + parser
// that turns it into real tool calls and keeps it out of the UI (S16).
mod tool_markup;
// Tools subsystem: folder grants (ask/allow modes) + propose / approve
// (auto, inline card or native dialog) / execute tool actions.
mod tools;
mod tts;
// Auto-update (round 7): silent check, install only on the user's click.
mod updater;
// Built-in web search the model can call (proxied by the platform API).
mod web_search;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use profile::ProfileStore;

// ------------------------------------------------------- T3b / T13 ----
// Profile lockdown + device-flow login glue. Profile URLs are compiled-in
// constants (S2/S12) and never cross this boundary: the renderer sees only
// ids, names and masked key state. Secrets are written by the Rust core
// (`device_flow.rs`), never by the renderer.

/// A profile as seen by the UI: id, display name and credential state. No
/// base URL — the renderer never receives one (S4/S12).
#[derive(Clone, Serialize)]
struct ProfileView {
    id: String,
    name: String,
    has_key: bool,
    key_mask: Option<String>,
}

#[derive(Clone, Serialize)]
struct ProfileOverview {
    profiles: Vec<ProfileView>,
    active_profile: Option<String>,
}

fn profiles_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|err| err.to_string())
}

/// Probe the vault for a profile's stored key without exposing it. Any
/// storage failure degrades to "no key" (logged out) so the profile list
/// always renders and the user can simply sign in again.
fn key_status(profile_id: &str) -> (bool, Option<String>) {
    match credentials::store().and_then(|store| store.get(&profile::key_account(profile_id))) {
        Ok(Some(value)) if !value.is_empty() => (true, Some(profile::mask_key(&value))),
        _ => (false, None),
    }
}

fn store_overview(store: &ProfileStore) -> Result<ProfileOverview, String> {
    let mut profiles = Vec::with_capacity(store.profiles.len());
    for p in &store.profiles {
        let (has_key, key_mask) = key_status(&p.id);
        profiles.push(ProfileView {
            id: p.id.clone(),
            name: p.name.clone(),
            has_key,
            key_mask,
        });
    }
    Ok(ProfileOverview {
        profiles,
        active_profile: store.active_profile.clone(),
    })
}

/// List the two locked profiles with their credential state (no key material,
/// no URLs).
#[tauri::command]
fn profiles_load(app: AppHandle) -> Result<ProfileOverview, String> {
    let dir = profiles_dir(&app)?;
    let store = profile::load_or_seed(&dir)?;
    store_overview(&store)
}

/// Static app facts for the Settings "About" section and build flags.
#[derive(Clone, Serialize)]
struct AppInfo {
    version: String,
    /// S24: the voice UI (mic dictation + read-aloud) is parked this round.
    /// The renderer shows mic/listen controls ONLY when this is true; it is
    /// true only in builds with the `voice-ui` cargo feature (default OFF).
    /// The voice code (`stt.rs`, `tts.rs` and their commands) is kept and
    /// still compiled, so re-enabling is a build flag, not a rewrite.
    voice_ui: bool,
}

/// Whether this build ships the voice UI (S24, cargo feature `voice-ui`).
const fn voice_ui_enabled() -> bool {
    cfg!(feature = "voice-ui")
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        voice_ui: voice_ui_enabled(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Debug and release builds expose exactly the same IPC surface: the
    // product commands below and nothing else (no developer diagnostics).
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(device_flow::DeviceLoginState::default())
        .manage(chat::ChatState::default())
        .manage(tts::TtsState::default())
        .manage(images::ImagesState::default())
        .manage(tools::ToolsState::default())
        .manage(memory::MemoryState::default())
        .manage(updater::UpdaterState::default())
        // Signed auto-update (round 7). Used only from the core's own
        // update_check / update_install commands, so no updater permission
        // is granted to the renderer.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Native folder picker + confirmation dialogs for tools (S7).
        .plugin(tauri_plugin_dialog::init())
        // External review B3: the main window is created PROGRAMMATICALLY
        // (not from tauri.conf.json) so the navigation guard can be
        // attached — the renderer can never navigate the window to a remote
        // origin (in-window phishing). Markdown links go through
        // links::open_external instead.
        .setup(|app| {
            // Install the credential vault. Lazy: no disk or keychain access
            // happens until the first credential read. An unresolvable app
            // data dir leaves it uninitialized → every profile reads as
            // logged out (never a panic).
            if let Ok(dir) = app.path().app_data_dir() {
                credentials::init(&dir);
                // Round 6: best-effort cleanup of generated images no
                // conversation references any more (background, never fails
                // startup).
                images::sweep_orphans_in_background(dir);
            }
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                // S18: window/about name is "Helmcode Desktop".
                .title("Helmcode Desktop")
                .inner_size(1180.0, 780.0)
                .min_inner_size(820.0, 560.0)
                .on_navigation(|url| links::navigation_allowed(url.as_str()))
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            profiles_load,
            app_info,
            conn_test::connection_test,
            device_flow::device_login_start,
            device_flow::device_login_cancel,
            device_flow::device_logout,
            chat::chat_send,
            chat::chat_stop,
            chat::models_list,
            chat::conversation_list,
            chat::conversation_create,
            chat::conversation_delete,
            chat::messages_list,
            memory::memory_settings_get,
            memory::memory_set_mode,
            memory::memory_sync,
            skills::skills_list,
            skills::skills_create,
            skills::skills_update,
            skills::skills_delete,
            tts::tts_speak,
            tts::tts_stop,
            stt::stt_transcribe,
            images::image_generate,
            images::image_cancel,
            images::image_save_as,
            image_edit::edit_images,
            image_edit::image_edit_pick,
            image_edit::image_edit_stage,
            image_edit::image_edit_stage_annotation,
            tools::tools_grant_add,
            tools::tools_grant_computer_wide,
            tools::tools_grant_list,
            tools::tools_grant_revoke,
            tools::tools_grant_mode_get,
            tools::tools_grant_set_mode,
            tools::tools_approval_respond,
            tools::tools_settings_get,
            tools::tools_set_run_command_enabled,
            preview::preview_read_file,
            preview::web_preview_fetch,
            links::open_external,
            updater::update_check,
            updater::update_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
#[cfg(test)]
mod tests {
    #[test]
    fn voice_ui_is_parked_by_default() {
        // S24: default builds hide the voice UI; `--features voice-ui`
        // turns it back on.
        #[cfg(not(feature = "voice-ui"))]
        assert!(!super::voice_ui_enabled());
        #[cfg(feature = "voice-ui")]
        assert!(super::voice_ui_enabled());
    }
}
