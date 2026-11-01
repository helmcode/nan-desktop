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
//! - `chat://stopped` `{conversation_id}` — the user stopped the stream (T4b)
//! - `chat://activity` `{conversation_id, activity}` — `searching` /
//!   `working` while a tool runs, `null` when the model writes again
//!
//! Tool calling (P1-7 + workspace): every request offers the `web_search`
//! function (see `web_search.rs`) and, when the user set up a workspace,
//! the file tools. Requested calls are run by the core — web search through
//! the platform API (silent when unavailable), file actions through the
//! tools subsystem with a NATIVE approval dialog per action — and the
//! results are fed back until the model answers in text (at most
//! [`MAX_TOOL_ROUNDS`] rounds). A server that rejects `tools` (400) is
//! retried once without them. Web sources are persisted with the reply and
//! rendered as citation chips.
//!
//! Error kinds: `missing_key` / `unauthorized` (401 → the session must
//! re-login) / `rate_limited` (429) / `server` (other non-2xx) / `network`
//! (transport) / `protocol` (local failures: keychain, store, malformed
//! payloads) / `decode` (audio-only: the TTS reply could not be decoded —
//! chat never produces this kind).
//!
//! Persistence (T4b): the user message is stored BEFORE streaming starts;
//! the assistant reply is stored as an `in_progress` row once the API
//! answers 2xx and every received network chunk's deltas are flushed into
//! that row before the task waits for the next one — a crash/kill mid-stream
//! leaves the partial reply in the DB (flagged `partial` by `messages_list`).
//! A clean finish finalizes the row in place; a deliberate stop finalizes it
//! too (the text that arrived stays, no failed marker); a classified error
//! deletes it (the partial text is dropped by design, unchanged from T4).
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

use crate::chat_store::{self, ChatMessageRow, ConversationView, WebSource};
use crate::profile::{self, KEYRING_SERVICE};
use crate::sse::{flush_sse_buffer, parse_sse_buffer};
use crate::{tools, web_search};

/// Connect timeout for chat/model requests. No overall request timeout: a
/// long stream must not be killed mid-generation.
pub const CONNECT_TIMEOUT_SECS: u64 = 10;

/// Default chat model (first in the filtered list; see `filter_chat_models`).
pub const DEFAULT_MODEL: &str = "deepseek-v4-flash";

// ---------------------------------------------------------------------------
// Pure, unit-tested core
// ---------------------------------------------------------------------------

/// Why a chat or audio (TTS/STT) attempt failed. Serialized into
/// `chat://error` / `tts://error` payloads and returned by `models_list`,
/// `stt_transcribe` and the `ErrorKind`-returning TTS helpers.
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
    /// A local failure: keychain error, store error, malformed payload,
    /// no audio output device.
    Protocol,
    /// Audio-only (T6): the reply bytes could not be decoded as the
    /// requested audio format. Never produced by the chat surface.
    Decode,
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

// ---------------------------------------------------------------------------
// Tool calling (P1-7 web search + workspace file tools)
// ---------------------------------------------------------------------------

/// Most model ↔ tool round trips in one reply. The final round is sent
/// without tools so the model must answer in text.
pub const MAX_TOOL_ROUNDS: usize = 6;

/// Longest tool output fed back to the model (chars). Keeps one big file
/// read from flooding the context window.
pub const MAX_TOOL_RESULT_CHARS: usize = 60_000;

/// One complete tool call requested by the model.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Rebuilds streamed `delta.tool_calls` fragments (OpenAI streaming shape:
/// `{index, id?, function: {name?, arguments?}}`, arguments arrive in
/// pieces) into complete calls.
#[derive(Debug, Default)]
pub struct ToolCallAccumulator {
    calls: Vec<ToolCall>,
}

impl ToolCallAccumulator {
    /// Absorb the tool-call fragments of one SSE data payload (ignores
    /// payloads without any).
    pub fn absorb(&mut self, data: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
            return;
        };
        let Some(fragments) = value
            .get("choices")
            .and_then(|choices| choices.get(0))
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("tool_calls"))
            .and_then(|calls| calls.as_array())
        else {
            return;
        };
        for (position, fragment) in fragments.iter().enumerate() {
            let index = fragment
                .get("index")
                .and_then(|i| i.as_u64())
                .and_then(|i| usize::try_from(i).ok())
                .unwrap_or(position);
            // A bounded index: a hostile stream cannot make us allocate.
            if index >= 32 {
                continue;
            }
            if self.calls.len() <= index {
                self.calls.resize(index + 1, ToolCall::default());
            }
            let call = &mut self.calls[index];
            if let Some(id) = fragment.get("id").and_then(|id| id.as_str())
                && !id.is_empty()
            {
                call.id = id.to_string();
            }
            if let Some(function) = fragment.get("function") {
                if let Some(name) = function.get("name").and_then(|n| n.as_str()) {
                    call.name.push_str(name);
                }
                if let Some(arguments) = function.get("arguments").and_then(|a| a.as_str()) {
                    call.arguments.push_str(arguments);
                }
            }
        }
    }

    /// The complete calls (unnamed fragments dropped, missing ids filled).
    pub fn finish(self) -> Vec<ToolCall> {
        self.calls
            .into_iter()
            .enumerate()
            .filter(|(_, call)| !call.name.is_empty())
            .map(|(i, mut call)| {
                if call.id.is_empty() {
                    call.id = format!("call_{i}");
                }
                call
            })
            .collect()
    }
}

/// File tools offered when the profile has a workspace (OpenAI function
/// definitions; paths are absolute and must sit inside a workspace folder —
/// the Rust core enforces that, the model is only told).
fn file_tool_definitions(run_command: bool) -> Vec<serde_json::Value> {
    let path = serde_json::json!({ "type": "string", "description": "Absolute path inside one of the workspace folders." });
    let mut defs = vec![
        serde_json::json!({ "type": "function", "function": {
            "name": "list_files",
            "description": "List the files and folders inside a folder (up to 3 levels deep).",
            "parameters": { "type": "object", "properties": { "path": path }, "required": ["path"] }
        }}),
        serde_json::json!({ "type": "function", "function": {
            "name": "read_file",
            "description": "Read a text file.",
            "parameters": { "type": "object", "properties": { "path": path }, "required": ["path"] }
        }}),
        serde_json::json!({ "type": "function", "function": {
            "name": "write_file",
            "description": "Create a text file or replace its whole content.",
            "parameters": { "type": "object", "properties": {
                "path": path,
                "content": { "type": "string", "description": "The full new content." }
            }, "required": ["path", "content"] }
        }}),
        serde_json::json!({ "type": "function", "function": {
            "name": "replace_file",
            "description": "Replace one exact, unique piece of text in a file.",
            "parameters": { "type": "object", "properties": {
                "path": path,
                "old": { "type": "string", "description": "Exact text to replace (must appear once)." },
                "new": { "type": "string", "description": "Replacement text." }
            }, "required": ["path", "old", "new"] }
        }}),
    ];
    if run_command {
        defs.push(serde_json::json!({ "type": "function", "function": {
            "name": "run_command",
            "description": "Run a shell command inside a workspace folder (30 s limit).",
            "parameters": { "type": "object", "properties": {
                "cmd": { "type": "string", "description": "The command line." },
                "cwd": { "type": "string", "description": "Absolute workspace folder to run it in." }
            }, "required": ["cmd", "cwd"] }
        }}));
    }
    defs
}

/// Every tool offered to the model for one reply: web search always, file
/// tools only when the user set up a workspace.
pub fn tool_definitions(workspace: Option<&tools::Workspace>) -> Vec<serde_json::Value> {
    let mut defs = vec![web_search::tool_definition()];
    if let Some(workspace) = workspace {
        defs.extend(file_tool_definitions(workspace.run_command));
    }
    defs
}

/// System message describing the workspace (only sent when one exists).
pub fn workspace_prompt(workspace: &tools::Workspace) -> String {
    let folders = workspace
        .roots
        .iter()
        .map(|root| format!("- {}", root.display()))
        .collect::<Vec<_>>()
        .join("\n");
    let scope = if workspace.computer_wide {
        "The user gave you access to their whole user folder."
    } else {
        "You may only work inside these folders."
    };
    format!(
        "You can work with the user's files through the file tools. {scope}\n\
         Workspace folders:\n{folders}\n\
         Always use absolute paths. Every action is shown to the user for approval; \
         if they decline, do not retry — ask them how to proceed."
    )
}

/// Map a model file-tool call onto a core [`tools::ToolAction`]. Unknown
/// names and malformed arguments are rejected (fed back to the model).
pub fn action_from_call(name: &str, arguments: &str) -> Result<tools::ToolAction, String> {
    let mut args: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(if arguments.trim().is_empty() {
            "{}"
        } else {
            arguments
        })
        .map_err(|_| "arguments are not a JSON object".to_string())?;
    if name == "run_command"
        && let Some(cwd) = args.remove("cwd")
    {
        args.insert("cwd_in_grant".into(), cwd);
    }
    args.insert("type".into(), serde_json::Value::String(name.to_string()));
    tools::parse_action(&serde_json::Value::Object(args).to_string())
        .map_err(|rejection| rejection.message)
}

fn cap_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut capped: String = text.chars().take(max).collect();
    capped.push_str("\n… (truncated)");
    capped
}

/// The tool-message content fed back to the model for a file action.
pub fn outcome_for_model(result: Result<tools::ToolOutcome, tools::Rejection>) -> String {
    match result {
        Ok(outcome) => {
            let mut value = serde_json::json!({ "ok": true, "summary": outcome.summary });
            if let Some(content) = outcome.content {
                value["content"] = cap_chars(&content, MAX_TOOL_RESULT_CHARS).into();
            }
            if let Some(entries) = outcome.entries {
                value["entries"] = entries.into();
            }
            if let Some(stdout) = outcome.stdout {
                value["stdout"] = cap_chars(&stdout, MAX_TOOL_RESULT_CHARS).into();
            }
            if let Some(stderr) = outcome.stderr {
                value["stderr"] = cap_chars(&stderr, MAX_TOOL_RESULT_CHARS).into();
            }
            if let Some(code) = outcome.exit_code {
                value["exit_code"] = code.into();
            }
            value.to_string()
        }
        Err(rejection) if rejection.kind == "declined" => serde_json::json!({
            "ok": false,
            "error": "declined",
            "message": "The user did not allow this action. Do not retry it; ask them how to proceed."
        })
        .to_string(),
        Err(rejection) => serde_json::json!({
            "ok": false,
            "error": rejection.kind,
            "message": rejection.message
        })
        .to_string(),
    }
}

/// The chat-completions request body for one round.
pub fn request_body(
    model: &str,
    messages: &[serde_json::Value],
    tools: &[serde_json::Value],
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools.to_vec());
        body["tool_choice"] = "auto".into();
    }
    body
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
const NON_CHAT_SUBSTRINGS: [&str; 7] = [
    "embedding",
    "rerank",
    "whisper",
    "kokoro",
    "image",
    "flux",
    "audio",
];

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

/// Abort and remove the active stream entry for a conversation — the stop
/// button path (distinct from `reserve_stream`, which replaces the entry
/// when a new send supersedes the old stream). Returns whether an active
/// entry existed. An entry without an attached handle yet (a send that has
/// not spawned its task) counts as active: `attach_stream` will abort that
/// task the moment it registers.
fn abort_stream(state: &ChatState, conversation_id: i64) -> Result<bool, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "chat state mutex poisoned".to_string())?;
    match guard.remove(&conversation_id.to_string()) {
        Some((_, Some(handle))) => {
            handle.abort();
            Ok(true)
        }
        Some((_, None)) => Ok(true),
        None => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Read a profile's inference key from the OS keychain (never rendered,
/// logged, or echoed — S4). Shared with the audio surfaces (`tts.rs` /
/// `stt.rs`, T6) so classification and keychain access stay identical.
pub(crate) fn read_profile_key(profile_id: &str) -> Result<String, ErrorKind> {
    match keyring::Entry::new(KEYRING_SERVICE, &profile::key_account(profile_id))
        .and_then(|entry| entry.get_password())
    {
        Ok(key) if !key.is_empty() => Ok(key),
        Ok(_) => Err(ErrorKind::MissingKey),
        Err(keyring::Error::NoEntry) => Err(ErrorKind::MissingKey),
        Err(_) => Err(ErrorKind::Protocol),
    }
}

/// Read a profile's login session JWT from the OS keychain (account
/// `<profile-id>.session`). Used for platform calls (web search, memory
/// sync). Missing, empty or unreadable → None: callers degrade silently.
/// Never rendered, logged or echoed (S4).
pub(crate) fn read_session_token(profile_id: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, &profile::session_account(profile_id))
        .and_then(|entry| entry.get_password())
        .ok()
        .filter(|token| !token.is_empty())
}

/// Send a user message into a conversation and stream the assistant reply.
///
/// Persisting happens here in the command (BEFORE the stream task starts):
/// the auto-title from the first user message and the user message row. The
/// assistant reply is persisted by the stream task as an `in_progress` row
/// that deltas overwrite as they arrive (T4b), finalized on a clean finish
/// or a deliberate stop and deleted on a classified error. Returns
/// immediately; progress arrives via `chat://delta`, `chat://done`,
/// `chat://error` and `chat://stopped` events.
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

/// Stop the active stream for a conversation (T4b stop button): abort the
/// stream task and finalize whatever text already arrived as a complete
/// message — a deliberate stop is not a failure, so no `chat://error` and
/// no interrupted marker. Emits `chat://stopped` when a stream was actually
/// stopped; stopping an idle conversation is a no-op.
#[tauri::command]
pub fn chat_stop(app: AppHandle, window: Window, conversation_id: i64) -> Result<(), String> {
    let state = app.state::<ChatState>();
    if !abort_stream(&state, conversation_id)? {
        return Ok(());
    }
    let dir = app.path().app_data_dir().map_err(|err| err.to_string())?;
    let conn = chat_store::open_db(&dir)?;
    chat_store::finalize_in_progress(&conn, conversation_id).map_err(|err| err.to_string())?;
    chat_store::touch_conversation(&conn, conversation_id).map_err(|err| err.to_string())?;
    let _ = window.emit("chat://stopped", DonePayload { conversation_id });
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
    let mut messages: Vec<serde_json::Value> =
        match chat_store::list_messages(&conn, conversation_id) {
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

    // ---- tools offered this reply ------------------------------------------
    // Web search is always offered (provider-invisible, silent when the
    // platform cannot serve it). File tools only exist when the user picked
    // a workspace; the system message tells the model where it may work.
    let workspace = tools::workspace_for(&app, &profile_id);
    if let Some(workspace) = &workspace {
        messages.insert(
            0,
            serde_json::json!({ "role": "system", "content": workspace_prompt(workspace) }),
        );
    }
    let mut offered_tools = tool_definitions(workspace.as_ref());

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

    // ---- model ↔ tool rounds -------------------------------------------------
    // The in-progress assistant row (T4b delta persistence) is created after
    // the FIRST 2xx (a rejected request persists nothing assistant-side) and
    // AFTER the history read above: interrupted leftovers stay part of the
    // request history as-is, while this row must not be. Text from every
    // round accumulates into that one row.
    let mut row_id: Option<i64> = None;
    let mut accumulated = String::new();
    let mut sources: Vec<WebSource> = Vec::new();
    let mut failed: Option<ErrorKind> = None;

    for round in 0..=MAX_TOOL_ROUNDS {
        // The last round offers no tools: the model must answer in text.
        let mut offer_tools = round < MAX_TOOL_ROUNDS && !offered_tools.is_empty();
        let no_tools: &[serde_json::Value] = &[];
        let body = request_body(
            &model,
            &messages,
            if offer_tools {
                offered_tools.as_slice()
            } else {
                no_tools
            },
        );
        let mut response = match post_completion(&client, &base, &key, &body).await {
            Ok(response) => response,
            Err(err) => {
                failed = Some(err);
                break;
            }
        };
        let mut status = response.status().as_u16();
        if status == 400 && offer_tools {
            // Silent degradation: a model/server without tool-calling
            // support rejects the `tools` field. Retry once without any
            // tools and never offer them again in this reply.
            offered_tools.clear();
            offer_tools = false;
            response =
                match post_completion(&client, &base, &key, &request_body(&model, &messages, &[]))
                    .await
                {
                    Ok(response) => response,
                    Err(err) => {
                        failed = Some(err);
                        break;
                    }
                };
            status = response.status().as_u16();
        }
        if !(200..300).contains(&status) {
            failed = Some(classify_chat_status(status));
            break;
        }
        let row = match row_id {
            Some(row) => row,
            None => {
                match chat_store::insert_in_progress_assistant(&conn, conversation_id, Some(&model))
                {
                    Ok(id) => {
                        row_id = Some(id);
                        id
                    }
                    Err(_) => {
                        failed = Some(ErrorKind::Protocol);
                        break;
                    }
                }
            }
        };

        let round_out = match stream_round(
            &window,
            &dir,
            conversation_id,
            row,
            response,
            &mut accumulated,
        )
        .await
        {
            Ok(round_out) => round_out,
            Err(kind) => {
                failed = Some(kind);
                break;
            }
        };
        if round_out.tool_calls.is_empty() || !offer_tools {
            break;
        }

        // ---- run the requested tools, feed results back -------------------
        let round_text = if round_out.text.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(round_out.text.clone())
        };
        let requested: Vec<serde_json::Value> = round_out
            .tool_calls
            .iter()
            .map(|call| {
                serde_json::json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments },
                })
            })
            .collect();
        messages.push(serde_json::json!({
            "role": "assistant",
            "content": round_text,
            "tool_calls": requested,
        }));
        for call in &round_out.tool_calls {
            let content = run_tool_call(
                &app,
                &window,
                &profile_id,
                conversation_id,
                call,
                &mut sources,
            )
            .await;
            messages.push(serde_json::json!({
                "role": "tool",
                "tool_call_id": call.id,
                "content": content,
            }));
        }
        let _ = window.emit(
            "chat://activity",
            ActivityPayload {
                conversation_id,
                activity: None,
            },
        );
    }

    // ---- persist + notify --------------------------------------------------
    match (failed, row_id) {
        (Some(kind), row) => {
            // A failed stream drops the partial text by design (unchanged
            // from T4): remove the in-progress row, then report the error.
            if let Some(row) = row {
                let _ = chat_store::delete_message(&conn, row);
            }
            emit_error(kind);
        }
        (None, Some(row)) => {
            // Clean finish: finalize the in-progress row in place with the
            // final accumulated text and its web sources (citation chips).
            let persisted = chat_store::finalize_message(&conn, row, &accumulated)
                .and_then(|_| {
                    if sources.is_empty() {
                        Ok(())
                    } else {
                        chat_store::set_message_sources(&conn, row, &sources)
                    }
                })
                .and_then(|_| chat_store::touch_conversation(&conn, conversation_id));
            match persisted {
                Ok(()) => {
                    let _ = window.emit("chat://done", DonePayload { conversation_id });
                }
                Err(_) => emit_error(ErrorKind::Protocol),
            }
        }
        (None, None) => emit_error(ErrorKind::Protocol),
    }
    release_stream(&state, conversation_id, generation);
}

/// `chat://activity` — what the assistant is doing between text deltas
/// (`searching` the web, `working` on files — waiting for the user's
/// approval) or `null` when it is writing again. Shown as a calm status
/// line; never technical detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ActivityPayload {
    pub conversation_id: i64,
    pub activity: Option<&'static str>,
}

/// POST one chat-completions request; transport failures are classified,
/// the status is left to the caller (it may retry a 400 without tools).
async fn post_completion(
    client: &reqwest::Client,
    base: &str,
    key: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, ErrorKind> {
    client
        .post(format!("{base}/chat/completions"))
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|err| classify_transport(err.is_timeout()))
}

/// What one streamed round produced.
struct RoundOutput {
    /// This round's text only (sent back with its tool calls).
    text: String,
    tool_calls: Vec<ToolCall>,
}

/// Stream one SSE reply: emit and persist text deltas into `row` (T4b:
/// flushed per network chunk), collect tool calls. Opens its own store
/// connection: a `&Connection` (not `Sync`) must not live across awaits of
/// a spawned task.
async fn stream_round(
    window: &Window,
    dir: &std::path::Path,
    conversation_id: i64,
    row: i64,
    response: reqwest::Response,
    accumulated: &mut String,
) -> Result<RoundOutput, ErrorKind> {
    use futures_util::StreamExt;

    let conn = chat_store::open_db(dir).map_err(|_| ErrorKind::Protocol)?;
    let mut stream = response.bytes_stream();
    let mut byte_buffer: Vec<u8> = Vec::new();
    let mut sse_buffer = String::new();
    let mut calls = ToolCallAccumulator::default();
    let mut text = String::new();
    let mut finished = false;

    // Text of a later round is separated from the earlier rounds' text.
    let push_delta = |delta: String, text: &mut String, accumulated: &mut String| {
        let delta = if text.is_empty() && !accumulated.is_empty() && !accumulated.ends_with('\n') {
            format!("\n\n{delta}")
        } else {
            delta
        };
        text.push_str(&delta);
        accumulated.push_str(&delta);
        let _ = window.emit(
            "chat://delta",
            DeltaPayload {
                conversation_id,
                delta,
            },
        );
    };

    while let Some(item) = stream.next().await {
        let bytes = item.map_err(|err| classify_transport(err.is_timeout()))?;
        byte_buffer.extend_from_slice(&bytes);
        sse_buffer.push_str(&decode_incremental(&mut byte_buffer));
        let mut pending_flush = false;
        for data in parse_sse_buffer(&mut sse_buffer) {
            if is_done_sentinel(&data) {
                finished = true;
                break;
            }
            calls.absorb(&data);
            if let DeltaOutcome::Delta(delta) = extract_delta(&data) {
                push_delta(delta, &mut text, &mut *accumulated);
                pending_flush = true;
            }
        }
        if pending_flush {
            // T4b: flush everything received so far BEFORE waiting for the
            // next chunk — a kill from here on keeps every byte that
            // reached the app.
            chat_store::update_message_content(&conn, row, accumulated)
                .map_err(|_| ErrorKind::Protocol)?;
        }
        if finished {
            break;
        }
    }
    if !finished {
        // Flush a stream that ended without a trailing blank line / [DONE].
        for data in flush_sse_buffer(&mut sse_buffer) {
            calls.absorb(&data);
            if let DeltaOutcome::Delta(delta) = extract_delta(&data) {
                push_delta(delta, &mut text, &mut *accumulated);
            }
        }
    }
    Ok(RoundOutput {
        text,
        tool_calls: calls.finish(),
    })
}

/// Run one model tool call and return the tool-message content. Web search
/// degrades silently; file actions go through the core's per-action native
/// approval (`tools::run_model_action`).
async fn run_tool_call(
    app: &AppHandle,
    window: &Window,
    profile_id: &str,
    conversation_id: i64,
    call: &ToolCall,
    sources: &mut Vec<WebSource>,
) -> String {
    let activity = if call.name == web_search::TOOL_NAME {
        "searching"
    } else {
        "working"
    };
    let _ = window.emit(
        "chat://activity",
        ActivityPayload {
            conversation_id,
            activity: Some(activity),
        },
    );
    if call.name == web_search::TOOL_NAME {
        let results = match web_search::parse_query(&call.arguments) {
            Some(query) => web_search::search(profile_id, &query).await,
            None => Vec::new(),
        };
        web_search::merge_sources(sources, &results);
        return web_search::results_for_model(&results);
    }
    match action_from_call(&call.name, &call.arguments) {
        Ok(action) => outcome_for_model(
            tools::run_model_action(app, profile_id, conversation_id, action).await,
        ),
        Err(message) => {
            serde_json::json!({ "ok": false, "error": "invalid_call", "message": message })
                .to_string()
        }
    }
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

    // ---- abort_stream (T4b stop button) ------------------------------------

    /// A stream task that never completes on its own: only an abort ends it.
    fn spawn_pending_task() -> tauri::async_runtime::JoinHandle<()> {
        tauri::async_runtime::spawn(async { std::future::pending::<()>().await })
    }

    #[test]
    fn abort_stream_aborts_the_attached_task_and_reports_presence() {
        let state = ChatState::default();
        let generation = reserve_stream(&state, 7).expect("reserve");
        let handle = spawn_pending_task();
        attach_stream(&state, 7, generation, handle).expect("attach");

        assert!(
            abort_stream(&state, 7).expect("abort"),
            "an active stream entry existed"
        );
        // The registry entry is gone: a second stop is a no-op `false`, and
        // the slot is fresh again for a new send (generations only need to
        // exceed the entry currently in the map — at most one per
        // conversation exists at any time).
        assert!(!abort_stream(&state, 7).expect("second abort"));
        assert_eq!(reserve_stream(&state, 7).expect("reserve again"), 1);
    }

    #[test]
    fn abort_stream_reports_absence_without_an_entry() {
        let state = ChatState::default();
        assert!(!abort_stream(&state, 4242).expect("abort"));
    }

    #[test]
    fn aborted_task_stops_at_its_next_await_point() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        /// Sets a flag when dropped — a tokio abort drops the task's future,
        /// so the flag proves the task really stopped.
        struct DropFlag(Arc<AtomicBool>);
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let state = ChatState::default();
        let generation = reserve_stream(&state, 9).expect("reserve");
        let dropped = Arc::new(AtomicBool::new(false));
        let started = Arc::new(AtomicBool::new(false));
        let dropped_in_task = dropped.clone();
        let started_in_task = started.clone();
        let handle = tauri::async_runtime::spawn(async move {
            started_in_task.store(true, Ordering::SeqCst);
            let _guard = DropFlag(dropped_in_task);
            // Blocked forever unless aborted.
            std::future::pending::<()>().await;
        });
        attach_stream(&state, 9, generation, handle).expect("attach");

        // Wait until the task actually started polling: aborting before the
        // first poll would cancel it correctly, but the guard (created inside
        // the body) would never have existed to drop.
        let started_by = std::time::Instant::now() + Duration::from_secs(5);
        while !started.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < started_by,
                "the spawned task never started"
            );
            std::thread::sleep(Duration::from_millis(10));
        }

        assert!(abort_stream(&state, 9).expect("abort"));

        // The aborted task's future is dropped promptly by the runtime; if
        // the abort had no effect the flag would never set.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !dropped.load(Ordering::SeqCst) {
            assert!(
                std::time::Instant::now() < deadline,
                "aborted task's future was never dropped — abort had no effect"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
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
            (ErrorKind::Decode, "decode"),
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

    // ---- tool calling ---------------------------------------------------------

    #[test]
    fn accumulator_rebuilds_streamed_tool_call_fragments() {
        let mut acc = ToolCallAccumulator::default();
        acc.absorb(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"web_search","arguments":""}}]}}]}"#);
        acc.absorb(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]}}]}"#);
        acc.absorb(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"clima\"}"}}]}}]}"#);
        acc.absorb(r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"read_file","arguments":"{}"}}]}}]}"#);
        acc.absorb(r#"{"choices":[{"delta":{"content":"plain text"}}]}"#);
        let calls = acc.finish();
        assert_eq!(
            calls,
            vec![
                ToolCall {
                    id: "call_a".into(),
                    name: "web_search".into(),
                    arguments: r#"{"query":"clima"}"#.into(),
                },
                ToolCall {
                    id: "call_1".into(),
                    name: "read_file".into(),
                    arguments: "{}".into(),
                },
            ]
        );
    }

    #[test]
    fn accumulator_ignores_noise_and_bounds_indices() {
        let mut acc = ToolCallAccumulator::default();
        acc.absorb("not json");
        acc.absorb(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":100000,"function":{"name":"x"}}]}}]}"#,
        );
        acc.absorb(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}"#,
        );
        assert!(
            acc.finish().is_empty(),
            "nameless and out-of-range calls dropped"
        );
    }

    #[test]
    fn web_search_is_always_offered_file_tools_only_with_a_workspace() {
        let names = |defs: Vec<serde_json::Value>| -> Vec<String> {
            defs.iter()
                .map(|d| {
                    d["function"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string()
                })
                .collect()
        };
        assert_eq!(names(tool_definitions(None)), vec!["web_search"]);
        let ws = tools::Workspace {
            roots: vec![std::path::PathBuf::from("/Users/me/Proyecto")],
            computer_wide: false,
            run_command: false,
        };
        assert_eq!(
            names(tool_definitions(Some(&ws))),
            vec![
                "web_search",
                "list_files",
                "read_file",
                "write_file",
                "replace_file"
            ]
        );
        let ws = tools::Workspace {
            run_command: true,
            ..ws
        };
        assert!(names(tool_definitions(Some(&ws))).contains(&"run_command".to_string()));
    }

    #[test]
    fn workspace_prompt_lists_folders_and_scope() {
        let ws = tools::Workspace {
            roots: vec![std::path::PathBuf::from("/Users/me/Proyecto")],
            computer_wide: false,
            run_command: false,
        };
        let prompt = workspace_prompt(&ws);
        assert!(prompt.contains("/Users/me/Proyecto"));
        assert!(prompt.contains("only work inside"));
        let wide = workspace_prompt(&tools::Workspace {
            computer_wide: true,
            ..ws
        });
        assert!(wide.contains("whole user folder"));
    }

    #[test]
    fn request_body_adds_tools_only_when_offered() {
        let messages = vec![serde_json::json!({"role":"user","content":"hola"})];
        let plain = request_body("m", &messages, &[]);
        assert!(plain.get("tools").is_none());
        assert!(plain.get("tool_choice").is_none());
        assert_eq!(plain["stream"], true);
        let with = request_body("m", &messages, &tool_definitions(None));
        assert_eq!(with["tools"][0]["function"]["name"], "web_search");
        assert_eq!(with["tool_choice"], "auto");
    }

    #[test]
    fn model_calls_map_onto_core_actions() {
        assert_eq!(
            action_from_call("read_file", r#"{"path":"/a/b.txt"}"#),
            Ok(tools::ToolAction::ReadFile {
                path: "/a/b.txt".into()
            })
        );
        assert_eq!(
            action_from_call("run_command", r#"{"cmd":"ls","cwd":"/a"}"#),
            Ok(tools::ToolAction::RunCommand {
                cmd: "ls".into(),
                cwd_in_grant: "/a".into()
            })
        );
        assert!(action_from_call("delete_everything", r#"{"path":"/"}"#).is_err());
        assert!(action_from_call("read_file", "not json").is_err());
        // A model cannot smuggle a different action kind through arguments.
        assert_eq!(
            action_from_call(
                "read_file",
                r#"{"type":"write_file","path":"/a","content":"x"}"#
            ),
            Ok(tools::ToolAction::ReadFile { path: "/a".into() })
        );
    }

    #[test]
    fn tool_outcomes_are_capped_and_declines_say_do_not_retry() {
        let big = "x".repeat(MAX_TOOL_RESULT_CHARS + 10);
        let text = outcome_for_model(Ok(tools::ToolOutcome {
            action: "read_file".into(),
            summary: "read".into(),
            content: Some(big),
            ..Default::default()
        }));
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert!(
            value["content"]
                .as_str()
                .expect("content")
                .ends_with("(truncated)")
        );
        let declined = outcome_for_model(Err(tools::Rejection::new("declined", "no")));
        assert!(declined.contains("Do not retry"));
        let rejected = outcome_for_model(Err(tools::Rejection::new("escape", "outside")));
        assert!(rejected.contains("\"error\":\"escape\""));
    }

    #[test]
    fn default_model_is_the_headliner() {
        assert_eq!(DEFAULT_MODEL, "deepseek-v4-flash");
        let filtered = filter_chat_models(full_catalog());
        assert_eq!(filtered[0], DEFAULT_MODEL);
    }
}
