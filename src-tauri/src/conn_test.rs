//! Connection test (T3): prove a profile can reach its inference API.
//!
//! `GET {base_url}/models` with `Authorization: Bearer <key>` — HTTP always
//! happens in the Rust core (S4): the key is read from the OS keychain (or
//! supplied once by the onboarding form before saving) and is never
//! rendered, logged or echoed back. The result carries only counts and a
//! short error string — never the key, never the response body.
//!
//! Classification is pure and unit-tested: `ok` (2xx with an OpenAI-style
//! model list) / `http_error` (non-2xx, or a 2xx body that is not a model
//! list) / `network_error` (request failed) / `missing_key` (no key stored).

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::profile::{self, KEYRING_SERVICE};

/// Request timeout for the connection test.
pub const TIMEOUT_SECS: u64 = 10;

/// Result of a connection test. Deliberately minimal: no key material and no
/// response body ever appear here — at most a model count, the HTTP status
/// and a short error string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub status_code: Option<u16>,
    pub model_count: Option<usize>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

/// Classified result: 2xx with a recognizable OpenAI-style model list.
fn ok_result(status: u16, model_count: usize, latency_ms: u64) -> ConnectionTestResult {
    ConnectionTestResult {
        ok: true,
        status_code: Some(status),
        model_count: Some(model_count),
        latency_ms: Some(latency_ms),
        error: None,
    }
}

/// Classified result: an HTTP-level failure. The body is never included —
/// only the status and a short reason.
fn http_error_result(
    status: Option<u16>,
    error: String,
    latency_ms: Option<u64>,
) -> ConnectionTestResult {
    ConnectionTestResult {
        ok: false,
        status_code: status,
        model_count: None,
        latency_ms,
        error: Some(error),
    }
}

/// Classify an HTTP response to `GET {base_url}/models`:
/// - 2xx + parseable model list → [`ok_result`]
/// - 2xx + unparseable body → `http_error("unexpected response format")`
/// - anything else → `http_error("HTTP <status>")`
pub fn classify_response(status: u16, body: &str, latency_ms: u64) -> ConnectionTestResult {
    if !(200..300).contains(&status) {
        return http_error_result(Some(status), format!("HTTP {status}"), Some(latency_ms));
    }
    match count_models(body) {
        Some(model_count) => ok_result(status, model_count, latency_ms),
        None => http_error_result(
            Some(status),
            "unexpected response format".to_string(),
            Some(latency_ms),
        ),
    }
}

/// Classify a transport-level failure (DNS, connect, timeout, …) into a
/// result whose error string is truncated to a short, safe message.
pub fn classify_network_error(message: &str) -> ConnectionTestResult {
    http_error_result(None, short_error(message), None)
}

/// Classified result: no API key is stored for the profile (and none was
/// supplied by the caller).
pub fn missing_key_result() -> ConnectionTestResult {
    ConnectionTestResult {
        ok: false,
        status_code: None,
        model_count: None,
        latency_ms: None,
        error: Some("no API key stored for this profile".to_string()),
    }
}

/// Count models in an OpenAI-style `/models` response: `{"data": [...]}` or
/// a bare JSON array. `None` when the body is not a recognizable list.
pub fn count_models(body: &str) -> Option<usize> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let list = match &value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(map) => map.get("data")?.as_array()?,
        _ => return None,
    };
    Some(list.len())
}

/// Join a profile base URL with the `/models` path, tolerating a trailing
/// slash in the stored base URL.
pub fn models_url(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

/// Truncate an error message to a short display string (≤ 200 chars).
fn short_error(message: &str) -> String {
    const MAX_CHARS: usize = 200;
    if message.chars().count() <= MAX_CHARS {
        return message.to_string();
    }
    let truncated: String = message.chars().take(MAX_CHARS).collect();
    format!("{truncated}…")
}

/// Run the connection test for `profile_id`.
///
/// `key`: the API key to test with. `Some` is used for the pre-save test of
/// what the onboarding form typed; `None` (or blank) reads the stored key
/// from the OS keychain instead. The key is used for the request only — it
/// never appears in the returned result or any log (S4, S8: the only host
/// contacted is the profile's own base URL).
#[tauri::command]
pub async fn connection_test(
    app: AppHandle,
    profile_id: String,
    key: Option<String>,
) -> Result<ConnectionTestResult, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let store = profile::load_or_seed(&dir)?;
    let base_url = store
        .get(&profile_id)
        .map(|p| p.base_url.clone())
        .ok_or_else(|| format!("unknown profile id: {profile_id:?}"))?;

    // Resolve the key: an explicitly supplied key (pre-save test of what the
    // onboarding form typed) or the stored keychain value. The key is used
    // for this request only and never leaves this function (S4).
    let key = match key.filter(|key| !key.trim().is_empty()) {
        Some(key) => key,
        None => match keyring::Entry::new(KEYRING_SERVICE, &profile_id)
            .and_then(|entry| entry.get_password())
        {
            Ok(stored) => stored,
            Err(keyring::Error::NoEntry) => return Ok(missing_key_result()),
            Err(err) => return Err(err.to_string()),
        },
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|err| err.to_string())?;

    let url = models_url(&base_url);
    let started = std::time::Instant::now();
    let result = match client.get(&url).bearer_auth(&key).send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            match response.text().await {
                Ok(body) => classify_response(status, &body, started.elapsed().as_millis() as u64),
                Err(err) => classify_network_error(&err.to_string()),
            }
        }
        Err(err) => classify_network_error(&err.to_string()),
    };
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY_THREE_MODELS: &str = r#"{"object":"list","data":[{"id":"glm-5.3","object":"model"},{"id":"deepseek-v4-flash","object":"model"},{"id":"qwen3.8-flash","object":"model"}]}"#;

    #[test]
    fn classifies_2xx_with_model_count_as_ok() {
        let result = classify_response(200, BODY_THREE_MODELS, 42);
        assert!(result.ok);
        assert_eq!(result.status_code, Some(200));
        assert_eq!(result.model_count, Some(3));
        assert_eq!(result.latency_ms, Some(42));
        assert_eq!(result.error, None);
    }

    #[test]
    fn classifies_http_error_without_body_content() {
        let result = classify_response(401, r#"{"error":{"message":"invalid api key"}}"#, 30);
        assert!(!result.ok);
        assert_eq!(result.status_code, Some(401));
        assert_eq!(result.model_count, None);
        assert_eq!(result.error.as_deref(), Some("HTTP 401"));
        assert_eq!(result.latency_ms, Some(30));
        // The response body must never leak into the result.
        assert!(!format!("{result:?}").contains("invalid api key"));
    }

    #[test]
    fn classifies_2xx_with_unparseable_body_as_http_error() {
        let result = classify_response(200, "<html>not json</html>", 5);
        assert!(!result.ok);
        assert_eq!(result.status_code, Some(200));
        assert_eq!(result.model_count, None);
        assert_eq!(result.error.as_deref(), Some("unexpected response format"));
    }

    #[test]
    fn network_error_is_shortened_and_never_ok() {
        let result = classify_network_error("connection refused");
        assert!(!result.ok);
        assert_eq!(result.status_code, None);
        assert_eq!(result.model_count, None);
        assert_eq!(result.error.as_deref(), Some("connection refused"));

        let long = "x".repeat(500);
        let truncated = classify_network_error(&long);
        let len = truncated.error.as_ref().map_or(0, |e| e.chars().count());
        assert!(len <= 201, "network error must be shortened, got {len}");
    }

    #[test]
    fn missing_key_result_is_classified() {
        let result = missing_key_result();
        assert!(!result.ok);
        assert_eq!(result.status_code, None);
        assert_eq!(result.model_count, None);
        assert_eq!(
            result.error.as_deref(),
            Some("no API key stored for this profile")
        );
    }

    #[test]
    fn counts_models_from_object_and_bare_array() {
        assert_eq!(count_models(BODY_THREE_MODELS), Some(3));
        assert_eq!(count_models(r#"[{"id":"a"},{"id":"b"}]"#), Some(2));
        assert_eq!(count_models(r#"{"data":[]}"#), Some(0));
        assert_eq!(count_models("garbage"), None);
        assert_eq!(count_models(r#"{"other":1}"#), None);
    }

    #[test]
    fn joins_models_url_with_and_without_trailing_slash() {
        assert_eq!(
            models_url("https://api.nan.builders/v1"),
            "https://api.nan.builders/v1/models"
        );
        assert_eq!(
            models_url("http://127.0.0.1:14322/v1/"),
            "http://127.0.0.1:14322/v1/models"
        );
    }

    #[test]
    fn timeout_is_ten_seconds() {
        assert_eq!(TIMEOUT_SECS, 10);
    }

    #[test]
    fn result_never_contains_key_material() {
        // Classification is fed a body that embeds a fake key; no result
        // field may ever carry it (bodies are only counted, never copied).
        let key = "sk-super-secret-key";
        let ok = classify_response(200, &format!(r#"{{"data":[{{"id":"{key}"}}]}}"#), 1);
        assert!(!format!("{ok:?}").contains(key));
        let err = classify_response(500, key, 1);
        assert!(!format!("{err:?}").contains(key));
        let missing = missing_key_result();
        assert!(!format!("{missing:?}").contains(key));
    }
}
