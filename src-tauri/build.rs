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
    "tools_set_browser_mode",
    "tools_browser_allow_for_session",
    "preview_read_file",
    "preview_release_site",
    "preview_reveal_location",
    "web_preview_fetch",
    "artifact_link_preview",
    "video_list",
    "video_preview",
    "video_templates",
    "video_template_preview",
    "video_create_from_template",
    "video_get",
    "video_update",
    "video_pick_asset",
    "video_delete",
    "video_export_start",
    "video_export_status",
    "video_export_cancel",
    "video_export_quota",
    "video_export_download",
    "video_export_open",
    "video_export_reveal",
    "video_export_save_as",
    "open_external",
    "telemetry_renderer_crash",
    "update_check",
    "update_install",
    "attachments_pick",
    "attachments_stage_bytes",
    "attachment_read",
    "attachment_discard",
    "attachments_set_accepting",
    "attachments_internal_drag",
    "browser_state",
    "browser_control",
    "browser_set_language",
];

/// R-V1: embed every file under `video-templates/` (the bundled template
/// gallery and its shared OFL fonts) into the binary as
/// `$OUT_DIR/video_templates.rs`: `(relative path, bytes)` pairs, sorted.
fn embed_video_templates() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("video-templates");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        println!("cargo:rerun-if-changed={}", dir.display());
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let rel = path
                    .strip_prefix(&root)
                    .expect("inside root")
                    .to_string_lossy()
                    .replace('\\', "/");
                println!("cargo:rerun-if-changed={}", path.display());
                files.push((rel, path));
            }
        }
    }
    files.sort();
    let mut out = String::from("pub static FILES: &[(&str, &[u8])] = &[\n");
    for (rel, path) in files {
        out.push_str(&format!(
            "    ({rel:?}, include_bytes!({:?})),\n",
            path.display().to_string()
        ));
    }
    out.push_str("];\n");
    let dest = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR"))
        .join("video_templates.rs");
    std::fs::write(dest, out).expect("write video_templates.rs");
}

fn main() {
    embed_video_templates();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
