// nan-desktop Tauri v2 core: command registry and window setup.
//
// All HTTP, credentials and filesystem access live in this Rust core; the
// renderer only invokes the commands registered below and listens to the
// events they emit. Credentials stay in the OS keychain (S4).
//
// Zero telemetry (S8): the app only talks to the two locked tenants' own
// URLs (plus the debug-only mock overrides documented in `device_flow` and
// `chat`).

mod chat;
mod chat_store;
mod conn_test;
mod device_flow;
mod images;
// Safe URL handling: open_external validation + main-window navigation
// guard (external review B3).
mod links;
// Conversation memory: account-synced (default) or this-device-only.
mod memory;
mod profile;
// Incremental SSE parser shared by the streaming chat surface.
mod sse;
mod stt;
// Tools subsystem: folder grants + propose/approve/execute tool actions.
mod tools;
mod tts;
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

/// A profile as seen by the UI: id, display name and keychain state. No
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

/// Probe the keychain for a profile's stored key without exposing it.
fn key_status(profile_id: &str) -> Result<(bool, Option<String>), String> {
    match keyring::Entry::new(profile::KEYRING_SERVICE, &profile::key_account(profile_id))
        .and_then(|entry| entry.get_password())
    {
        Ok(value) => Ok((true, Some(profile::mask_key(&value)))),
        Err(keyring::Error::NoEntry) => Ok((false, None)),
        Err(err) => Err(err.to_string()),
    }
}

fn store_overview(store: &ProfileStore) -> Result<ProfileOverview, String> {
    let mut profiles = Vec::with_capacity(store.profiles.len());
    for p in &store.profiles {
        let (has_key, key_mask) = key_status(&p.id)?;
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

/// List the two locked profiles with their keychain state (no key material,
/// no URLs).
#[tauri::command]
fn profiles_load(app: AppHandle) -> Result<ProfileOverview, String> {
    let dir = profiles_dir(&app)?;
    let store = profile::load_or_seed(&dir)?;
    store_overview(&store)
}

/// Static app facts for the Settings "About" section.
#[derive(Clone, Serialize)]
struct AppInfo {
    version: String,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
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
        // Native folder picker + confirmation dialogs for tools (S7).
        .plugin(tauri_plugin_dialog::init())
        // External review B3: the main window is created PROGRAMMATICALLY
        // (not from tauri.conf.json) so the navigation guard can be
        // attached — the renderer can never navigate the window to a remote
        // origin (in-window phishing). Markdown links go through
        // links::open_external instead.
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("Helmcode")
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
            tts::tts_speak,
            tts::tts_stop,
            stt::stt_transcribe,
            images::image_generate,
            images::image_cancel,
            tools::tools_grant_add,
            tools::tools_grant_computer_wide,
            tools::tools_grant_list,
            tools::tools_grant_revoke,
            tools::tools_settings_get,
            tools::tools_set_run_command_enabled,
            links::open_external
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
