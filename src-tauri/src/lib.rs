// nan-desktop Tauri v2 core: command registry and window setup.
//
// All HTTP, credentials and filesystem access live in this Rust core; the
// renderer only invokes the commands registered below and listens to the
// events they emit. Credentials live in the encrypted vault (`credentials`):
// one AES-256-GCM file whose master key is the app's only keychain item.
// Round 13 (S2): that item is stamped with the build's code-signing
// fingerprint, so an item created by another signature is deleted (never
// read) and macOS never asks for the login keychain password.
//
// Zero telemetry (S8): the app only talks to the two locked tenants' own
// URLs (plus the debug-only mock overrides documented in `device_flow` and
// `chat`).

// Shared artifacts (F1): snapshot upload of a granted file + link list/revoke.
mod artifacts;
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
// Child processes: every spawn hides its console window on Windows.
mod process;
mod profile;
// R20-D: sandboxed preview of the websites write_website built.
mod site_preview;
// Per-user data realms (privacy fix): user binding, realm folders, the
// one-time claim of pre-realm data.
mod realm;
// Local skills (T14/S1): store, bundle validation and the context block.
mod skills;
// Shared skills (S4): org library API passthrough + offline team cache.
mod skills_team;
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
// Turn continuity: end reasons, step budget, tool-trace replay, summary.
mod turn;
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

/// The account signed in to the active profile (privacy fix): the identity
/// chip shows it, and the renderer scopes its own per-conversation storage
/// with `realm` (the realm hash, never the raw user id). Only the ACTIVE
/// profile's user is ever exposed: the picker never names who used the
/// other profile, or this one before.
#[derive(Clone, Serialize, PartialEq, Eq, Debug)]
struct ActiveUser {
    email: Option<String>,
    realm: String,
}

#[derive(Clone, Serialize)]
struct ProfileOverview {
    profiles: Vec<ProfileView>,
    active_profile: Option<String>,
    active_user: Option<ActiveUser>,
    /// The app was updated from a pre-realm build and nobody has signed in
    /// since: the login screen tells everyone to sign in one more time.
    relogin_pending: bool,
}

fn profiles_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|err| err.to_string())
}

/// Probe the vault for a profile's stored key without exposing it. Any
/// storage failure degrades to "no key" (logged out) so the profile list
/// always renders and the user can simply sign in again.
fn key_status(profile_id: &str) -> (bool, Option<String>) {
    // Privacy fix: only the bound user's realm-keyed slot counts.
    let Some((account, _)) = realm::accounts(profile_id) else {
        return (false, None);
    };
    match credentials::store().and_then(|store| store.get(&account)) {
        Ok(Some(value)) if !value.is_empty() => (true, Some(profile::mask_key(&value))),
        _ => (false, None),
    }
}

/// The active profile's signed-in user, when it has one.
fn active_user(store: &ProfileStore) -> Option<ActiveUser> {
    let (_, user) = store.active_binding()?;
    Some(ActiveUser {
        email: user.email.clone(),
        realm: user.realm.clone(),
    })
}

fn store_overview(store: &ProfileStore) -> Result<ProfileOverview, String> {
    Ok(overview_with(store, key_status))
}

/// [`store_overview`] with the credential probe injected (testable).
fn overview_with(
    store: &ProfileStore,
    key_status: impl Fn(&str) -> (bool, Option<String>),
) -> ProfileOverview {
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
    // A user who signed out (or whose key is gone) is not "signed in": no
    // identity is exposed for them.
    let signed_in = profiles
        .iter()
        .any(|p| Some(&p.id) == store.active_profile.as_ref() && p.has_key);
    ProfileOverview {
        profiles,
        active_profile: store.active_profile.clone(),
        active_user: if signed_in { active_user(store) } else { None },
        relogin_pending: store.relogin_pending,
    }
}

/// List the two locked profiles with their credential state (no key material,
/// no URLs).
#[tauri::command]
fn profiles_load(app: AppHandle) -> Result<ProfileOverview, String> {
    let dir = profiles_dir(&app)?;
    let store = profile::load_or_seed(&dir)?;
    purge_legacy_credentials();
    store_overview(&store)
}

/// Privacy fix: the pre-realm, profile-keyed vault entries (`nan`,
/// `nan.session`, ...) do not say WHICH user they belong to, so they are
/// never read as credentials again. Dropping them on load means an upgraded
/// install shows the sign-in once; that login binds the user (realm.rs).
/// Best-effort: a failure only leaves unreadable entries behind.
fn purge_legacy_credentials() {
    let accounts: Vec<String> = profile::canonical_profiles()
        .iter()
        .flat_map(|p| {
            [
                profile::legacy_key_account(&p.id),
                profile::legacy_session_account(&p.id),
            ]
        })
        .collect();
    let refs: Vec<&str> = accounts.iter().map(String::as_str).collect();
    let _ = credentials::store().and_then(|store| store.delete_many(&refs));
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
        .manage(site_preview::SiteRegistry::default())
        // R20-D: the sandboxed website preview frame. Serves ONLY bytes
        // preview_read_file already gated and registered (never the disk),
        // under the site CSP header (no network) + a sandbox directive.
        .register_uri_scheme_protocol(site_preview::SCHEME, |ctx, request| {
            let registry = ctx.app_handle().state::<site_preview::SiteRegistry>();
            site_preview::respond(&registry, request.method().as_str(), request.uri().path())
        })
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
            // Install the credential vault (round 5): one AES-256-GCM file
            // whose master key is the app's only keychain item. Round 13 (S2)
            // adds the startup stamp gate inside `credentials::init`: the
            // build's code-signing fingerprint is resolved here (one
            // non-interactive `codesign` probe, no network, no UI) and a
            // vault written by a different signature is deleted instead of
            // read, so upgrading never raises the macOS keychain dialog.
            // No disk or keychain access happens until the first credential
            // read. An unresolvable app data dir leaves the vault
            // uninitialized -> every profile reads as logged out (never a
            // panic).
            if let Ok(dir) = app.path().app_data_dir() {
                credentials::init(&dir);
                // Per-user realms: credential lookups resolve the bound
                // user from profiles.json under this root.
                realm::init(&dir);
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
            chat::conversation_rename,
            chat::messages_list,
            memory::memory_settings_get,
            memory::memory_set_mode,
            memory::memory_sync,
            skills::skills_list,
            skills::skills_create,
            skills::skills_update,
            skills::skills_delete,
            skills::skills_bundle,
            skills_team::skills_team_request,
            skills_team::skills_team_cache_load,
            skills_team::skills_team_cache_store_list,
            skills_team::skills_team_cache_put,
            skills_team::skills_team_cache_get,
            skills_team::skills_team_cache_clear,
            skills_team::skills_team_link,
            artifacts::artifacts_request,
            artifacts::artifact_share,
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
            preview::preview_release_site,
            preview::preview_reveal_location,
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
    use super::*;

    #[test]
    fn only_the_active_signed_in_user_is_exposed_to_the_renderer() {
        let mut store = profile::default_store();
        store
            .bind(
                "nan",
                profile::BoundUser::new("nan", "u-a", Some("a@example.com".into())),
            )
            .unwrap();
        store
            .bind(
                "helmcode",
                profile::BoundUser::new("helmcode", "u-h", Some("h@corp.com".into())),
            )
            .unwrap();
        let has_key = |_: &str| (true, Some("••••1234".to_string()));
        // Nothing active (signed out): nobody is named, not even the
        // profile's previous user (the picker must not reveal them).
        let overview = overview_with(&store, has_key);
        assert_eq!(overview.active_user, None);
        // Active + key: exactly that profile's user, by email + realm hash.
        store.set_active_profile("nan").unwrap();
        let overview = overview_with(&store, has_key);
        assert_eq!(
            overview.active_user,
            Some(ActiveUser {
                email: Some("a@example.com".into()),
                realm: realm::realm_hash("nan:u-a"),
            })
        );
        let json = serde_json::to_string(&overview.active_user).unwrap();
        assert!(!json.contains("u-a"), "the raw user id never crosses IPC");
        assert!(!json.contains("h@corp.com"));
        // Active but no key (revoked / signed out elsewhere): not exposed.
        let overview = overview_with(&store, |_| (false, None));
        assert_eq!(overview.active_user, None);
    }

    #[test]
    fn the_one_time_relogin_flag_reaches_the_renderer_until_the_first_bind() {
        let mut store = profile::default_store();
        let none = |_: &str| (false, None);
        assert!(!overview_with(&store, none).relogin_pending);
        store.relogin_pending = true;
        assert!(overview_with(&store, none).relogin_pending);
        store
            .bind("nan", profile::BoundUser::new("nan", "u-a", None))
            .unwrap();
        assert!(!overview_with(&store, none).relogin_pending);
    }

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
