// T1 spike validation for the nan-desktop Tauri v2 app.
//
// Proves three Rust-core capabilities end to end:
// 1. SSE streaming: HTTP lives in Rust (reqwest), parsed events are emitted
//    to the UI as Tauri events (S4 transport).
// 2. Keychain storage via the `keyring` crate (S4): API keys never enter the
//    web renderer process.
// 3. SQLite local history foundation via `rusqlite` (bundled).
//
// Zero telemetry (S8): the app only talks to the two locked tenants' own
// URLs (plus the debug-only mock override documented in `device_flow`).

mod chat;
mod chat_store;
mod conn_test;
mod device_flow;
mod images;
// Safe URL handling: open_external validation + main-window navigation
// guard (external review B3).
mod links;
mod profile;
// T8 tools subsystem: folder grants + propose/approve/execute tool actions.
// Production IPC surface (registered in BOTH debug and release handlers).
mod tools;
// Spike-only module: the demo DB commands it serves are not registered in
// release builds (security review B1/B6 — no keychain or arbitrary-IO surface
// in the production IPC).
#[cfg(debug_assertions)]
mod spike_db;
mod sse;
mod stt;
mod tts;

#[cfg(debug_assertions)]
use std::sync::Mutex;

use serde::Serialize;
#[cfg(debug_assertions)]
use tauri::State;
#[cfg(debug_assertions)]
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};
#[cfg(debug_assertions)]
use tauri::{Emitter, Window};

use profile::ProfileStore;
#[cfg(debug_assertions)]
use sse::{flush_sse_buffer, parse_sse_buffer};

/// Handle of the running SSE demo task. Starting a new stream aborts the
/// previous one, so `sse_demo_start` stays cancel-safe.
#[cfg(debug_assertions)]
#[derive(Default)]
struct SseState(Mutex<Option<JoinHandle<()>>>);

/// One parsed SSE event, forwarded to the frontend as `sse://chunk`.
#[cfg(debug_assertions)]
#[derive(Clone, Serialize)]
struct SseChunk {
    seq: usize,
    text: String,
}

/// Start streaming SSE from `url`, emitting `sse://chunk`, `sse://done` and
/// `sse://error` events to the window. A previous stream, if any, is aborted.
/// Debug-builds only (security review B2: arbitrary-URL fetch from the
/// renderer is an SSRF primitive and must not exist in release IPC).
#[cfg(debug_assertions)]
#[tauri::command]
fn sse_demo_start(url: String, window: Window, state: State<'_, SseState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "SSE state mutex poisoned".to_string())?;
    if let Some(previous) = guard.take() {
        previous.abort();
    }
    *guard = Some(tauri::async_runtime::spawn(run_sse_demo(url, window)));
    Ok(())
}

#[cfg(debug_assertions)]
async fn run_sse_demo(url: String, window: Window) {
    match reqwest::get(&url).await {
        Ok(response) if !response.status().is_success() => {
            let _ = window.emit("sse://error", format!("HTTP {}", response.status()));
        }
        Ok(response) => stream_sse(response, &window).await,
        Err(err) => {
            let _ = window.emit("sse://error", err.to_string());
        }
    }
}

#[cfg(debug_assertions)]
async fn stream_sse(response: reqwest::Response, window: &Window) {
    use futures_util::StreamExt;

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut seq: usize = 0;

    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                // Spike simplification: lossy UTF-8 decoding. A multi-byte
                // character split across chunk boundaries may be replaced;
                // the chat MVP (T4) will use incremental decoding.
                buffer.push_str(&String::from_utf8_lossy(&bytes));
                for text in parse_sse_buffer(&mut buffer) {
                    seq += 1;
                    let _ = window.emit("sse://chunk", SseChunk { seq, text });
                }
            }
            Err(err) => {
                let _ = window.emit("sse://error", err.to_string());
                return;
            }
        }
    }

    for text in flush_sse_buffer(&mut buffer) {
        seq += 1;
        let _ = window.emit("sse://chunk", SseChunk { seq, text });
    }
    let _ = window.emit("sse://done", seq);
}

/// Store `value` in the OS keychain (macOS Keychain / Windows Credential
/// Manager / Linux Secret Service). Used by the T1 spike panel; real login
/// credentials are stored by the Rust core in `device_flow.rs`.
/// Deliberately not covered by an automated test: macOS may pop a Keychain
/// permission prompt in headless runs (see README "T1 spike" section).
/// Debug-builds only (security review B1: renderer-controlled service/account
/// would expose the whole keychain over IPC).
#[cfg(debug_assertions)]
#[tauri::command]
fn keyring_set(service: String, account: String, value: String) -> Result<(), String> {
    keyring::Entry::new(&service, &account)
        .and_then(|entry| entry.set_password(&value))
        .map_err(|err| err.to_string())
}

/// Read a value back from the OS keychain. Returns `Ok(None)` when the entry
/// does not exist, so the UI can distinguish "missing" from a real error.
/// Debug-builds only (security review B1).
#[cfg(debug_assertions)]
#[tauri::command]
fn keyring_get(service: String, account: String) -> Result<Option<String>, String> {
    match keyring::Entry::new(&service, &account).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

/// SQLite demo: creates `messages` under the app data dir if missing,
/// inserts one demo row per call and returns the last 10 rows by id.
/// Debug-builds only (security review B6).
#[cfg(debug_assertions)]
#[tauri::command]
fn db_demo(app: AppHandle) -> Result<Vec<spike_db::Message>, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let mut conn =
        rusqlite::Connection::open(dir.join("spike.db")).map_err(|err| err.to_string())?;

    let unix_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let content = format!("Spike demo row at {unix_secs}");

    spike_db::insert_and_recent_messages(&mut conn, "assistant", &content)
        .map_err(|err| err.to_string())
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Security review B1/B2/B6: the spike commands exist only in debug
    // builds. Release IPC exposes exactly the product surface.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(device_flow::DeviceLoginState::default())
        .manage(chat::ChatState::default())
        .manage(tts::TtsState::default())
        .manage(images::ImagesState::default())
        .manage(tools::ToolsState::default())
        // T8: native folder picker for tools grants (S7). Registered in
        // lib.rs so the capability is dialog:default only.
        .plugin(tauri_plugin_dialog::init())
        // External review B3: the main window is created PROGRAMMATICALLY
        // (not from tauri.conf.json) so the navigation guard can be
        // attached — the renderer can never navigate the window to a remote
        // origin (in-window phishing). Markdown links go through
        // links::open_external instead.
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("nan-desktop")
                .inner_size(800.0, 600.0)
                .on_navigation(|url| links::navigation_allowed(url.as_str()))
                .build()?;
            Ok(())
        });
    #[cfg(debug_assertions)]
    let builder = builder
        .manage(SseState::default())
        .invoke_handler(tauri::generate_handler![
            sse_demo_start,
            keyring_set,
            keyring_get,
            db_demo,
            profiles_load,
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
            tts::tts_speak,
            tts::tts_stop,
            stt::stt_transcribe,
            images::image_generate,
            images::image_cancel,
            tools::tools_grant_add,
            tools::tools_grant_list,
            tools::tools_grant_revoke,
            tools::tools_settings_get,
            tools::tools_set_run_command_enabled,
            tools::tools_propose,
            links::open_external,
            tools::tools_execute,
            tools::tools_deny,
            tools::tools_audit_tail
        ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        profiles_load,
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
        tts::tts_speak,
        tts::tts_stop,
        stt::stt_transcribe,
        images::image_generate,
        images::image_cancel,
        tools::tools_grant_add,
        tools::tools_grant_list,
        tools::tools_grant_revoke,
        tools::tools_settings_get,
        tools::tools_set_run_command_enabled,
        tools::tools_propose,
        links::open_external,
        tools::tools_execute,
        tools::tools_deny,
        tools::tools_audit_tail
    ]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
