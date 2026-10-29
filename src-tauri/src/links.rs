//! Safe URL handling (external review B3 + QW3).
//!
//! Two pure layers, both unit-tested:
//! - [`validate_external_url`]: the `open_external` command's allow-rule —
//!   the ONLY way renderer-supplied URLs reach the OS opener (https-only).
//! - [`navigation_allowed`]: the main-window navigation guard attached via
//!   `WebviewWindowBuilder::on_navigation` — the renderer can never navigate
//!   the window to a remote origin (in-window phishing), even if the
//!   markdown sanitization were bypassed.
//!
//! The device-flow `verification_url` parse lives in device_flow.rs.

/// Validate a renderer-supplied URL for opening in the system browser.
/// Scheme must be https and a host must be present; credentials in the URL
/// are rejected. Returns the normalized URL on success.
pub fn validate_external_url(raw: &str) -> Result<String, String> {
    let url = tauri::Url::parse(raw).map_err(|err| format!("invalid URL: {err}"))?;
    if url.scheme() != "https" {
        return Err(format!(
            "only https URLs can be opened, got {:?}",
            url.scheme()
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("URL has no host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL must not carry credentials".into());
    }
    Ok(url.as_str().to_string())
}

/// Decide whether the main webview may navigate to `raw`. The app's own
/// origins (Tauri protocol / tauri.localhost), the asset protocol (local
/// images), about:/blob:/data: pseudo-URLs and the dev-server origin are
/// allowed; every remote http(s) origin is denied.
pub fn navigation_allowed(raw: &str) -> bool {
    let Ok(url) = tauri::Url::parse(raw) else {
        return false;
    };
    match url.scheme() {
        // App custom protocol + asset protocol (local image previews).
        "tauri" | "asset" => url.host_str() == Some("localhost"),
        // Windows app/asset origins and the Vite dev server.
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            matches!(host, "tauri.localhost" | "asset.localhost")
                || matches!(host, "localhost" | "127.0.0.1") && url.port() == Some(1420)
        }
        // Pseudo-URLs: blank frames, blob previews, inline data URIs.
        "about" | "blob" | "data" | "ipc" => true,
        _ => false,
    }
}

/// Open a renderer-supplied URL in the system browser — the ONLY path from
/// the renderer to the OS opener. [`validate_external_url`] enforces the
/// policy (https-only, host required, no credentials); the main window can
/// never navigate there (see [`navigation_allowed`]).
#[tauri::command]
pub fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_external_accepts_https_and_normalizes() {
        assert_eq!(
            validate_external_url("https://example.com/docs?a=1").expect("ok"),
            "https://example.com/docs?a=1"
        );
        // Uppercase scheme/host are normalized by the parser.
        let normalized = validate_external_url("HTTPS://EXAMPLE.COM/Path").expect("ok");
        assert!(normalized.starts_with("https://example.com/"));
    }

    #[test]
    fn open_external_rejects_non_https_and_hostless() {
        assert!(
            validate_external_url("http://example.com/x").is_err(),
            "http"
        );
        assert!(
            validate_external_url("javascript:alert(1)").is_err(),
            "javascript"
        );
        assert!(validate_external_url("file:///etc/passwd").is_err(), "file");
        assert!(validate_external_url("https://").is_err(), "no host");
        assert!(validate_external_url("not a url").is_err(), "garbage");
        assert!(
            validate_external_url("https://user:pw@example.com/").is_err(),
            "credentials in URL"
        );
    }

    #[test]
    fn navigation_guard_allows_app_and_asset_origins() {
        // App origins (macOS/Linux protocol + Windows localhost + dev).
        assert!(navigation_allowed("tauri://localhost/index.html"));
        assert!(navigation_allowed("https://tauri.localhost/index.html"));
        assert!(navigation_allowed("http://tauri.localhost/index.html"));
        assert!(navigation_allowed("http://localhost:1420/"));
        assert!(navigation_allowed("http://127.0.0.1:1420/"));
        // Asset protocol: local image previews (convertFileSrc).
        assert!(navigation_allowed("asset://localhost/Users/me/pic.png"));
        assert!(navigation_allowed(
            "http://asset.localhost/Users/me/pic.png"
        ));
        // Pseudo-URLs used by subresources and blank frames.
        assert!(navigation_allowed("about:blank"));
        assert!(navigation_allowed("data:image/png;base64,AAAA"));
        assert!(navigation_allowed("blob:https://tauri.localhost/1234"));
    }

    #[test]
    fn navigation_guard_denies_remote_and_local_file_origins() {
        assert!(!navigation_allowed("https://evil.example/phish"));
        assert!(!navigation_allowed("http://evil.example/phish"));
        assert!(!navigation_allowed("file:///etc/passwd"));
        assert!(!navigation_allowed("javascript:alert(1)"));
        assert!(!navigation_allowed("ftp://example.com/x"));
        // A spoofed host on the tauri scheme is not the app origin.
        assert!(!navigation_allowed("tauri://evil.example/index.html"));
        assert!(!navigation_allowed("https://tauri.localhost.evil.example/"));
    }
}
