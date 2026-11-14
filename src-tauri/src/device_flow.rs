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
//! key_alias}` exactly once. Privacy fix (realms): before anything is
//! stored, the NEW session asks the platform who signed in (`GET
//! /api/auth/me`); without a verified user id the login fails closed and
//! nothing changes. The user is then bound to the profile (`realm.rs`), the
//! API key is stored in the credential vault (`credentials.rs`) under the
//! realm key (`<profile-id>:<user-id>`) and the session JWT under
//! `<realm-key>.session` (one atomic write), the profile becomes active, and
//! the renderer only learns the alias, the profile id and whether this user
//! starts with a fresh, empty realm on this device. Raw credentials never
//! cross the IPC boundary (S4).
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
//! failures such as credential-storage or browser-open errors).
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
    /// A response did not match the contract, or a local step (credential
    /// vault, browser) failed.
    Protocol,
    /// The platform approved the login but could not say WHICH account it
    /// is (`/api/auth/me` failed): nothing was stored, no data was switched.
    Identity,
    /// The login was verified but this user's earlier chat history could
    /// not be moved into their account folder (e.g. the disk is full):
    /// nothing was stored, nothing was switched, the history is intact.
    Migration,
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
    /// The signed-in account has no data on this device yet: the UI says so
    /// explicitly (privacy fix: a new user starts from an empty realm).
    pub fresh_realm: bool,
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

/// Sign out of `profile_id`: delete the bound user's vault entries
/// (inference key and session JWT, plus any pre-realm profile-keyed pair, in
/// one atomic write; missing entries are a no-op), stop every running
/// stream and clear the active profile. The user binding and the realm data
/// are KEPT: the same user gets everything back on their next login, any
/// other user can only reach their own realm.
#[tauri::command]
pub fn device_logout(app: AppHandle, profile_id: String) -> Result<(), String> {
    if profile::profile_by_id(&profile_id).is_none() {
        return Err(format!("unknown profile id: {profile_id:?}"));
    }
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let accounts = logout_accounts(&dir, &profile_id);
    let refs: Vec<&str> = accounts.iter().map(String::as_str).collect();
    crate::credentials::store()
        .and_then(|store| store.delete_many(&refs))
        .map_err(|err| err.to_string())?;
    stop_realm_tasks(&app);
    let mut store = profile::load_or_seed(&dir)?;
    store.clear_active_profile();
    profile::save(&dir, &store)
}

/// Every vault account a sign-out of `profile_id` deletes: the bound user's
/// key + session and the pre-realm profile-keyed pair.
pub fn logout_accounts(root: &std::path::Path, profile_id: &str) -> Vec<String> {
    let mut accounts = vec![
        profile::legacy_key_account(profile_id),
        profile::legacy_session_account(profile_id),
    ];
    if let Some((key, session)) = crate::realm::accounts_in(root, profile_id) {
        accounts.extend([key, session]);
    }
    accounts
}

/// Abort every task that may still emit the previous realm's content (chat
/// streams, image generations and edits) and drop every in-memory state
/// keyed by a conversation id (tool scopes, pending proposals, the session
/// temp namespace): a realm switch must not leak a reply, an approval card
/// or a temp file into the next user's window.
fn stop_realm_tasks(app: &AppHandle) {
    crate::chat::abort_all_streams(&app.state::<crate::chat::ChatState>());
    crate::images::abort_all_images(&app.state::<crate::images::ImagesState>());
    app.state::<crate::tools::ToolsState>()
        .reset_for_realm_switch();
    // A previous user's rejected session must not park the next user's
    // account memory for the rest of the run.
    let memory = app.state::<crate::memory::MemoryState>();
    for profile in profile::canonical_profiles() {
        memory.clear(&profile.id);
    }
}

/// Bind the verified `identity` and store the approved credentials (the
/// privacy fix's login boundary, pure + path injected so it is tested
/// against a temp dir and an in-memory vault):
///
/// 1. [`crate::realm::bind_login_in`] picks the user's realm (claiming the
///    pre-realm data only for the first user of the profile);
/// 2. the vault gets the realm-keyed key + session in ONE atomic write;
/// 3. the pre-realm profile-keyed pair and, when another user was bound,
///    that user's pair are deleted (their realm data stays);
/// 4. `profiles.json` records the binding and the active profile LAST, so a
///    failure never leaves a profile active without its credentials.
///
/// Returns whether the user starts with a fresh, empty realm.
pub fn bind_and_store(
    root: &std::path::Path,
    vault: &dyn crate::credentials::CredentialStore,
    profile_id: &str,
    identity: &crate::realm::Identity,
    api_key: &str,
    session_token: &str,
) -> Result<bool, ErrorKind> {
    let (store, binding) =
        crate::realm::bind_login_in(root, profile_id, identity).map_err(|err| match err {
            crate::realm::BindError::Claim(_) => ErrorKind::Migration,
            crate::realm::BindError::Local(_) => ErrorKind::Protocol,
        })?;
    let key = profile::key_account(&binding.realm_key);
    let session = profile::session_account(&binding.realm_key);
    vault
        .set_many(&[(key.as_str(), api_key), (session.as_str(), session_token)])
        .map_err(credential_error)?;
    let mut stale = vec![
        profile::legacy_key_account(profile_id),
        profile::legacy_session_account(profile_id),
    ];
    if let Some(previous) = &binding.replaced {
        let previous_key = previous.realm_key(profile_id);
        stale.push(profile::key_account(&previous_key));
        stale.push(profile::session_account(&previous_key));
    }
    let stale: Vec<&str> = stale.iter().map(String::as_str).collect();
    vault.delete_many(&stale).map_err(credential_error)?;
    profile::save(root, &store).map_err(|_| ErrorKind::Protocol)?;
    Ok(binding.fresh)
}

/// [`bind_and_store`] against the running app: stops the previous realm's
/// tasks first, then binds and stores.
fn store_credentials(
    app: &AppHandle,
    profile_id: &str,
    identity: &crate::realm::Identity,
    api_key: &str,
    session_token: &str,
) -> Result<bool, ErrorKind> {
    stop_realm_tasks(app);
    let root = app.path().app_data_dir().map_err(|_| ErrorKind::Protocol)?;
    let vault = crate::credentials::store().map_err(credential_error)?;
    bind_and_store(&root, vault, profile_id, identity, api_key, session_token)
}

/// Credential-storage failures are local device failures, not server errors.
fn credential_error(_err: crate::credentials::CredError) -> ErrorKind {
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
    // never sent to the renderer. Security review R3 + QW3: only open URLs
    // on the platform origin itself — real parse (scheme https, same host,
    // exact /api/auth/device path); a compromised or malicious server must
    // not be able to point the approval browser elsewhere (phishing
    // hand-off).
    let Some(platform_for_check) = profile::platform_base_for(&profile_id) else {
        emit_error(ErrorKind::Protocol);
        return;
    };
    if !is_valid_verification_url(&start.verification_url, platform_for_check) {
        emit_error(ErrorKind::Protocol);
        return;
    }
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
                // Privacy fix: WHO signed in decides which realm opens. Asked
                // with the NEW session; no answer = no login (never a
                // fallback to the previously bound user).
                let Ok(identity) = crate::realm::fetch_identity(&platform, &session_token).await
                else {
                    emit_error(ErrorKind::Identity);
                    return;
                };
                let fresh_realm =
                    match store_credentials(&app, &profile_id, &identity, &api_key, &session_token)
                    {
                        Ok(fresh) => fresh,
                        Err(kind) => {
                            emit_error(kind);
                            return;
                        }
                    };
                let _ = window.emit(
                    "device://approved",
                    ApprovedPayload {
                        key_alias,
                        profile_id,
                        fresh_realm,
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

/// Validate the server-returned verification URL against the platform
/// origin (external review QW3, replacing a prefix match): the URL must
/// parse, use https, point at the platform's host (same port) and have the
/// exact path `/api/auth/device` (a query string is tolerated). A
/// compromised or malicious server must not be able to point the approval
/// browser elsewhere (phishing hand-off).
pub fn is_valid_verification_url(url: &str, platform_base: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    let Ok(base) = tauri::Url::parse(platform_base) else {
        return false;
    };
    url.scheme() == "https"
        && base.scheme() == "https"
        && url.host_str() == base.host_str()
        && url.port() == base.port()
        && url.path() == "/api/auth/device"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{HELMCODE_PLATFORM_BASE, NAN_PLATFORM_BASE};

    const START_BODY: &str = r#"{
        "device_code": "abc123def456ghi789jkl012mno345pqr678stuv",
        "user_code": "ABCD-2345",
        "verification_url": "https://cloud-api.nan.builders/api/auth/device",
        "expires_in": 900,
        "interval": 5
    }"#;

    // ---- verification_url origin check (QW3) ------------------------------

    #[test]
    fn verification_url_accepts_platform_origin() {
        assert!(is_valid_verification_url(
            "https://cloud-api.nan.builders/api/auth/device",
            NAN_PLATFORM_BASE,
        ));
        // A query string does not change the page path.
        assert!(is_valid_verification_url(
            "https://cloud-api.helmcode.com/api/auth/device?x=1",
            HELMCODE_PLATFORM_BASE,
        ));
    }

    #[test]
    fn verification_url_rejects_other_hosts_schemes_and_paths() {
        // Different host (phishing hand-off).
        assert!(!is_valid_verification_url(
            "https://evil.com/api/auth/device",
            NAN_PLATFORM_BASE,
        ));
        // Host that merely CONTAINS the platform host.
        assert!(!is_valid_verification_url(
            "https://cloud-api.nan.builders.evil.com/api/auth/device",
            NAN_PLATFORM_BASE,
        ));
        // Same host, downgraded scheme.
        assert!(!is_valid_verification_url(
            "http://cloud-api.nan.builders/api/auth/device",
            NAN_PLATFORM_BASE,
        ));
        // Same host, wrong path.
        assert!(!is_valid_verification_url(
            "https://cloud-api.nan.builders/other/path",
            NAN_PLATFORM_BASE,
        ));
        assert!(!is_valid_verification_url(
            "https://cloud-api.nan.builders/api/auth/device/extra",
            NAN_PLATFORM_BASE,
        ));
        // Not a URL at all.
        assert!(!is_valid_verification_url("not a url", NAN_PLATFORM_BASE));
    }

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

    #[test]
    fn identity_failure_and_fresh_realm_serialize_for_the_renderer() {
        let payload = serde_json::to_string(&ErrorPayload {
            kind: ErrorKind::Identity,
        })
        .expect("serialize");
        assert_eq!(payload, r#"{"kind":"identity"}"#);
        let approved = serde_json::to_string(&ApprovedPayload {
            key_alias: "desktop".into(),
            profile_id: "nan".into(),
            fresh_realm: true,
        })
        .expect("serialize");
        assert_eq!(
            approved,
            r#"{"key_alias":"desktop","profile_id":"nan","fresh_realm":true}"#
        );
    }

    // ------------------------------------------------------------------
    // Privacy fix (realms): integration at the credentials / chat boundary.
    //
    // Two accounts of the SAME tenant on one device. Every user-visible
    // surface the renderer can reach is checked after each login:
    //   * sidebar conversations + transcripts      (chat.db, conversation_list/messages_list)
    //   * memory tombstones                        (chat.db, memory_sync)
    //   * local skills                             (skills/, skills_list)
    //   * org skills offline cache                 (skills-cache/<profile>, skills_team_cache_load)
    //   * folder grants + run_command switch       (tools.json, tools_grant_list/settings)
    //   * memory settings                          (memory.json, memory_settings_get)
    //   * inference key + session JWT              (vault accounts, every platform/inference call)
    // ------------------------------------------------------------------
    mod realms {
        use super::super::*;
        use crate::chat_store;
        use crate::credentials::{CredentialStore, FileMasterKey, StampSource, Vault};
        use crate::realm::{self, Identity};
        use crate::skills;
        use crate::skills_team;
        use crate::tools::grants;
        use std::path::{Path, PathBuf};
        use tempfile::TempDir;

        struct Stamp;
        impl StampSource for Stamp {
            fn current(&self) -> String {
                "test-stamp".into()
            }
        }

        fn vault(root: &Path) -> Vault {
            Vault::new(
                root.join(crate::credentials::VAULT_FILE),
                Box::new(FileMasterKey::new(
                    root.join(crate::credentials::DEV_MASTER_KEY_FILE),
                )),
            )
            .with_stamp(Box::new(Stamp))
        }

        fn who(id: &str) -> Identity {
            Identity {
                id: id.into(),
                email: Some(format!("{id}@example.com")),
            }
        }

        fn login(root: &Path, vault: &Vault, id: &str) -> bool {
            bind_and_store(
                root,
                vault,
                "nan",
                &who(id),
                &format!("sk-key-of-{id}"),
                &format!("jwt-of-{id}"),
            )
            .expect("login")
        }

        fn logout(root: &Path, vault: &Vault) {
            let accounts = logout_accounts(root, "nan");
            let refs: Vec<&str> = accounts.iter().map(String::as_str).collect();
            vault.delete_many(&refs).expect("delete");
            let mut store = profile::load_or_seed(root).unwrap();
            store.clear_active_profile();
            profile::save(root, &store).unwrap();
        }

        /// The active realm, as every realm-scoped command resolves it.
        fn active(root: &Path) -> PathBuf {
            realm::dir_for_in(root, "nan").expect("signed in")
        }

        /// The session token the platform calls would use right now.
        fn active_session(root: &Path, vault: &Vault) -> Option<String> {
            let (_, session) = realm::accounts_in(root, "nan")?;
            crate::chat::session_token_from(vault, &session)
        }

        fn titles(dir: &Path) -> Vec<String> {
            let conn = chat_store::open_db(dir).unwrap();
            chat_store::list_conversations(&conn, "nan")
                .unwrap()
                .into_iter()
                .map(|c| c.title)
                .collect()
        }

        /// Everything the renderer could show for the active realm, empty
        /// or not.
        fn visible(dir: &Path) -> (Vec<String>, usize, usize, usize, usize) {
            let conn = chat_store::open_db(dir).unwrap();
            let tombstones = chat_store::list_tombstones(&conn, "nan").unwrap().len();
            let skills = skills::list(&skills::skills_dir_in(dir)).unwrap().len();
            let team = skills_team::view(&skills_team::cache_dir_in(dir, "nan").unwrap())
                .skills
                .len();
            let grants = grants::load_or_seed(dir).unwrap().grants.len();
            (titles(dir), tombstones, skills, team, grants)
        }

        /// A v0.2.6 app data folder: profiles.json v2 (nan active), a shared
        /// chat.db, local skills, the nan team cache, a folder grant and the
        /// profile-keyed vault entries of whoever was signed in.
        fn v026_fixture(root: &Path, vault: &Vault) {
            std::fs::write(
                root.join(profile::STORE_FILE),
                format!(
                    r#"{{"version":2,"profiles":{},"active_profile":"nan"}}"#,
                    serde_json::to_string(&profile::canonical_profiles()).unwrap()
                ),
            )
            .unwrap();
            let conn = chat_store::open_db(root).unwrap();
            let id = chat_store::insert_conversation(&conn, "nan", "A private chat").unwrap();
            chat_store::insert_message(&conn, id, "user", "A-SECRET", None).unwrap();
            conn.execute(
                "INSERT INTO memory_tombstones (remote_id, profile_id) VALUES ('gone', 'nan')",
                [],
            )
            .unwrap();
            drop(conn);
            skills::create_at(
                &root.join(skills::SKILLS_DIR),
                &skills::SkillInput {
                    title: "A skill".into(),
                    description: "d".into(),
                    instructions: "i".into(),
                    references: vec![],
                },
                0,
            )
            .unwrap();
            let meta: skills_team::TeamMeta =
                serde_json::from_value(serde_json::json!({"id": "sk_01A", "status": "approved"}))
                    .unwrap();
            skills_team::store_list(
                &root.join(skills_team::CACHE_DIR).join("nan"),
                Some("\"e1\"".into()),
                vec![meta],
            )
            .unwrap();
            let mut tools = grants::default_store();
            tools.grants.push(grants::Grant {
                id: "g-a".into(),
                canonical_path: PathBuf::from("/Users/a/private"),
                granted_at: "t".into(),
                profile_id: "nan".into(),
                scope: grants::GrantScope::Folder,
                mode: grants::ApprovalMode::Ask,
            });
            grants::save(root, &tools).unwrap();
            vault
                .set_many(&[("nan", "sk-legacy"), ("nan.session", "jwt-legacy")])
                .unwrap();
        }

        #[test]
        fn a_failed_history_move_refuses_the_login_and_the_retry_recovers_it() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            let vault = vault(root);
            v026_fixture(root, &vault);
            // The disk "fills up": the realm copy cannot be written.
            let a_dir =
                realm::realm_dir(root, &realm::realm_hash(&realm::realm_key("nan", "user-a")));
            let blocker = a_dir.join(format!("{}.claim.tmp", chat_store::DB_FILE));
            std::fs::create_dir_all(&blocker).unwrap();

            assert_eq!(
                bind_and_store(root, &vault, "nan", &who("user-a"), "sk-a", "jwt-a"),
                Err(ErrorKind::Migration)
            );
            // Fail-closed: nothing stored, nothing bound, no fresh realm.
            assert_eq!(vault.get("nan:user-a").unwrap(), None);
            assert_eq!(realm::accounts_in(root, "nan"), None);
            let store = profile::load_or_seed(root).unwrap();
            assert_eq!(store.binding("nan"), None);
            // The history is intact where it was.
            assert_eq!(titles(root), vec!["A private chat".to_string()]);

            std::fs::remove_dir(&blocker).unwrap();
            assert!(!login(root, &vault, "user-a"), "history claimed: not fresh");
            assert_eq!(
                visible(&active(root)),
                (vec!["A private chat".to_string()], 1, 1, 1, 1)
            );
        }

        #[test]
        fn migration_failure_serializes_for_the_renderer() {
            let payload = serde_json::to_string(&ErrorPayload {
                kind: ErrorKind::Migration,
            })
            .expect("serialize");
            assert_eq!(payload, r#"{"kind":"migration"}"#);
        }

        #[test]
        fn upgrade_then_a_second_user_of_the_same_tenant_sees_nothing_of_the_first() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            let vault = vault(root);
            v026_fixture(root, &vault);

            // ---- first login after the update: A is bound, keeps the data --
            assert!(
                !login(root, &vault, "user-a"),
                "legacy data claimed: not fresh"
            );
            let a_dir = active(root);
            assert_eq!(
                visible(&a_dir),
                (vec!["A private chat".to_string()], 1, 1, 1, 1)
            );
            // The pre-realm stores are gone (moved, not duplicated).
            assert!(!root.join(chat_store::DB_FILE).exists());
            assert!(!root.join(skills::SKILLS_DIR).exists());
            assert!(!root.join(grants::STORE_FILE).exists());
            // Vault: realm-keyed slots only; the profile-keyed pair is gone.
            assert_eq!(vault.get("nan").unwrap(), None);
            assert_eq!(vault.get("nan.session").unwrap(), None);
            assert_eq!(
                vault.get("nan:user-a").unwrap().as_deref(),
                Some("sk-key-of-user-a")
            );
            assert_eq!(
                active_session(root, &vault).as_deref(),
                Some("jwt-of-user-a")
            );

            // A keeps working in their realm.
            let conn = chat_store::open_db(&a_dir).unwrap();
            chat_store::insert_conversation(&conn, "nan", "A second chat").unwrap();
            drop(conn);

            // ---- A signs out, B (same tenant) signs in --------------------
            logout(root, &vault);
            assert!(
                realm::dir_for_in(root, "nan").is_err(),
                "signed out: no realm"
            );
            assert_eq!(active_session(root, &vault), None, "A's session is revoked");
            assert!(login(root, &vault, "user-b"), "a new user starts fresh");
            let b_dir = active(root);
            assert_ne!(b_dir, a_dir);
            assert_ne!(
                b_dir.join(chat_store::DB_FILE),
                a_dir.join(chat_store::DB_FILE),
                "a different database file on disk"
            );
            // ZERO of A on every surface.
            assert_eq!(visible(&b_dir), (vec![], 0, 0, 0, 0));
            assert!(crate::memory::load_settings(&b_dir).is_ok());
            assert_eq!(
                active_session(root, &vault).as_deref(),
                Some("jwt-of-user-b")
            );
            // A's realm is intact on disk, just unreachable.
            assert_eq!(titles(&a_dir), vec!["A second chat", "A private chat"]);

            // ---- B works, then A signs back in ----------------------------
            let conn = chat_store::open_db(&b_dir).unwrap();
            chat_store::insert_conversation(&conn, "nan", "B only").unwrap();
            drop(conn);
            logout(root, &vault);
            assert!(!login(root, &vault, "user-a"), "A's realm comes back");
            assert_eq!(active(root), a_dir);
            assert_eq!(
                titles(&active(root)),
                vec!["A second chat", "A private chat"]
            );
            assert_eq!(
                active_session(root, &vault).as_deref(),
                Some("jwt-of-user-a")
            );
            // ...and nothing of B leaks back.
            assert!(!titles(&active(root)).contains(&"B only".to_string()));
        }

        #[test]
        fn a_different_user_while_another_realm_is_active_switches_and_drops_its_credentials() {
            // A's session was revoked by the server (A never signed out) and
            // B signs in: the active realm becomes B's, A's stale secrets are
            // dropped, A's data stays on disk and out of reach.
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            let vault = vault(root);
            login(root, &vault, "user-a");
            let a_dir = active(root);
            let conn = chat_store::open_db(&a_dir).unwrap();
            chat_store::insert_conversation(&conn, "nan", "A chat").unwrap();
            drop(conn);

            assert!(login(root, &vault, "user-b"));
            let b_dir = active(root);
            assert_ne!(b_dir, a_dir);
            assert!(titles(&b_dir).is_empty());
            assert_eq!(vault.get("nan:user-a").unwrap(), None);
            assert_eq!(vault.get("nan:user-a.session").unwrap(), None);
            assert_eq!(
                active_session(root, &vault).as_deref(),
                Some("jwt-of-user-b")
            );
            assert_eq!(titles(&a_dir), vec!["A chat"]);
            let store = profile::load_or_seed(root).unwrap();
            assert_eq!(store.binding("nan").map(|u| u.id.as_str()), Some("user-b"));
        }

        #[test]
        fn the_session_is_read_for_the_active_realm_only() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            let vault = vault(root);
            // A leftover session of another user in the vault is never used.
            vault.set("nan:user-a.session", "jwt-of-user-a").unwrap();
            login(root, &vault, "user-b");
            assert_eq!(
                active_session(root, &vault).as_deref(),
                Some("jwt-of-user-b")
            );
            // The other tenant has no bound user: nothing is readable.
            assert_eq!(realm::accounts_in(root, "helmcode"), None);
        }

        #[test]
        fn an_unverified_identity_stores_nothing_and_switches_nothing() {
            let tmp = TempDir::new().unwrap();
            let root = tmp.path();
            let vault = vault(root);
            login(root, &vault, "user-a");
            let bad = Identity {
                id: "".into(),
                email: None,
            };
            assert_eq!(
                bind_and_store(root, &vault, "nan", &bad, "sk-x", "jwt-x"),
                Err(ErrorKind::Protocol)
            );
            assert_eq!(
                active_session(root, &vault).as_deref(),
                Some("jwt-of-user-a")
            );
            let store = profile::load_or_seed(root).unwrap();
            assert_eq!(store.binding("nan").map(|u| u.id.as_str()), Some("user-a"));
        }
    }
}
