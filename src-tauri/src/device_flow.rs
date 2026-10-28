//! Device-flow login (T13, S4/S11): an RFC 8628-style client against the
//! tenants' real `/api/auth/device/*` endpoints (cloud-api PR #411,
//! enterprise-api PR #105 — same wire contract on both).
//!
//! Flow: `device_login_start(profile_id)` POSTs `/api/auth/device/start`,
//! keeps the returned `device_code` in the task's memory only (never
//! persisted, never sent to the renderer), opens the system browser on the
//! returned `verification_url`, then polls `/api/auth/device/poll` at the
//! advertised interval until the request is approved, denied, expired or
//! fails. On approval the response carries `{session_token, api_key,
//! key_alias}` exactly once: the API key is stored in the OS keychain under
//! the profile id, the session JWT under `<profile-id>.session`, the profile
//! becomes active, and the renderer only learns the alias + profile id.
//! Raw credentials never cross the IPC boundary (S4).
//!
//! The poll status contract mirrors the backends:
//!
//! - 200 `{"status":"pending"}`  → keep polling
//! - 200 `{"status":"denied"}`   → the member said no
//! - 200 `{"status":"expired"}`  → TTL or already consumed
//! - 200 approved + credentials  → success (exactly once)
//! - 429                          → slow_down / rate limited: back off
//! - other 4xx / 5xx              → server-side failure
//!
//! Error classification for `device://error`: `network` / `timeout` /
//! `rate_limited` / `server` / `protocol` (malformed payloads and local
//! failures such as keychain or browser-open errors).
//!
//! Zero telemetry (S8): the only host contacted is the profile's own
//! platform base (a compiled-in constant; see [`platform_base`]).

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use tauri_plugin_opener::OpenerExt;

use crate::profile;

/// Per-request HTTP timeout for start and poll calls.
pub const REQUEST_TIMEOUT_SECS: u64 = 10;

/// Advertised poll interval assumed when the start response omits it (the
/// backends advertise 5 s).
pub const DEFAULT_POLL_INTERVAL_SECS: u64 = 5;

/// Assumed request lifetime when the start response omits `expires_in`
/// (the backends advertise 15 minutes).
pub const DEFAULT_EXPIRES_IN_SECS: u64 = 900;

// ---------------------------------------------------------------------------
// Pure, unit-tested core: response parsing + the poll state machine.
// ---------------------------------------------------------------------------

/// Why a login attempt failed. Serialized into `device://error` payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// Transport failure (DNS, connect refused, connection reset, …).
    Network,
    /// The request hit its timeout.
    Timeout,
    /// Rate limited beyond recovery (classified, but poll 429s back off
    /// instead of failing — see [`classify_poll`]).
    RateLimited,
    /// The server rejected the flow (4xx/5xx, key minting failed, …).
    Server,
    /// A response did not match the contract, or a local step (keychain,
    /// browser) failed.
    Protocol,
}

impl ErrorKind {
    /// Classify a non-2xx start response: an explicit rate limit is its own
    /// kind ("too many attempts"), anything else is a server failure.
    fn from_http_status(status: u16) -> ErrorKind {
        if status == 429 {
            ErrorKind::RateLimited
        } else {
            ErrorKind::Server
        }
    }
}

/// Payload of `device://started` — the human-readable code only. The
/// `device_code` (the poll credential) is deliberately absent: it never
/// leaves the Rust task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StartedPayload {
    pub user_code: String,
}

/// Payload of `device://status`, `device://denied` and `device://expired`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StatusPayload {
    pub status: &'static str,
}

/// Payload of `device://approved`. No credential material: the renderer only
/// learns the alias and which profile became active (S4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ApprovedPayload {
    pub key_alias: String,
    pub profile_id: String,
}

/// Payload of `device://error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ErrorPayload {
    pub kind: ErrorKind,
}

/// The parsed `POST /api/auth/device/start` response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_url: String,
    pub expires_in_secs: u64,
    pub interval_secs: u64,
}

/// One step of the poll state machine: what a poll response means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollDecision {
    /// Still pending — keep polling at the current interval.
    Continue,
    /// Poll again but wait at least this many seconds first (429 slow_down,
    /// honoring `Retry-After` when present).
    Backoff(u64),
    /// Approved — the credentials arrived exactly once and must be stored.
    Approved {
        session_token: String,
        api_key: String,
        key_alias: String,
    },
    /// The member denied the request in the browser.
    Denied,
    /// The request expired or was already consumed.
    Expired,
    /// The flow failed; the renderer gets `device://error` with the kind.
    Error(ErrorKind),
}

/// Parse a start response. Any status other than 2xx, a malformed body, or a
/// payload missing `device_code` / `user_code` / `verification_url` is an
/// error — a partial start is never accepted.
pub fn parse_start(status: u16, body: &str) -> Result<StartResponse, ErrorKind> {
    if !(200..300).contains(&status) {
        return Err(ErrorKind::from_http_status(status));
    }
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| ErrorKind::Protocol)?;
    Ok(StartResponse {
        device_code: non_empty_str(&value, "device_code").ok_or(ErrorKind::Protocol)?,
        user_code: non_empty_str(&value, "user_code").ok_or(ErrorKind::Protocol)?,
        verification_url: non_empty_str(&value, "verification_url").ok_or(ErrorKind::Protocol)?,
        expires_in_secs: u64_field(&value, "expires_in").unwrap_or(DEFAULT_EXPIRES_IN_SECS),
        interval_secs: u64_field(&value, "interval")
            .unwrap_or(DEFAULT_POLL_INTERVAL_SECS)
            .max(1),
    })
}

/// The poll state machine: map `(http_status, body, Retry-After)` to a
/// [`PollDecision`]. An approved payload missing any of the three credential
/// fields is [`PollDecision::Error`] ([`ErrorKind::Protocol`]) — never
/// silently accepted.
pub fn classify_poll(status: u16, body: &str, retry_after_secs: Option<u64>) -> PollDecision {
    match status {
        200 => classify_poll_body(body),
        // slow_down / rate limited: honor Retry-After when the server sends
        // one, otherwise fall back to the advertised interval.
        429 => PollDecision::Backoff(match retry_after_secs {
            Some(secs) if secs > 0 => secs,
            _ => DEFAULT_POLL_INTERVAL_SECS,
        }),
        // The server rejected the flow (invalid code, internal error, …).
        400..=599 => PollDecision::Error(ErrorKind::Server),
        _ => PollDecision::Error(ErrorKind::Protocol),
    }
}

/// Classify a transport-level failure from its `reqwest::Error::is_timeout`
/// predicate (kept as a pure function so it is unit-testable).
pub fn classify_transport(is_timeout: bool) -> ErrorKind {
    if is_timeout {
        ErrorKind::Timeout
    } else {
        ErrorKind::Network
    }
}

fn non_empty_str(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn u64_field(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|v| v.as_u64())
}

/// Classify the JSON body of a 200 poll response.
fn classify_poll_body(body: &str) -> PollDecision {
    let value: serde_json::Value = match serde_json::from_str(body) {
        Ok(value) => value,
        Err(_) => return PollDecision::Error(ErrorKind::Protocol),
    };
    match value.get("status").and_then(|s| s.as_str()) {
        Some("pending") => PollDecision::Continue,
        Some("denied") => PollDecision::Denied,
        Some("expired") => PollDecision::Expired,
        Some("approved") => {
            match (
                non_empty_str(&value, "session_token"),
                non_empty_str(&value, "api_key"),
                non_empty_str(&value, "key_alias"),
            ) {
                (Some(session_token), Some(api_key), Some(key_alias)) => PollDecision::Approved {
                    session_token,
                    api_key,
                    key_alias,
                },
                // An approved payload without every credential is refused.
                _ => PollDecision::Error(ErrorKind::Protocol),
            }
        }
        // Missing, non-string or unknown status word.
        _ => PollDecision::Error(ErrorKind::Protocol),
    }
}

// ---------------------------------------------------------------------------
// Platform base resolution
// ---------------------------------------------------------------------------

/// Platform base for device-flow requests. Normally the profile's
/// compiled-in constant (S2); in debug builds the `NAN_DESKTOP_MOCK_PLATFORM`
/// environment variable may point the whole flow at a local mock
/// (`test/mock-device.mjs`) so the flow can be exercised end to end before
/// the real backends ship. Release builds ignore the variable entirely
/// (S12: no endpoint outside the two tenants is reachable; debug builds are
/// developer machines only).
pub fn platform_base(profile_id: &str) -> Option<String> {
    if cfg!(debug_assertions)
        && let Ok(mock) = std::env::var("NAN_DESKTOP_MOCK_PLATFORM")
    {
        let mock = mock.trim().trim_end_matches('/');
        if !mock.is_empty() {
            return Some(mock.to_string());
        }
    }
    profile::platform_base_for(profile_id).map(str::to_string)
}

// ---------------------------------------------------------------------------
// Managed task + commands (same cancel-safe pattern as the SSE demo)
// ---------------------------------------------------------------------------

/// Handle of the running device-login task. Starting a new login aborts the
/// previous loop, so `device_login_start` stays cancel-safe.
#[derive(Default)]
pub struct DeviceLoginState(Mutex<Option<JoinHandle<()>>>);

#[tauri::command]
pub fn device_login_start(
    app: AppHandle,
    window: Window,
    profile_id: String,
    state: State<'_, DeviceLoginState>,
) -> Result<(), String> {
    // Only the two locked profile ids are ever accepted (S2/S12).
    if profile::profile_by_id(&profile_id).is_none() {
        return Err(format!("unknown profile id: {profile_id:?}"));
    }
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "device login state mutex poisoned".to_string())?;
    if let Some(previous) = guard.take() {
        previous.abort();
    }
    *guard = Some(tauri::async_runtime::spawn(run_device_login(
        app, window, profile_id,
    )));
    Ok(())
}

/// Cancel the running login loop, if any (the UI "Cancel" button). The
/// renderer resets its own state; no event is emitted.
#[tauri::command]
pub fn device_login_cancel(state: State<'_, DeviceLoginState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "device login state mutex poisoned".to_string())?;
    if let Some(handle) = guard.take() {
        handle.abort();
    }
    Ok(())
}

/// Sign out of `profile_id`: delete both keychain entries (inference key and
/// session JWT; deleting a missing entry is a no-op) and clear the active
/// profile.
#[tauri::command]
pub fn device_logout(app: AppHandle, profile_id: String) -> Result<(), String> {
    if profile::profile_by_id(&profile_id).is_none() {
        return Err(format!("unknown profile id: {profile_id:?}"));
    }
    for account in [
        profile::key_account(&profile_id),
        profile::session_account(&profile_id),
    ] {
        match keyring::Entry::new(profile::KEYRING_SERVICE, &account)
            .and_then(|entry| entry.delete_credential())
        {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(err) => return Err(err.to_string()),
        }
    }
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let mut store = profile::load_or_seed(&dir)?;
    store.clear_active_profile();
    profile::save(&dir, &store)
}

/// Store the approved credentials: both secrets in the OS keychain (S4),
/// then the profile as active. The keychain writes come first so a failure
/// never leaves a profile marked active without its credentials; a failed
/// session write rolls the key entry back.
fn store_credentials(
    app: &AppHandle,
    profile_id: &str,
    api_key: &str,
    session_token: &str,
) -> Result<(), ErrorKind> {
    keyring::Entry::new(profile::KEYRING_SERVICE, &profile::key_account(profile_id))
        .and_then(|entry| entry.set_password(api_key))
        .map_err(|_| ErrorKind::Protocol)?;
    if let Err(err) = keyring::Entry::new(
        profile::KEYRING_SERVICE,
        &profile::session_account(profile_id),
    )
    .and_then(|entry| entry.set_password(session_token))
    {
        // Compensate: do not leave a half-stored credential pair behind.
        let _ = keyring::Entry::new(profile::KEYRING_SERVICE, &profile::key_account(profile_id))
            .and_then(|entry| entry.delete_credential());
        return Err(emit_keychain_error(err));
    }

    let dir = app.path().app_data_dir().map_err(|_| ErrorKind::Protocol)?;
    let mut store = profile::load_or_seed(&dir).map_err(|_| ErrorKind::Protocol)?;
    store
        .set_active_profile(profile_id)
        .map_err(|_| ErrorKind::Protocol)?;
    profile::save(&dir, &store).map_err(|_| ErrorKind::Protocol)?;
    Ok(())
}

/// Keychain failures are local device failures, not server errors.
fn emit_keychain_error(_err: keyring::Error) -> ErrorKind {
    ErrorKind::Protocol
}

/// The managed login task: start → open browser → poll → store → emit.
async fn run_device_login(app: AppHandle, window: Window, profile_id: String) {
    let emit_error = |kind: ErrorKind| {
        let _ = window.emit("device://error", ErrorPayload { kind });
    };

    let Some(platform) = platform_base(&profile_id) else {
        emit_error(ErrorKind::Protocol);
        return;
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            emit_error(ErrorKind::Protocol);
            return;
        }
    };

    // ---- POST /api/auth/device/start ------------------------------------
    let start_url = format!("{platform}/api/auth/device/start");
    let response = match client.post(&start_url).send().await {
        Ok(response) => response,
        Err(err) => {
            emit_error(classify_transport(err.is_timeout()));
            return;
        }
    };
    let status = response.status().as_u16();
    let body = match response.text().await {
        Ok(body) => body,
        Err(err) => {
            emit_error(classify_transport(err.is_timeout()));
            return;
        }
    };
    let start = match parse_start(status, &body) {
        Ok(start) => start,
        Err(kind) => {
            emit_error(kind);
            return;
        }
    };

    // Open the system browser from the Rust core; the verification URL is
    // never sent to the renderer.
    if let Err(_err) = app
        .opener()
        .open_url(start.verification_url.clone(), None::<String>)
    {
        emit_error(ErrorKind::Protocol);
        return;
    }

    let _ = window.emit(
        "device://started",
        StartedPayload {
            user_code: start.user_code,
        },
    );
    let _ = window.emit("device://status", StatusPayload { status: "pending" });

    // ---- poll loop -------------------------------------------------------
    let device_code = start.device_code;
    let poll_url = format!("{platform}/api/auth/device/poll");
    let mut interval_secs = start.interval_secs.max(1);
    loop {
        tokio::time::sleep(Duration::from_secs(interval_secs)).await;

        let response = match client
            .post(&poll_url)
            .json(&serde_json::json!({ "device_code": device_code }))
            .send()
            .await
        {
            Ok(response) => response,
            Err(err) => {
                emit_error(classify_transport(err.is_timeout()));
                return;
            }
        };
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse::<u64>().ok());
        let body = match response.text().await {
            Ok(body) => body,
            Err(err) => {
                emit_error(classify_transport(err.is_timeout()));
                return;
            }
        };

        match classify_poll(status, &body, retry_after) {
            PollDecision::Continue => {
                let _ = window.emit("device://status", StatusPayload { status: "pending" });
            }
            PollDecision::Backoff(secs) => {
                interval_secs = interval_secs.max(secs);
                let _ = window.emit("device://status", StatusPayload { status: "pending" });
            }
            PollDecision::Approved {
                session_token,
                api_key,
                key_alias,
            } => {
                if let Err(kind) = store_credentials(&app, &profile_id, &api_key, &session_token) {
                    emit_error(kind);
                    return;
                }
                let _ = window.emit(
                    "device://approved",
                    ApprovedPayload {
                        key_alias,
                        profile_id,
                    },
                );
                return;
            }
            PollDecision::Denied => {
                let _ = window.emit("device://denied", StatusPayload { status: "denied" });
                return;
            }
            PollDecision::Expired => {
                let _ = window.emit("device://expired", StatusPayload { status: "expired" });
                return;
            }
            PollDecision::Error(kind) => {
                emit_error(kind);
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START_BODY: &str = r#"{
        "device_code": "abc123def456ghi789jkl012mno345pqr678stuv",
        "user_code": "ABCD-2345",
        "verification_url": "https://cloud-api.nan.builders/api/auth/device",
        "expires_in": 900,
        "interval": 5
    }"#;

    // ---- parse_start ------------------------------------------------------

    #[test]
    fn parses_a_full_start_response() {
        let start = parse_start(200, START_BODY).expect("parse");
        assert_eq!(
            start.device_code,
            "abc123def456ghi789jkl012mno345pqr678stuv"
        );
        assert_eq!(start.user_code, "ABCD-2345");
        assert_eq!(
            start.verification_url,
            "https://cloud-api.nan.builders/api/auth/device"
        );
        assert_eq!(start.expires_in_secs, 900);
        assert_eq!(start.interval_secs, 5);
    }

    #[test]
    fn start_response_defaults_interval_and_expiry() {
        let body = r#"{"device_code":"d","user_code":"ABCD-2345","verification_url":"https://host/api/auth/device"}"#;
        let start = parse_start(200, body).expect("parse");
        assert_eq!(start.interval_secs, DEFAULT_POLL_INTERVAL_SECS);
        assert_eq!(start.expires_in_secs, DEFAULT_EXPIRES_IN_SECS);
    }

    #[test]
    fn start_response_missing_device_code_is_protocol_error() {
        let body = r#"{"user_code":"ABCD-2345","verification_url":"https://host/api/auth/device"}"#;
        assert_eq!(parse_start(200, body), Err(ErrorKind::Protocol));
    }

    #[test]
    fn start_response_missing_user_code_is_protocol_error() {
        let body = r#"{"device_code":"d","verification_url":"https://host/api/auth/device"}"#;
        assert_eq!(parse_start(200, body), Err(ErrorKind::Protocol));
    }

    #[test]
    fn start_response_empty_field_is_protocol_error() {
        let body = r#"{"device_code":"","user_code":"ABCD-2345","verification_url":"https://host/api/auth/device"}"#;
        assert_eq!(parse_start(200, body), Err(ErrorKind::Protocol));
    }

    #[test]
    fn start_response_malformed_body_is_protocol_error() {
        assert_eq!(
            parse_start(200, "<html>nope</html>"),
            Err(ErrorKind::Protocol)
        );
    }

    #[test]
    fn start_http_error_is_classified() {
        assert_eq!(
            parse_start(503, r#"{"error":"device sign-in not configured"}"#),
            Err(ErrorKind::Server)
        );
        // An explicit rate limit on start is its own kind.
        assert_eq!(
            parse_start(429, r#"{"error":"too many requests"}"#),
            Err(ErrorKind::RateLimited)
        );
    }

    // ---- classify_poll: 200 bodies ---------------------------------------

    #[test]
    fn pending_poll_continues() {
        assert_eq!(
            classify_poll(200, r#"{"status":"pending"}"#, None),
            PollDecision::Continue
        );
    }

    #[test]
    fn denied_and_expired_polls_terminate() {
        assert_eq!(
            classify_poll(200, r#"{"status":"denied"}"#, None),
            PollDecision::Denied
        );
        assert_eq!(
            classify_poll(200, r#"{"status":"expired"}"#, None),
            PollDecision::Expired
        );
    }

    #[test]
    fn approved_poll_parses_all_three_credentials() {
        // The exact approved payload of both backends (cloud-api adds
        // "region"; extra fields are ignored).
        let body = r#"{"status":"approved","session_token":"fake-jwt","api_key":"sk-test-1234567890abcdef","key_alias":"member.dt-0a1b2c3d","region":"EU"}"#;
        assert_eq!(
            classify_poll(200, body, None),
            PollDecision::Approved {
                session_token: "fake-jwt".to_string(),
                api_key: "sk-test-1234567890abcdef".to_string(),
                key_alias: "member.dt-0a1b2c3d".to_string(),
            }
        );
    }

    #[test]
    fn approved_payload_missing_a_field_is_error_never_accepted() {
        // Each of the three credential fields is required: a payload missing
        // it, or carrying it empty, must be an Error, never an Approved.
        for missing in ["session_token", "api_key", "key_alias"] {
            let mut fields = vec![
                r#""status":"approved""#.to_string(),
                r#""session_token":"fake-jwt""#.to_string(),
                r#""api_key":"sk-test-1234567890abcdef""#.to_string(),
                r#""key_alias":"member.dt-0a1b2c3d""#.to_string(),
            ];
            fields.retain(|field| !field.starts_with(&format!(r#""{missing}":"#)));
            let body = format!("{{{}}}", fields.join(","));
            assert_eq!(
                classify_poll(200, &body, None),
                PollDecision::Error(ErrorKind::Protocol),
                "approved payload missing {missing} must be refused"
            );
        }
        // Empty-string fields count as missing.
        assert_eq!(
            classify_poll(
                200,
                r#"{"status":"approved","session_token":"","api_key":"sk-test","key_alias":"a"}"#,
                None
            ),
            PollDecision::Error(ErrorKind::Protocol)
        );
    }

    #[test]
    fn malformed_poll_body_and_unknown_status_are_protocol_errors() {
        assert_eq!(
            classify_poll(200, "<html>gateway noise</html>", None),
            PollDecision::Error(ErrorKind::Protocol)
        );
        assert_eq!(
            classify_poll(200, "{}", None),
            PollDecision::Error(ErrorKind::Protocol)
        );
        assert_eq!(
            classify_poll(200, r#"{"status":"teleported"}"#, None),
            PollDecision::Error(ErrorKind::Protocol)
        );
    }

    // ---- classify_poll: non-200 ------------------------------------------

    #[test]
    fn http_429_without_retry_after_backs_off_default() {
        assert_eq!(
            classify_poll(
                429,
                r#"{"error":"slow_down — poll at the advertised interval"}"#,
                None
            ),
            PollDecision::Backoff(DEFAULT_POLL_INTERVAL_SECS)
        );
    }

    #[test]
    fn http_429_honors_retry_after() {
        assert_eq!(
            classify_poll(429, r#"{"error":"too many requests"}"#, Some(7)),
            PollDecision::Backoff(7)
        );
    }

    #[test]
    fn http_4xx_is_server_error() {
        assert_eq!(
            classify_poll(400, r#"{"error":"invalid device_code"}"#, None),
            PollDecision::Error(ErrorKind::Server)
        );
        assert_eq!(
            classify_poll(403, r#"{"error":"forbidden"}"#, None),
            PollDecision::Error(ErrorKind::Server)
        );
    }

    #[test]
    fn http_5xx_is_server_error() {
        assert_eq!(
            classify_poll(500, r#"{"error":"internal error"}"#, None),
            PollDecision::Error(ErrorKind::Server)
        );
        assert_eq!(
            classify_poll(503, "service unavailable", None),
            PollDecision::Error(ErrorKind::Server)
        );
    }

    // ---- transport ---------------------------------------------------------

    #[test]
    fn transport_timeout_and_network_kinds() {
        assert_eq!(classify_transport(true), ErrorKind::Timeout);
        assert_eq!(classify_transport(false), ErrorKind::Network);
    }

    #[test]
    fn error_kinds_serialize_snake_case() {
        // The renderer switches on these exact strings.
        let payload = serde_json::to_string(&ErrorPayload {
            kind: ErrorKind::RateLimited,
        })
        .expect("serialize");
        assert_eq!(payload, r#"{"kind":"rate_limited"}"#);
        let payload = serde_json::to_string(&ErrorPayload {
            kind: ErrorKind::Network,
        })
        .expect("serialize");
        assert_eq!(payload, r#"{"kind":"network"}"#);
    }
}
