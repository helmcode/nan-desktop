// Build script: Tauri codegen + the app's command ACL.
//
// In-app browser isolation: declaring the app's own commands in an ACL
// manifest makes Tauri check EVERY app command against the capabilities
// (`capabilities/default.json`), which grant them to the `main` window
// only. Without a manifest, app commands are allowed to any window showing
// a local origin; with it, the assistant's browser window (label
// `browser`, in no capability) can reach no command at all, whatever page
// it shows. `lib.rs` tests that this list, `generate_handler!` and the
// capability stay identical: a command missing here is REFUSED at runtime.

const APP_COMMANDS: &[&str] = &[
    "profiles_load",
    "app_info",
    "connection_test",
    "device_login_start",
    "device_login_cancel",
    "device_logout",
    "chat_send",
    "chat_stop",
    "models_list",
    "conversation_list",
    "conversation_create",
    "conversation_delete",
    "conversation_rename",
    "messages_list",
    "memory_settings_get",
    "memory_set_mode",
    "memory_sync",
    "skills_list",
    "skills_create",
    "skills_update",
    "skills_delete",
    "skills_bundle",
    "skills_team_request",
    "skills_team_cache_load",
    "skills_team_cache_store_list",
    "skills_team_cache_put",
    "skills_team_cache_get",
    "skills_team_cache_clear",
    "skills_team_link",
    "artifacts_request",
    "artifact_share",
    "tts_speak",
    "tts_stop",
    "stt_transcribe",
    "image_generate",
    "image_cancel",
    "image_save_as",
    "edit_images",
    "image_edit_pick",
    "image_edit_stage",
    "image_edit_stage_annotation",
    "tools_grant_add",
    "tools_grant_computer_wide",
    "tools_grant_list",
    "tools_grant_revoke",
    "tools_grant_mode_get",
    "tools_grant_set_mode",
    "tools_approval_respond",
    "tools_settings_get",
    "tools_set_run_command_enabled",
    "tools_set_browser_guard",
    "preview_read_file",
    "preview_release_site",
    "preview_reveal_location",
    "web_preview_fetch",
    "open_external",
    "telemetry_renderer_crash",
    "update_check",
    "update_install",
    "browser_state",
    "browser_control",
    "browser_set_language",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
