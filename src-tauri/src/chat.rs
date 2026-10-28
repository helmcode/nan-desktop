//! Chat MVP (T4, S3/S4): streaming chat against the locked tenants'
//! OpenAI-compatible inference APIs.
//!
//! Architecture: HTTP lives entirely in the Rust core (S4) — the key is read
//! from the OS keychain (account = profile id), `POST {inference_base}
//! /chat/completions` is sent with `stream: true`, the SSE byte stream is
//! decoded incrementally (multi-byte safe) and parsed with the shared
//! `sse.rs` parser, and only delta text crosses the IPC boundary as Tauri
//! events:
//!
//! - `chat://delta` `{conversation_id, delta}` — one assistant text delta
//! - `chat://done`  `{conversation_id}` — stream finished cleanly
//! - `chat://error` `{conversation_id, kind}` — classified failure
//!
//! Error kinds: `missing_key` / `unauthorized` (401 → the session must
//! re-login) / `rate_limited` (429) / `server` (other non-2xx) / `network`
//! (transport) / `protocol` (local failures: keychain, store, malformed
//! payloads).
//!
//! Persistence: the user message is stored BEFORE streaming starts; the
//! assistant message is stored after the stream finishes with the final
//! accumulated text. On error nothing assistant-side is persisted (the
//! partial text is dropped by design).
//!
//! Cancel safety: one active stream per conversation. Sending again into the
//! same conversation aborts the previous stream task (a `Mutex` over a map of
//! active streams keyed by conversation id, with a generation counter so a
//! finishing task only removes its own entry).
//!
//! Zero telemetry (S8): the only host contacted is the profile's own
//! inference base — a compiled-in constant (S2); in debug builds the
//! `NAN_DESKTOP_MOCK_INFERENCE` environment variable may point it at a local
//! mock (`test/mock-chat.mjs`), exactly like the device-flow platform mock.
//! Release builds ignore the variable entirely (S12).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::chat_store::{self, ChatMessageRow, ConversationView};
use crate::profile::{self, KEYRING_SERVICE};
use crate::sse::{flush_sse_buffer, parse_sse_buffer};

/// Connect timeout for chat/model requests. No overall request timeout: a
/// long stream must not be killed mid-generation.
pub const CONNECT_TIMEOUT_SECS: u64 = 10;

/// Default chat model (first in the filtered list; see `filter_chat_models`).
pub const DEFAULT_MODEL: &str = "deepseek-v4-flash";

// ---------------------------------------------------------------------------
// Pure, unit-tested core
// ---------------------------------------------------------------------------

/// Why a chat attempt failed. Serialized into `chat://error` payloads and
/// returned by `models_list`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// No inference key in the OS keychain for the profile.
    MissingKey,
    /// 401 — the stored key/session is no longer valid; re-login needed.
    Unauthorized,
    /// 429 — rate limited.
    RateLimited,
    /// Any other non-2xx status from the inference API.
    Server,
    /// Transport failure (DNS, connect, reset, mid-stream read error).
    Network,
    /// A local failure: keychain error, store error, malformed payload.
    Protocol,
}

/// The outcome of parsing one SSE `data:` payload of the OpenAI streaming
/// shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeltaOutcome {
    /// Nothing to emit: `[DONE]` sentinel, empty data, malformed JSON, a
    /// role-only delta or a delta without content.
    None,
    /// An assistant text delta to accumulate and forward.
    Delta(String),
}

/// Parse one OpenAI streaming data payload and extract the assistant delta.
///
/// - `data: [DONE]` → [`DeltaOutcome::None`] (the stream end is detected by
///   the caller via [`is_done_sentinel`])
/// - `{"choices":[{"delta":{"content":"…"}}]}` → the content delta
/// - role-only deltas, empty content, missing choices and malformed JSON are
///   ignored (defensive: servers send keep-alives and role preambles)
pub fn extract_delta(data: &str) -> DeltaOutcome {
    if is_done_sentinel(data) {
        return DeltaOutcome::None;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return DeltaOutcome::None;
    };
    let Some(content) = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("delta"))
        .and_then(|delta| delta.get("content"))
        .and_then(|content| content.as_str())
    else {
        return DeltaOutcome::None;
    };
    if content.is_empty() {
        return DeltaOutcome::None;
    }
    DeltaOutcome::Delta(content.to_string())
}

/// Whether a data payload is the OpenAI `[DONE]` stream terminator.
pub fn is_done_sentinel(data: &str) -> bool {
    data.trim() == "[DONE]"
}

/// Classify a non-2xx HTTP status of a chat/models request.
pub fn classify_chat_status(status: u16) -> ErrorKind {
    match status {
        401 => ErrorKind::Unauthorized,
        429 => ErrorKind::RateLimited,
        _ => ErrorKind::Server,
    }
}

/// Transport failures are all `network` for chat purposes (a timeout is a
/// network failure; the chat spec has no separate timeout kind).
pub fn classify_transport(_is_timeout: bool) -> ErrorKind {
    ErrorKind::Network
}

/// Known non-chat model ids (NaN-Open-WebUI catalog reference).
const NON_CHAT_EXACT: [&str; 6] = [
    "kokoro",
    "whisper",
    "qwen3-embedding",
    "rerank",
    "qwen-image-2.1",
    "flux-2-klein",
];

/// Any model id containing one of these substrings is not chat-capable
/// (matched case-insensitively).
const NON_CHAT_SUBSTRINGS: [&str; 7] =
    ["embedding", "rerank", "whisper", "kokoro", "image", "flux", "audio"];

/// Sort headliner: always first in the picker.
const CHAT_MODEL_HEADLINER: &str = "deepseek-v4-flash";

/// Filter a raw `/v1/models` id list down to chat-capable models and sort
/// with [`CHAT_MODEL_HEADLINER`] first (remaining ids keep their original
/// order). Pure and unit-tested.
pub fn filter_chat_models(ids: Vec<String>) -> Vec<String> {
    let mut kept: Vec<String> = ids
        .into_iter()
        .filter(|id| {
            let lower = id.to_lowercase();
            !NON_CHAT_EXACT.contains(&lower.as_str())
                && !NON_CHAT_SUBSTRINGS.iter().any(|s| lower.contains(s))
        })
        .collect();
    if let Some(pos) = kept.iter().position(|id| id == CHAT_MODEL_HEADLINER) {
        let headliner = kept.remove(pos);
        kept.insert(0, headliner);
    }
    kept
}

/// Parse the JSON body of a `GET /v1/models` response into raw ids.
pub fn parse_model_ids(body: &str) -> Result<Vec<String>, ErrorKind> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| ErrorKind::Protocol)?;
    let data = value
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or(ErrorKind::Protocol)?;
    Ok(data
        .iter()
        .filter_map(|model| model.get("id").and_then(|id| id.as_str()))
        .map(str::to_string)
        .collect())
}

/// Maximum chars of the auto-title (first user message, truncated).
pub const TITLE_MAX_CHARS: usize = 48;

/// Derive the conversation title from the first user message: whitespace
/// collapsed, truncated to [`TITLE_MAX_CHARS`] chars (never splitting a
/// multi-byte character). No extra model call in the MVP.
pub fn title_from_first_user_message(content: &str) -> String {
    let collapsed = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= TITLE_MAX_CHARS {
        return collapsed;
    }
    collapsed.chars().take(TITLE_MAX_CHARS).collect()
}

/// Incrementally decode a byte buffer into UTF-8 text: complete multi-byte
/// sequences are consumed, a trailing partial sequence stays buffered for the
/// next network chunk, and genuinely invalid bytes are skipped so one corrupt
/// byte cannot kill the stream.
pub fn decode_incremental(pending: &mut Vec<u8>) -> String {
    let mut text = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                text.push_str(valid);
                pending.clear();
                return text;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    text.push_str(&String::from_utf8_lossy(&pending[..valid_up_to]));
                    pending.drain(..valid_up_to);
                }
                if err.error_len().is_some() {
                    // Genuinely invalid byte: skip it and keep going.
                    pending.remove(0);
                } else {
                    // Incomplete multi-byte sequence: wait for more bytes.
                    return text;
                }
            }
        }
    }
}

/// Inference base for a profile. Normally the profile's compiled-in constant
/// (S2); in debug builds the `NAN_DESKTOP_MOCK_INFERENCE` environment
/// variable may point chat traffic at a local mock (`test/mock-chat.mjs`).
/// Release builds ignore the variable entirely (S12).
pub fn inference_base(profile_id: &str) -> Option<String> {
    if cfg!(debug_assertions)
        && let Ok(mock) = std::env::var("NAN_DESKTOP_MOCK_INFERENCE")
    {
        let mock = mock.trim().trim_end_matches('/');
        if !mock.is_empty() {
            return Some(mock.to_string());
        }
    }
    profile::inference_base_for(profile_id).map(str::to_string)
}

// ---------------------------------------------------------------------------
// Event payloads (the renderer never sees the key or any URL — S4)
// ---------------------------------------------------------------------------

/// `chat://delta` — one assistant text delta.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeltaPayload {
    pub conversation_id: i64,
    pub delta: String,
}

/// `chat://done` — the stream finished and the assistant message persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DonePayload {
    pub conversation_id: i64,
}

/// `chat://error` — classified failure; nothing assistant-side persisted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ChatErrorPayload {
    pub conversation_id: i64,
    pub kind: ErrorKind,
}

// ---------------------------------------------------------------------------
// Active-stream registry (cancel-safe: one stream per conversation)
// ---------------------------------------------------------------------------

/// Active chat streams keyed by conversation id. The generation counter and
/// handle are filled in two steps (reserve → spawn → attach) so the command
/// stays race-free without the task reading shared state: the task receives
/// its generation as a parameter. Sending again into a conversation aborts
/// the previous stream (serializes a conversation; different conversations
/// may stream in parallel).
/// One registry entry: the generation counter and (once attached) the
/// stream task's handle.
type ActiveStream = (u64, Option<JoinHandle<()>>);

#[derive(Default)]
pub struct ChatState(Mutex<HashMap<String, ActiveStream>>);

/// Atomically abort the previous stream for `conversation_id` (if any) and
/// reserve the next generation. No handle yet — `attach_stream` adds it.
fn reserve_stream(state: &ChatState, conversation_id: i64) -> Result<u64, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "chat state mutex poisoned".to_string())?;
    let map_key = conversation_id.to_string();
    let generation = guard
        .get(&map_key)
        .map(|(entry_gen, _)| entry_gen + 1)
        .unwrap_or(1);
    if let Some((_, Some(handle))) = guard.remove(&map_key) {
        handle.abort();
    }
    guard.insert(map_key, (generation, None));
    Ok(generation)
}

/// Attach the freshly spawned handle to its reserved generation. If another
/// send already superseded this one (a higher generation is registered), the
/// handle is aborted immediately — the superseded task never streams.
fn attach_stream(
    state: &ChatState,
    conversation_id: i64,
    generation: u64,
    handle: JoinHandle<()>,
) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "chat state mutex poisoned".to_string())?;
    let map_key = conversation_id.to_string();
    match guard.get(&map_key) {
        Some((entry_gen, _)) if *entry_gen == generation => {
            guard.insert(map_key, (generation, Some(handle)));
            Ok(())
        }
        _ => {
            handle.abort();
            Ok(())
        }
    }
}

/// Remove this task's registry entry — but only if it is still the newest
/// (a superseding task must not be evicted by the stream it replaced).
fn release_stream(state: &ChatState, conversation_id: i64, generation: u64) {
    if let Ok(mut guard) = state.0.lock() {
        let map_key = conversation_id.to_string();
        if guard.get(&map_key).map(|(entry_gen, _)| *entry_gen) == Some(generation) {
            guard.remove(&map_key);
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Read a profile's inference key from the OS keychain (never rendered,
/// logged, or echoed — S4).
fn read_profile_key(profile_id: &str) -> Result<String, ErrorKind> {
    match keyring::Entry::new(KEYRING_SERVICE, &profile::key_account(profile_id))
        .and_then(|entry| entry.get_password())
    {
        Ok(key) if !key.is_empty() => Ok(key),
        Ok(_) => Err(ErrorKind::MissingKey),
        Err(keyring::Error::NoEntry) => Err(ErrorKind::MissingKey),
        Err(_) => Err(ErrorKind::Protocol),
    }
}

/// Send a user message into a conversation and stream the assistant reply.
///
/// Persisting happens here in the command (BEFORE the stream task starts):
/// the auto-title from the first user message and the user message row. The
/// assistant message is persisted by the stream task after a clean finish.
/// Returns immediately; progress arrives via `chat://delta`, `chat://done`
/// and `chat://error` events.
#[tauri::command]
pub fn chat_send(
    app: AppHandle,
    window: Window,
    conversation_id: i64,
    model: String,
    content: String,
) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("message is empty".to_string());
    }
    // Defensive fallback: the UI always sends an explicit model; an empty
    // one falls back to the headliner instead of erroring the whole send.
    let model = if model.trim().is_empty() {
        DEFAULT_MODEL.to_string()
    } else {
        model
    };
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let conn = chat_store::open_db(&dir)?;

    let conversation = chat_store::conversation_get(&conn, conversation_id)
        .map_err(|err| err.to_string())?
        .ok_or_else(|| format!("unknown conversation id: {conversation_id}"))?;
    if conversation.title.is_empty() {
        chat_store::set_conversation_title(
            &conn,
            conversation_id,
            &title_from_first_user_message(&content),
        )
        .map_err(|err| err.to_string())?;
    }
    chat_store::insert_message(&conn, conversation_id, "user", &content, None)
        .map_err(|err| err.to_string())?;
    chat_store::touch_conversation(&conn, conversation_id).map_err(|err| err.to_string())?;

    let state = app.state::<ChatState>();
    // Cancel-safe: reserve (aborting the previous stream for this
    // conversation) before spawning, then attach the handle to the reserved
    // generation so a superseded task is aborted instead of orphaned.
    let generation = reserve_stream(&state, conversation_id)?;
    let handle = tauri::async_runtime::spawn(run_chat_stream(
        app.clone(),
        window,
        conversation_id,
        conversation.profile_id,
        model,
        generation,
    ));
    attach_stream(&state, conversation_id, generation, handle)?;
    Ok(())
}

/// The managed stream task: build the request from stored history, stream the
/// SSE reply, accumulate deltas, persist the assistant message on success.
/// `generation` identifies this task in the active-stream registry.
async fn run_chat_stream(
    app: AppHandle,
    window: Window,
    conversation_id: i64,
    profile_id: String,
    model: String,
    generation: u64,
) {
    let state = app.state::<ChatState>();

    let emit_error = |kind: ErrorKind| {
        let _ = window.emit(
            "chat://error",
            ChatErrorPayload {
                conversation_id,
                kind,
            },
        );
    };

    // ---- credentials + endpoint (Rust core only, S4) ---------------------
    let key = match read_profile_key(&profile_id) {
        Ok(key) => key,
        Err(kind) => {
            emit_error(kind);
            release_stream(&state, conversation_id, generation);
            return;
        }
    };
    let Some(base) = inference_base(&profile_id) else {
        emit_error(ErrorKind::Protocol);
        release_stream(&state, conversation_id, generation);
        return;
    };

    // ---- history + request body ------------------------------------------
    let dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => {
            emit_error(ErrorKind::Protocol);
            release_stream(&state, conversation_id, generation);
            return;
        }
    };
    let conn = match chat_store::open_db(&dir) {
        Ok(conn) => conn,
        Err(_) => {
            emit_error(ErrorKind::Protocol);
            release_stream(&state, conversation_id, generation);
            return;
        }
    };
    let history: Vec<serde_json::Value> = match chat_store::list_messages(&conn, conversation_id) {
        Ok(rows) => rows
            .iter()
            .map(|row| serde_json::json!({ "role": row.role, "content": row.content }))
            .collect(),
        Err(_) => {
            emit_error(ErrorKind::Protocol);
            release_stream(&state, conversation_id, generation);
            return;
        }
    };

    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            emit_error(ErrorKind::Protocol);
            release_stream(&state, conversation_id, generation);
            return;
        }
    };

    // ---- POST /chat/completions (stream: true) ---------------------------
    let response = match client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(&key)
        .json(&serde_json::json!({
            "model": model,
            "messages": history,
            "stream": true,
        }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            emit_error(classify_transport(err.is_timeout()));
            release_stream(&state, conversation_id, generation);
            return;
        }
    };
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        emit_error(classify_chat_status(status));
        release_stream(&state, conversation_id, generation);
        return;
    }

    // ---- stream the SSE reply --------------------------------------------
    use futures_util::StreamExt;

    let mut stream = response.bytes_stream();
    let mut byte_buffer: Vec<u8> = Vec::new();
    let mut sse_buffer = String::new();
    let mut accumulated = String::new();
    let mut failed: Option<ErrorKind> = None;
    let mut finished = false;

    while let Some(item) = stream.next().await {
        match item {
            Ok(bytes) => {
                byte_buffer.extend_from_slice(&bytes);
                sse_buffer.push_str(&decode_incremental(&mut byte_buffer));
                for data in parse_sse_buffer(&mut sse_buffer) {
                    if is_done_sentinel(&data) {
                        finished = true;
                        break;
                    }
                    if let DeltaOutcome::Delta(text) = extract_delta(&data) {
                        accumulated.push_str(&text);
                        let _ = window.emit(
                            "chat://delta",
                            DeltaPayload {
                                conversation_id,
                                delta: text,
                            },
                        );
                    }
                }
                if finished {
                    break;
                }
            }
            Err(err) => {
                failed = Some(classify_transport(err.is_timeout()));
                break;
            }
        }
    }

    if failed.is_none() && !finished {
        // Flush a stream that ended without a trailing blank line / [DONE].
        for data in flush_sse_buffer(&mut sse_buffer) {
            if let DeltaOutcome::Delta(text) = extract_delta(&data) {
                accumulated.push_str(&text);
                let _ = window.emit(
                    "chat://delta",
                    DeltaPayload {
                        conversation_id,
                        delta: text,
                    },
                );
            }
        }
    }

    // ---- persist + notify --------------------------------------------------
    match failed {
        Some(kind) => emit_error(kind), // partial text is dropped by design
        None => {
            let persisted = chat_store::insert_message(
                &conn,
                conversation_id,
                "assistant",
                &accumulated,
                Some(&model),
            )
            .and_then(|_| chat_store::touch_conversation(&conn, conversation_id));
            match persisted {
                Ok(()) => {
                    let _ = window.emit("chat://done", DonePayload { conversation_id });
                }
                Err(_) => emit_error(ErrorKind::Protocol),
            }
        }
    }
    release_stream(&state, conversation_id, generation);
}

/// Sidebar list: a profile's conversations, most recent first, each with a
/// last-message preview. Titles arrive display-ready (auto-title applied or
/// the untitled fallback).
#[tauri::command]
pub fn conversation_list(
    app: AppHandle,
    profile_id: String,
) -> Result<Vec<ConversationView>, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let conn = chat_store::open_db(&dir)?;
    chat_store::list_conversations(&conn, &profile_id).map_err(|err| err.to_string())
}

/// Create an empty conversation and return its id. `title` is optional —
/// without one the conversation stays untitled until the first user message
/// auto-titles it.
#[tauri::command]
pub fn conversation_create(
    app: AppHandle,
    profile_id: String,
    title: Option<String>,
) -> Result<i64, String> {
    // Only the two locked profiles are ever valid owners (S2/S12).
    if profile::profile_by_id(&profile_id).is_none() {
        return Err(format!("unknown profile id: {profile_id:?}"));
    }
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let conn = chat_store::open_db(&dir)?;
    chat_store::insert_conversation(&conn, &profile_id, title.as_deref().unwrap_or(""))
        .map_err(|err| err.to_string())
}

/// Delete a conversation and its messages.
#[tauri::command]
pub fn conversation_delete(app: AppHandle, conversation_id: i64) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let conn = chat_store::open_db(&dir)?;
    chat_store::delete_conversation(&conn, conversation_id).map_err(|err| err.to_string())
}

/// Load a conversation's transcript (ascending id order).
#[tauri::command]
pub fn messages_list(app: AppHandle, conversation_id: i64) -> Result<Vec<ChatMessageRow>, String> {
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let conn = chat_store::open_db(&dir)?;
    chat_store::list_messages(&conn, conversation_id).map_err(|err| err.to_string())
}

/// Chat-capable models for the active profile: `GET {inference_base}/models`
/// with the keychain Bearer, filtered and sorted by [`filter_chat_models`].
/// The renderer receives model ids only — never the key, never a URL (S4).
#[tauri::command]
pub async fn models_list(app: AppHandle) -> Result<Vec<String>, ErrorKind> {
    let dir = app.path().app_data_dir().map_err(|_| ErrorKind::Protocol)?;
    let store = profile::load_or_seed(&dir).map_err(|_| ErrorKind::Protocol)?;
    let Some(active) = store.active_profile.clone() else {
        return Err(ErrorKind::MissingKey);
    };
    let key = read_profile_key(&active)?;
    let base = inference_base(&active).ok_or(ErrorKind::Protocol)?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|_| ErrorKind::Protocol)?;
    let response = client
        .get(format!("{base}/models"))
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|err| classify_transport(err.is_timeout()))?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(classify_chat_status(status));
    }
    let body = response
        .text()
        .await
        .map_err(|err| classify_transport(err.is_timeout()))?;
    Ok(filter_chat_models(parse_model_ids(&body)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- extract_delta -----------------------------------------------------

    #[test]
    fn extracts_content_delta_from_openai_chunk() {
        let data = r#"{"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#;
        assert_eq!(
            extract_delta(data),
            DeltaOutcome::Delta("Hello".to_string())
        );
    }

    #[test]
    fn done_sentinel_is_detected_and_yields_nothing() {
        assert!(is_done_sentinel("[DONE]"));
        assert!(is_done_sentinel(" [DONE] "), "tolerates stray whitespace");
        assert!(!is_done_sentinel("[DONEX]"));
        assert_eq!(extract_delta("[DONE]"), DeltaOutcome::None);
    }

    #[test]
    fn role_only_and_empty_deltas_are_ignored() {
        let role_only = r#"{"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#;
        assert_eq!(extract_delta(role_only), DeltaOutcome::None);
        let no_content = r#"{"choices":[{"index":0,"delta":{}}]}"#;
        assert_eq!(extract_delta(no_content), DeltaOutcome::None);
        let empty_content = r#"{"choices":[{"index":0,"delta":{"content":""}}]}"#;
        assert_eq!(extract_delta(empty_content), DeltaOutcome::None);
    }

    #[test]
    fn malformed_and_shapeless_data_is_ignored_not_fatal() {
        assert_eq!(extract_delta("<html>noise</html>"), DeltaOutcome::None);
        assert_eq!(extract_delta("{}"), DeltaOutcome::None);
        assert_eq!(extract_delta(r#"{"choices":[]}"#), DeltaOutcome::None);
        assert_eq!(
            extract_delta(r#"{"choices":[{"delta":{"content":42}}]}"#),
            DeltaOutcome::None,
            "non-string content is ignored"
        );
        // Only the first choice is consumed (n=1 in this app).
        let multi = r#"{"choices":[{"delta":{"content":"a"}},{"delta":{"content":"b"}}]}"#;
        assert_eq!(extract_delta(multi), DeltaOutcome::Delta("a".to_string()));
    }

    // ---- classify_chat_status ----------------------------------------------

    #[test]
    fn http_401_is_unauthorized() {
        assert_eq!(classify_chat_status(401), ErrorKind::Unauthorized);
    }

    #[test]
    fn http_429_is_rate_limited() {
        assert_eq!(classify_chat_status(429), ErrorKind::RateLimited);
    }

    #[test]
    fn other_4xx_and_5xx_are_server_errors() {
        assert_eq!(classify_chat_status(400), ErrorKind::Server);
        assert_eq!(classify_chat_status(403), ErrorKind::Server);
        assert_eq!(classify_chat_status(404), ErrorKind::Server);
        assert_eq!(classify_chat_status(500), ErrorKind::Server);
        assert_eq!(classify_chat_status(503), ErrorKind::Server);
    }

    #[test]
    fn error_kinds_serialize_snake_case() {
        // The renderer switches on these exact strings.
        let cases = [
            (ErrorKind::MissingKey, "missing_key"),
            (ErrorKind::Unauthorized, "unauthorized"),
            (ErrorKind::RateLimited, "rate_limited"),
            (ErrorKind::Server, "server"),
            (ErrorKind::Network, "network"),
            (ErrorKind::Protocol, "protocol"),
        ];
        for (kind, expected) in cases {
            let payload = serde_json::to_string(&ChatErrorPayload {
                conversation_id: 1,
                kind,
            })
            .expect("serialize");
            assert_eq!(
                payload,
                format!(r#"{{"conversation_id":1,"kind":"{expected}"}}"#)
            );
        }
    }

    // ---- filter_chat_models -------------------------------------------------

    /// The exact catalog `test/mock-chat.mjs` serves (6 chat + 6 non-chat).
    /// Keep in sync with the mock — the integration check asserts the wire
    /// payload matches this fixture.
    fn full_catalog() -> Vec<String> {
        [
            "deepseek-v4-flash",
            "glm5.3-flash",
            "mimo-v2.6-flash",
            "qwen3.8-flash",
            "gemma4",
            "qwen3.6",
            "kokoro",
            "whisper",
            "qwen3-embedding",
            "rerank",
            "qwen-image-2.1",
            "flux-2-klein",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    #[test]
    fn filters_full_catalog_to_six_chat_models_deepseek_first() {
        let filtered = filter_chat_models(full_catalog());
        assert_eq!(
            filtered,
            vec![
                "deepseek-v4-flash",
                "glm5.3-flash",
                "mimo-v2.6-flash",
                "qwen3.8-flash",
                "gemma4",
                "qwen3.6",
            ]
        );
    }

    #[test]
    fn headliner_is_moved_to_front_even_when_served_last() {
        let mut ids = full_catalog();
        ids.reverse();
        let filtered = filter_chat_models(ids);
        assert_eq!(filtered[0], "deepseek-v4-flash");
        assert_eq!(filtered.len(), 6);
    }

    #[test]
    fn substring_and_case_filters_exclude_audio_embedding_image_models() {
        let ids: Vec<String> = [
            "text-embedding-3-large",
            "Embedding-XL",
            "rerank-v2",
            "RERANKER",
            "whisper-large-v3",
            "Kokoro-TTS",
            "qwen-image-edit",
            "FLUX.1-dev",
            "gpt-4o-audio",
            "qwen3.8-flash",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(filter_chat_models(ids), vec!["qwen3.8-flash".to_string()]);
    }

    #[test]
    fn unknown_chat_ids_are_kept_in_order() {
        let ids: Vec<String> = ["zeta-model", "alpha-model"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(filter_chat_models(ids), vec!["zeta-model", "alpha-model"]);
        assert!(filter_chat_models(Vec::new()).is_empty());
    }

    // ---- parse_model_ids ------------------------------------------------------

    #[test]
    fn parses_openai_models_list_body() {
        let body = r#"{"object":"list","data":[
            {"id":"deepseek-v4-flash","object":"model","owned_by":"nan"},
            {"id":"kokoro","object":"model","owned_by":"nan"},
            {"id":42}
        ]}"#;
        let ids = parse_model_ids(body).expect("parse");
        assert_eq!(
            ids,
            vec!["deepseek-v4-flash".to_string(), "kokoro".to_string()]
        );
    }

    #[test]
    fn malformed_models_body_is_protocol_error() {
        assert_eq!(
            parse_model_ids("<html>nope</html>"),
            Err(ErrorKind::Protocol)
        );
        assert_eq!(parse_model_ids(r#"{"data":42}"#), Err(ErrorKind::Protocol));
        assert_eq!(
            parse_model_ids(r#"{"objects":[]}"#),
            Err(ErrorKind::Protocol)
        );
    }

    // ---- title_from_first_user_message ----------------------------------------

    #[test]
    fn short_titles_pass_through() {
        assert_eq!(
            title_from_first_user_message("How do I stream SSE?"),
            "How do I stream SSE?"
        );
    }

    #[test]
    fn long_titles_truncate_to_48_chars() {
        let long = "a".repeat(200);
        assert_eq!(
            title_from_first_user_message(&long),
            "a".repeat(TITLE_MAX_CHARS)
        );
        let boundary = "b".repeat(TITLE_MAX_CHARS);
        assert_eq!(title_from_first_user_message(&boundary), boundary);
        let over = format!("{boundary}c");
        assert_eq!(title_from_first_user_message(&over), boundary);
    }

    #[test]
    fn titles_collapse_whitespace_and_keep_multibyte_chars() {
        assert_eq!(
            title_from_first_user_message("  hola\n  mundo\t!  "),
            "hola mundo !"
        );
        let cjk = "😐".repeat(60);
        let title = title_from_first_user_message(&cjk);
        assert_eq!(title.chars().count(), TITLE_MAX_CHARS);
        // 48 emoji chars, no broken halves.
        assert!(title.chars().all(|c| c == '😐'));
        assert_eq!(
            title_from_first_user_message("日本語のテスト会話です"),
            "日本語のテスト会話です"
        );
    }

    // ---- decode_incremental -----------------------------------------------------

    #[test]
    fn decodes_complete_ascii_immediately() {
        let mut pending = b"data: hello".to_vec();
        assert_eq!(decode_incremental(&mut pending), "data: hello");
        assert!(pending.is_empty());
    }

    #[test]
    fn holds_partial_multibyte_sequence_for_the_next_chunk() {
        // "é" = [0xC3, 0xA9] split across two network chunks.
        let mut pending = vec![0x43, 0x61, 0x66, 0xC3];
        assert_eq!(decode_incremental(&mut pending), "Caf");
        assert_eq!(pending, vec![0xC3], "partial sequence stays buffered");
        pending.push(0xA9);
        pending.extend_from_slice(b"\n");
        assert_eq!(decode_incremental(&mut pending), "é\n");
        assert!(pending.is_empty());
    }

    #[test]
    fn skips_invalid_bytes_and_keeps_streaming() {
        let mut pending = vec![b'a', 0xFF, b'b', 0xC3, 0x28];
        // 0xFF is invalid; 0xC3 0x28 is an invalid 2-byte start followed by '('.
        let text = decode_incremental(&mut pending);
        assert!(
            text.contains('a') && text.contains('b'),
            "valid chars kept: {text}"
        );
        assert!(
            pending.is_empty(),
            "invalid bytes are consumed, not buffered"
        );
    }

    #[test]
    fn empty_buffer_decodes_to_empty_text() {
        let mut pending = Vec::new();
        assert_eq!(decode_incremental(&mut pending), "");
    }

    // ---- classify_transport --------------------------------------------------------

    #[test]
    fn transport_failures_are_network_errors() {
        assert_eq!(classify_transport(true), ErrorKind::Network);
        assert_eq!(classify_transport(false), ErrorKind::Network);
    }

    // ---- inference_base -------------------------------------------------------------
    // The env-override path (NAN_DESKTOP_MOCK_INFERENCE) is debug-only glue and
    // is not unit-tested: mutating process-global env vars in parallel tests is
    // unsound. The constants path is covered by the profile suite; the mock
    // override is exercised via `NAN_DESKTOP_MOCK_INFERENCE pnpm tauri dev`.

    #[test]
    fn default_model_is_the_headliner() {
        assert_eq!(DEFAULT_MODEL, "deepseek-v4-flash");
        let filtered = filter_chat_models(full_catalog());
        assert_eq!(filtered[0], DEFAULT_MODEL);
    }
}
