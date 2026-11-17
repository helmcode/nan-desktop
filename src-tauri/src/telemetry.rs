//! Technical usage and error telemetry (owner decision 2026-11-17: always on,
//! not user-disableable).
//!
//! What it is: a handful of fixed events (`app_start`, `turn_end`,
//! `tool_call`, `error_shown`, `crash`) whose properties are built ONLY from
//! enums, counters, durations and ids drawn from fixed sets. It never
//! carries user content: no message text, prompts, file names, paths, URLs,
//! command lines, search queries, emails, nor free-form error or panic
//! messages. Every builder below is pinned by tests against the backend's
//! validation rules and against content canaries.
//!
//! Where it goes ("locked endpoints", S8): ONLY to the signed-in profile's
//! compiled-in platform base + [`API_PATH`] (the same host the memory sync
//! already talks to), authenticated with the login session JWT exactly like
//! `memory::RemoteMemory`. The JWT never leaves this core and the renderer
//! never talks to the network for telemetry: it can only report a renderer
//! crash NAME through [`telemetry_renderer_crash`], validated here.
//!
//! Tenancy: every event is tagged with the profile (and bound user realm)
//! it was produced under and is only ever sent to THAT profile's platform
//! with that profile's session. Install-level events recorded while no
//! profile is active (an `app_start` before the first sign-in, a crash on
//! the login screen) carry no tenant data and go with the active profile's
//! next flush.
//!
//! Delivery: a bounded on-disk queue (`telemetry/queue.jsonl` in the app
//! data dir, [`QUEUE_CAP`] events, oldest dropped first, events older than
//! [`MAX_EVENT_AGE_SECS`] pruned) flushed in batches of at most
//! [`BATCH_MAX`] every [`FLUSH_INTERVAL`], as soon as [`FLUSH_THRESHOLD`]
//! events are queued, and best-effort on exit. Network failures, 5xx, 408
//! and 429 back off exponentially (up to [`BACKOFF_MAX`]); a 400/413 drops
//! that batch (it can never be accepted); 401/403/404 keep the events
//! queued and stop sending for that profile until the app restarts (silent
//! degradation, like the memory sync). Without a session nothing is sent:
//! events wait in the queue.
//!
//! Crashes: a Rust panic hook appends a `crash` event with ONLY the panic
//! location (`file:line`, build paths shortened) to `telemetry/crash.jsonl`
//! synchronously, without taking any lock, before the process aborts
//! (release builds use `panic = "abort"`); the next launch merges it into
//! the queue.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::profile;
use crate::turn::TurnSummary;

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/// API path (relative to the profile's platform base).
pub const API_PATH: &str = "/api/desktop/telemetry";
/// Folder inside the app data dir.
pub const DIR: &str = "telemetry";
const QUEUE_FILE: &str = "queue.jsonl";
/// Written by the panic hook, merged into the queue on the next launch.
const CRASH_FILE: &str = "crash.jsonl";
const INSTALL_FILE: &str = "install_id";
/// The daily volume guard's counter (`{"day": "YYYY-MM-DD", "count": n}`).
const DAILY_FILE: &str = "daily.json";
/// Most events kept on disk; the oldest are dropped first.
pub const QUEUE_CAP: usize = 1000;
/// Most events per request (the backends accept 1..=100).
pub const BATCH_MAX: usize = 100;
/// Queue length that triggers an early flush.
pub const FLUSH_THRESHOLD: usize = 50;
/// Regular flush period.
pub const FLUSH_INTERVAL: Duration = Duration::from_secs(60);
/// First flush after launch (lets startup finish first).
pub const FIRST_FLUSH_DELAY: Duration = Duration::from_secs(15);
/// Longest back-off after repeated network/5xx/429 failures.
pub const BACKOFF_MAX: Duration = Duration::from_secs(15 * 60);
/// Budget of the best-effort flush on exit.
pub const EXIT_FLUSH_TIMEOUT: Duration = Duration::from_secs(3);
/// Queued events older than this are pruned (the backends clamp older
/// client timestamps anyway).
pub const MAX_EVENT_AGE_SECS: u64 = 30 * 24 * 60 * 60;
/// Renderer crash reports accepted per app session (a crash loop must not
/// flood the queue).
pub const RENDERER_CRASH_CAP: u32 = 20;
/// Most events recorded per UTC day on this install (a guard far below the
/// backends' 20,000 per account per 24 h; a normal day is hundreds to low
/// thousands). Events past it are not recorded. A Rust panic's `crash`
/// bypasses it (written by the panic hook, at most one per launch).
pub const DAILY_EVENT_CAP: u32 = 5000;
/// Most `tool_call` events per turn: the rest of a long turn is only
/// counted in its `turn_end.tool_calls`.
pub const TOOL_CALL_EVENTS_PER_TURN: usize = 20;
/// Request body limit of the backends (413 above it).
pub const MAX_BODY_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Backend limits (mirrored so a batch is never rejected for its shape).
pub const MAX_PROP_KEYS: usize = 32;
pub const MAX_PROP_STRING_CHARS: usize = 128;

// ---------------------------------------------------------------------------
// Validation (mirror of the backends' rules)
// ---------------------------------------------------------------------------

/// `^[a-z][a-z0-9_]{0,63}$`: event names and prop keys.
pub fn valid_name(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some('a'..='z'))
        && text.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// `^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$`.
pub fn valid_app_version(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && text.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '_' | '-'))
}

/// `^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$`.
pub fn valid_arch(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && text.len() <= 32
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// A flat props object the backends accept: <= 32 keys matching
/// [`valid_name`], values string (<= 128 chars), number, bool or null.
pub fn valid_props(props: &Map<String, Value>) -> bool {
    props.len() <= MAX_PROP_KEYS
        && props.iter().all(|(key, value)| {
            valid_name(key)
                && match value {
                    Value::String(text) => text.chars().count() <= MAX_PROP_STRING_CHARS,
                    Value::Number(_) | Value::Bool(_) | Value::Null => true,
                    Value::Array(_) | Value::Object(_) => false,
                }
        })
}

/// Keep only `[0-9A-Za-z._ -]`, trimmed, at most 64 chars (the backends
/// accept any printable text up to 64; this is stricter on purpose).
pub fn sanitize_os_version(raw: &str) -> String {
    let kept: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ' ' | '-'))
        .collect();
    kept.trim().chars().take(64).collect()
}

// ---------------------------------------------------------------------------
// Fixed vocabularies
// ---------------------------------------------------------------------------

/// Every tool the app offers the model (the fixed registry in `chat.rs`).
/// Any other name the model invents is reported as `unknown`.
pub const TOOL_NAMES: &[&str] = &[
    crate::web_search::TOOL_NAME,
    crate::images::TOOL_NAME,
    crate::tools::save_skill::TOOL_NAME,
    crate::tools::website::TOOL_NAME,
    "list_files",
    "read_file",
    "write_file",
    "replace_file",
    "move_path",
    "delete_path",
    "run_command",
];

/// The registry name for `name`, or `unknown`.
pub fn tool_name(name: &str) -> &'static str {
    TOOL_NAMES
        .iter()
        .find(|known| **known == name)
        .copied()
        .unwrap_or("unknown")
}

/// A model id from the app's compiled-in chat-model allowlist
/// (`chat-models.json`); anything else is `other`. The id comes from the
/// renderer's picker, so it is never trusted as-is: only ids from that fixed
/// set (which also satisfy `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`) are reported.
pub fn model_id(raw: &str) -> String {
    let mut chars = raw.chars();
    let shaped = matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && raw.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    let known = crate::chat::chat_models_config()
        .models
        .iter()
        .any(|model| model == raw);
    if shaped && known {
        raw.to_string()
    } else {
        "other".to_string()
    }
}

/// The snake_case spelling of a classified error-kind enum, or `other`.
/// Only unit variants of the app's own `ErrorKind` enums are passed in; the
/// [`valid_name`] check guarantees nothing else can slip through.
pub fn kind_str<K: Serialize>(kind: &K) -> String {
    match serde_json::to_value(kind) {
        Ok(Value::String(text)) if valid_name(&text) => text,
        _ => "other".to_string(),
    }
}

/// How one tool execution ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolOutcome {
    Ok,
    Error,
    Timeout,
    Denied,
}

impl ToolOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Timeout => "timeout",
            Self::Denied => "denied",
        }
    }
}

/// Classify a tool result (the JSON fed back to the model) WITHOUT keeping
/// any of it: `{"ok": false, "error": "declined"}` is `denied`, any other
/// `ok: false` is `error`, `timed_out: true` is `timeout`, anything else
/// (including web search's result list) is `ok`.
pub fn tool_outcome_from_result(content: &str) -> ToolOutcome {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(content) else {
        return ToolOutcome::Ok;
    };
    if map.get("ok") == Some(&Value::Bool(false)) {
        return if map.get("error").and_then(Value::as_str) == Some("declined") {
            ToolOutcome::Denied
        } else {
            ToolOutcome::Error
        };
    }
    if map.get("timed_out") == Some(&Value::Bool(true)) {
        return ToolOutcome::Timeout;
    }
    ToolOutcome::Ok
}

/// Where a classified error was shown (or, for `memory`, silently absorbed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Chat,
    Images,
    SignIn,
    Memory,
}

impl Surface {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Images => "images",
            Self::SignIn => "sign_in",
            Self::Memory => "memory",
        }
    }
}

// ---------------------------------------------------------------------------
// Event builders (the complete catalogue)
// ---------------------------------------------------------------------------

/// An event before it is stamped with an id, time and session.
#[derive(Debug, Clone, PartialEq)]
pub struct EventSpec {
    pub name: &'static str,
    pub props: Map<String, Value>,
}

fn spec(name: &'static str, props: Value) -> EventSpec {
    let props = match props {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    EventSpec { name, props }
}

/// `app_start {}`.
pub fn app_start() -> EventSpec {
    spec("app_start", Value::Object(Map::new()))
}

/// `turn_end` from the single turn summary (`turn::report_turn`).
pub fn turn_end(summary: &TurnSummary) -> EventSpec {
    spec(
        "turn_end",
        serde_json::json!({
            "reason": summary.reason.as_str(),
            "error_kind": summary.error_kind.as_ref().map(kind_str),
            "rounds": summary.rounds,
            "tool_calls": summary.tool_calls,
            "duration_ms": summary.duration_ms,
            "model": model_id(&summary.model),
            "continued": summary.continued,
        }),
    )
}

/// `tool_call`: registry name, outcome, duration. Never the arguments or
/// the result.
pub fn tool_call(name: &str, outcome: ToolOutcome, duration_ms: u64) -> EventSpec {
    spec(
        "tool_call",
        serde_json::json!({
            "tool": tool_name(name),
            "outcome": outcome.as_str(),
            "duration_ms": duration_ms,
        }),
    )
}

/// `error_shown`: the surface and the classified kind (an `ErrorKind`
/// enum variant), never a message.
pub fn error_shown<K: Serialize>(surface: Surface, kind: &K) -> EventSpec {
    spec(
        "error_shown",
        serde_json::json!({ "surface": surface.as_str(), "kind": kind_str(kind) }),
    )
}

/// The panic location as `file:line`, without build-machine prefixes:
/// absolute paths (a dependency in the cargo registry, the std library)
/// keep their last 3 components; only `[A-Za-z0-9._/-]` survive.
pub fn panic_location(file: &str, line: u32) -> String {
    let normalized = file.replace('\\', "/");
    let absolute = normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.split('/').any(|part| part == "..");
    let short = if absolute {
        let parts: Vec<&str> = normalized
            .split('/')
            .filter(|p| !p.is_empty() && *p != "." && *p != "..")
            .collect();
        parts[parts.len().saturating_sub(3)..].join("/")
    } else {
        normalized
    };
    let clean: String = short
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        .collect();
    let suffix = format!(":{line}");
    let room = MAX_PROP_STRING_CHARS - suffix.len();
    let start = clean.len().saturating_sub(room);
    format!("{}{suffix}", &clean[start..])
}

/// `crash` from a Rust panic: the location only, never the message.
pub fn crash_rust(file: &str, line: u32) -> EventSpec {
    spec(
        "crash",
        serde_json::json!({ "source": "rust_panic", "location": panic_location(file, line) }),
    )
}

/// A renderer error NAME (`TypeError`, ...): `^[A-Za-z][A-Za-z0-9_]{0,63}$`,
/// anything else becomes `Error`.
pub fn renderer_error_name(raw: &str) -> String {
    let mut chars = raw.chars();
    let ok = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic())
        && raw.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok {
        raw.to_string()
    } else {
        "Error".to_string()
    }
}

/// `crash` from the renderer: the error name only.
pub fn crash_renderer(name: &str) -> EventSpec {
    spec(
        "crash",
        serde_json::json!({ "source": "renderer", "location": renderer_error_name(name) }),
    )
}

// ---------------------------------------------------------------------------
// Wire + queue records
// ---------------------------------------------------------------------------

/// One event as sent (contract v1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub name: String,
    pub ts: String,
    pub session_id: String,
    #[serde(default)]
    pub props: Map<String, Value>,
}

/// One queued event: which profile (and bound user realm) produced it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Queued {
    #[serde(default)]
    pub profile: Option<String>,
    #[serde(default)]
    pub realm: Option<String>,
    /// Unix seconds when it was queued (age pruning).
    #[serde(default)]
    pub at: u64,
    pub event: Event,
}

impl Queued {
    /// Whether the event may be sent with `profile`'s session (bound user
    /// `realm`). Events of another profile never match; events of another
    /// user of the same profile never match; untagged install-level events
    /// match only the ACTIVE profile.
    pub fn belongs_to(&self, profile: &str, realm: &str, active: bool) -> bool {
        match (&self.profile, &self.realm) {
            (Some(p), Some(r)) => p == profile && r == realm,
            (Some(p), None) => p == profile,
            (None, _) => active,
        }
    }

    /// A record read back from disk is only kept when it still satisfies
    /// the contract (a hand-edited queue never poisons a batch).
    fn is_well_formed(&self) -> bool {
        valid_name(&self.event.name)
            && valid_props(&self.event.props)
            && is_uuid(&self.event.id)
            && is_uuid(&self.event.session_id)
            && self
                .profile
                .as_deref()
                .is_none_or(profile::is_known_profile_id)
    }
}

fn is_uuid(text: &str) -> bool {
    uuid::Uuid::parse_str(text).is_ok_and(|id| !id.is_nil())
}

/// Per-install facts sent with every batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Meta {
    pub install_id: String,
    pub app_version: String,
    pub os: String,
    pub os_version: String,
    pub arch: String,
}

impl Meta {
    /// Build from raw facts, coercing each to what the backends accept.
    pub fn new(install_id: &str, app_version: &str, os_version: &str) -> Self {
        let os = match std::env::consts::OS {
            "macos" => "macos",
            "windows" => "windows",
            _ => "linux",
        };
        let arch = std::env::consts::ARCH;
        Meta {
            install_id: install_id.to_string(),
            app_version: if valid_app_version(app_version) {
                app_version.to_string()
            } else {
                "0.0.0".to_string()
            },
            os: os.to_string(),
            os_version: sanitize_os_version(os_version),
            arch: if valid_arch(arch) { arch } else { "unknown" }.to_string(),
        }
    }
}

/// The request body for one batch.
pub fn batch_body(meta: &Meta, events: &[Event]) -> Value {
    serde_json::json!({
        "install_id": meta.install_id,
        "app_version": meta.app_version,
        "os": meta.os,
        "os_version": meta.os_version,
        "arch": meta.arch,
        "events": events,
    })
}

/// Stamp a spec into an event.
pub fn stamp(spec: EventSpec, session_id: &str, now: SystemTime) -> Event {
    Event {
        id: uuid::Uuid::new_v4().to_string(),
        name: spec.name.to_string(),
        ts: rfc3339(now),
        session_id: session_id.to_string(),
        props: spec.props,
    }
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC) without a date crate.
pub fn rfc3339(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs();
    let millis = since.subsec_millis();
    let days = i64::try_from(secs / 86_400).unwrap_or(0);
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// On-disk queue
// ---------------------------------------------------------------------------

/// The bounded queue: an in-memory mirror of `queue.jsonl`. Appends are
/// O(1) on disk; trimming and removals rewrite the file atomically.
#[derive(Debug)]
pub struct Queue {
    dir: PathBuf,
    items: Vec<Queued>,
}

impl Queue {
    /// Load the queue (malformed lines skipped), merge the crash file a
    /// panic left behind, prune old events and trim to the cap.
    pub fn open(dir: &Path, now_unix: u64) -> Self {
        let _ = std::fs::create_dir_all(dir);
        let mut items = read_lines(&dir.join(QUEUE_FILE));
        let crash_path = dir.join(CRASH_FILE);
        let crashes = read_lines(&crash_path);
        let merged = !crashes.is_empty();
        items.extend(crashes);
        let mut queue = Queue {
            dir: dir.to_path_buf(),
            items,
        };
        let before = queue.items.len();
        queue.prune(now_unix);
        if merged || queue.items.len() != before {
            queue.rewrite();
        }
        if merged {
            let _ = std::fs::remove_file(crash_path);
        }
        queue
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    #[cfg(test)]
    pub fn items(&self) -> &[Queued] {
        &self.items
    }

    fn prune(&mut self, now_unix: u64) {
        self.items
            .retain(|item| now_unix.saturating_sub(item.at) <= MAX_EVENT_AGE_SECS);
        if self.items.len() > QUEUE_CAP {
            let excess = self.items.len() - QUEUE_CAP;
            self.items.drain(..excess);
        }
    }

    /// Append one event (dropping the oldest beyond the cap). Returns the
    /// new length.
    pub fn push(&mut self, item: Queued) -> usize {
        let line = serde_json::to_string(&item).ok();
        self.items.push(item);
        if self.items.len() > QUEUE_CAP {
            self.prune(unix_now());
            self.rewrite();
        } else if let Some(line) = line {
            let appended = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.dir.join(QUEUE_FILE))
                .and_then(|mut file| writeln!(file, "{line}"));
            if appended.is_err() {
                self.rewrite();
            }
        }
        self.items.len()
    }

    /// Up to `max` events (oldest first) that `profile`/`realm` may send.
    pub fn select(&self, profile: &str, realm: &str, active: bool, max: usize) -> Vec<Event> {
        self.items
            .iter()
            .filter(|item| item.belongs_to(profile, realm, active))
            .take(max)
            .map(|item| item.event.clone())
            .collect()
    }

    /// Remove events by id (sent, or dropped as unacceptable).
    pub fn remove(&mut self, ids: &HashSet<String>) {
        let before = self.items.len();
        self.items.retain(|item| !ids.contains(&item.event.id));
        if self.items.len() != before {
            self.rewrite();
        }
    }

    fn rewrite(&self) {
        let mut text = String::new();
        for item in &self.items {
            if let Ok(line) = serde_json::to_string(item) {
                text.push_str(&line);
                text.push('\n');
            }
        }
        let tmp = self.dir.join(format!("{QUEUE_FILE}.tmp"));
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, self.dir.join(QUEUE_FILE));
        }
    }
}

fn read_lines(path: &Path) -> Vec<Queued> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Queued>(line).ok())
        .filter(Queued::is_well_formed)
        .collect()
}

/// The persisted install id (uuid v4), created on first use. A missing,
/// unreadable or malformed file gets a fresh id.
pub fn load_install_id(dir: &Path) -> String {
    let path = dir.join(INSTALL_FILE);
    if let Ok(raw) = std::fs::read_to_string(&path)
        && is_uuid(raw.trim())
    {
        return raw.trim().to_string();
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&path, &id);
    id
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/// What to do with a batch after one attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Accepted (202): remove it.
    Sent,
    /// Can never be accepted (400/413/other 4xx): remove it.
    Drop,
    /// Transient (network, timeout, 408, 429, 5xx): keep it, back off.
    Retry,
    /// The session or API is not usable (401/403/404): keep it, stop
    /// sending for this profile until the app restarts.
    Block,
}

pub fn classify_status(status: u16) -> Disposition {
    match status {
        200..=299 => Disposition::Sent,
        401 | 403 | 404 => Disposition::Block,
        408 | 429 => Disposition::Retry,
        500..=599 => Disposition::Retry,
        _ => Disposition::Drop,
    }
}

/// POST one batch. The body is never logged.
pub async fn post_batch(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    body: &Value,
) -> Disposition {
    let url = format!("{}{API_PATH}", base.trim_end_matches('/'));
    match client.post(url).bearer_auth(token).json(body).send().await {
        Ok(response) => classify_status(response.status().as_u16()),
        Err(_) => Disposition::Retry,
    }
}

/// The largest prefix of `events` whose body fits [`MAX_BODY_BYTES`].
pub fn fit_batch(meta: &Meta, mut events: Vec<Event>) -> (Value, Vec<Event>) {
    loop {
        let body = batch_body(meta, &events);
        let size = serde_json::to_vec(&body).map(|b| b.len()).unwrap_or(0);
        if size <= MAX_BODY_BYTES || events.len() <= 1 {
            return (body, events);
        }
        events.truncate(events.len() / 2);
    }
}

/// Send everything `profile` may send, batch by batch, until the queue has
/// nothing left for it or an attempt fails. Returns the last disposition
/// (`None` when there was nothing to send).
pub async fn flush_profile(
    queue: &Mutex<Queue>,
    meta: &Meta,
    client: &reqwest::Client,
    target: &FlushTarget,
) -> Option<Disposition> {
    let mut last = None;
    loop {
        let batch = match queue.lock() {
            Ok(queue) => queue.select(&target.profile, &target.realm, target.active, BATCH_MAX),
            Err(_) => return last,
        };
        if batch.is_empty() {
            return last;
        }
        let (body, batch) = fit_batch(meta, batch);
        let outcome = post_batch(client, &target.base, &target.token, &body).await;
        last = Some(outcome);
        match outcome {
            Disposition::Sent | Disposition::Drop => {
                let ids: HashSet<String> = batch.into_iter().map(|e| e.id).collect();
                if let Ok(mut queue) = queue.lock() {
                    queue.remove(&ids);
                }
            }
            Disposition::Retry | Disposition::Block => return last,
        }
    }
}

/// Where and as whom one profile flushes. The token never leaves the core.
pub struct FlushTarget {
    pub profile: String,
    pub realm: String,
    pub active: bool,
    pub base: String,
    pub token: String,
}

/// The per-day volume guard ([`DAILY_EVENT_CAP`]), persisted so a restart
/// does not reset it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DailyCap {
    pub day: String,
    pub count: u32,
}

impl DailyCap {
    /// Admit one more event on `day` (`YYYY-MM-DD`, UTC); a new day starts
    /// a new count.
    pub fn admit(&mut self, day: &str) -> bool {
        if self.day != day {
            self.day = day.to_string();
            self.count = 0;
        }
        if self.count >= DAILY_EVENT_CAP {
            return false;
        }
        self.count += 1;
        true
    }

    fn load(dir: &Path) -> Self {
        std::fs::read_to_string(dir.join(DAILY_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save(&self, dir: &Path) {
        if let Ok(json) = serde_json::to_string(self) {
            let _ = std::fs::write(dir.join(DAILY_FILE), json);
        }
    }
}

/// Exponential back-off per profile.
#[derive(Debug, Default)]
struct Backoff {
    until: std::collections::HashMap<String, (Instant, Duration)>,
}

impl Backoff {
    fn ready(&self, profile: &str, now: Instant) -> bool {
        self.until.get(profile).is_none_or(|(at, _)| now >= *at)
    }

    fn fail(&mut self, profile: &str, now: Instant) {
        let next = self
            .until
            .get(profile)
            .map(|(_, delay)| (*delay * 2).min(BACKOFF_MAX))
            .unwrap_or(FLUSH_INTERVAL);
        self.until.insert(profile.to_string(), (now + next, next));
    }

    fn reset(&mut self, profile: &str) {
        self.until.remove(profile);
    }
}

// ---------------------------------------------------------------------------
// Process-wide runtime
// ---------------------------------------------------------------------------

struct Runtime {
    root: PathBuf,
    dir: PathBuf,
    session_id: String,
    install_id: String,
    app_version: String,
    os_version: OnceLock<String>,
    queue: Mutex<Queue>,
    blocked: Mutex<HashSet<String>>,
    backoff: Mutex<Backoff>,
    wake: tokio::sync::Notify,
    flushing: tokio::sync::Mutex<()>,
    renderer_crashes: AtomicU32,
    daily: Mutex<DailyCap>,
    client: Option<reqwest::Client>,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

impl Runtime {
    fn meta(&self) -> Meta {
        Meta::new(
            &self.install_id,
            &self.app_version,
            self.os_version.get().map(String::as_str).unwrap_or(""),
        )
    }
}

fn read_store(root: &Path) -> Option<profile::ProfileStore> {
    let raw = std::fs::read_to_string(root.join(profile::STORE_FILE)).ok()?;
    profile::parse_store(&raw)
}

/// The tag of an event produced under `profile` (or, for install-level
/// events, under whichever profile is active). `None` = drop: a profile id
/// that is not one of the two locked ones.
fn tag(root: &Path, profile: Option<&str>) -> Option<(Option<String>, Option<String>)> {
    let store = read_store(root);
    match profile {
        Some(id) if profile::is_known_profile_id(id) => Some((
            Some(id.to_string()),
            store
                .as_ref()
                .and_then(|s| s.binding(id))
                .map(|user| user.realm.clone()),
        )),
        Some(_) => None,
        None => Some(
            store
                .as_ref()
                .and_then(|s| s.active_binding())
                .map(|(id, user)| (Some(id.to_string()), Some(user.realm.clone())))
                .unwrap_or((None, None)),
        ),
    }
}

/// Start telemetry: install id, session id, queue (with last launch's
/// crash), panic hook and the `app_start` event. Called once from `setup`.
pub fn init(root: &Path, app_version: &str) {
    let dir = root.join(DIR);
    let daily = DailyCap::load(&dir);
    let runtime = Runtime {
        root: root.to_path_buf(),
        install_id: load_install_id(&dir),
        queue: Mutex::new(Queue::open(&dir, unix_now())),
        dir,
        session_id: uuid::Uuid::new_v4().to_string(),
        app_version: app_version.to_string(),
        os_version: OnceLock::new(),
        blocked: Mutex::new(HashSet::new()),
        backoff: Mutex::new(Backoff::default()),
        wake: tokio::sync::Notify::new(),
        flushing: tokio::sync::Mutex::new(()),
        renderer_crashes: AtomicU32::new(0),
        daily: Mutex::new(daily),
        client: reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            .ok(),
    };
    if RUNTIME.set(runtime).is_err() {
        return;
    }
    install_panic_hook();
    record(None, app_start());
}

/// Queue one event produced under `profile` (`None` = install-level).
/// A no-op before [`init`] (unit tests) and never fails.
pub fn record(profile: Option<&str>, spec: EventSpec) {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    if !valid_name(spec.name) || !valid_props(&spec.props) {
        return;
    }
    let Some((profile, realm)) = tag(&runtime.root, profile) else {
        return;
    };
    let now = SystemTime::now();
    let admitted = match runtime.daily.lock() {
        Ok(mut daily) => {
            let admitted = daily.admit(&rfc3339(now)[..10]);
            if admitted {
                daily.save(&runtime.dir);
            }
            admitted
        }
        Err(_) => false,
    };
    if !admitted {
        return;
    }
    let item = Queued {
        profile,
        realm,
        at: unix_now(),
        event: stamp(spec, &runtime.session_id, SystemTime::now()),
    };
    let len = match runtime.queue.lock() {
        Ok(mut queue) => queue.push(item),
        Err(_) => return,
    };
    if len >= FLUSH_THRESHOLD {
        runtime.wake.notify_one();
    }
}

thread_local! {
    static IN_HOOK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
static HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Chain a panic hook that persists `crash {source: rust_panic, location}`
/// synchronously (append to `crash.jsonl`, no lock taken), then runs the
/// previous hook. The panic MESSAGE is never read.
fn install_panic_hook() {
    if HOOK_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let reentrant = IN_HOOK.with(|flag| flag.replace(true));
        if !reentrant {
            if let (Some(runtime), Some(location)) = (RUNTIME.get(), info.location()) {
                persist_crash(runtime, crash_rust(location.file(), location.line()));
            }
            IN_HOOK.with(|flag| flag.set(false));
        }
        previous(info);
    }));
}

fn persist_crash(runtime: &Runtime, spec: EventSpec) {
    let (profile, realm) = tag(&runtime.root, None).unwrap_or((None, None));
    let item = Queued {
        profile,
        realm,
        at: unix_now(),
        event: stamp(spec, &runtime.session_id, SystemTime::now()),
    };
    if let Ok(line) = serde_json::to_string(&item) {
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(runtime.dir.join(CRASH_FILE))
            .and_then(|mut file| writeln!(file, "{line}"));
    }
}

/// Flush every signed-in profile once (serialized with other flushes).
async fn flush_all() {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    let Some(client) = runtime.client.as_ref() else {
        return;
    };
    let _guard = runtime.flushing.lock().await;
    let store = read_store(&runtime.root);
    let active = store.as_ref().and_then(|s| s.active_profile.clone());
    let meta = runtime.meta();
    for profile in profile::canonical_profiles() {
        let id = profile.id;
        let blocked = runtime
            .blocked
            .lock()
            .map(|set| set.contains(&id))
            .unwrap_or(true);
        let ready = runtime
            .backoff
            .lock()
            .map(|b| b.ready(&id, Instant::now()))
            .unwrap_or(false);
        if blocked || !ready {
            continue;
        }
        let Some(realm) = store
            .as_ref()
            .and_then(|s| s.binding(&id))
            .map(|user| user.realm.clone())
        else {
            continue;
        };
        let (Some(base), Some(token)) = (
            crate::device_flow::platform_base(&id),
            crate::chat::read_session_token(&id),
        ) else {
            continue;
        };
        let target = FlushTarget {
            active: active.as_deref() == Some(id.as_str()),
            profile: id.clone(),
            realm,
            base,
            token,
        };
        match flush_profile(&runtime.queue, &meta, client, &target).await {
            Some(Disposition::Retry) => {
                if let Ok(mut backoff) = runtime.backoff.lock() {
                    backoff.fail(&id, Instant::now());
                }
            }
            Some(Disposition::Block) => {
                if let Ok(mut blocked) = runtime.blocked.lock() {
                    blocked.insert(id);
                }
            }
            Some(_) => {
                if let Ok(mut backoff) = runtime.backoff.lock() {
                    backoff.reset(&id);
                }
            }
            None => {}
        }
    }
}

/// The background flusher: first flush shortly after launch, then every
/// [`FLUSH_INTERVAL`] or as soon as [`FLUSH_THRESHOLD`] events are queued.
pub fn spawn_flusher() {
    if RUNTIME.get().is_none() {
        return;
    }
    // The OS version needs a file read (or, on Windows, `cmd /C ver`):
    // resolved off the startup path.
    std::thread::spawn(|| {
        if let Some(runtime) = RUNTIME.get() {
            let _ = runtime.os_version.set(detect_os_version());
        }
    });
    tauri::async_runtime::spawn(async {
        let Some(runtime) = RUNTIME.get() else {
            return;
        };
        let _ = tokio::time::timeout(FIRST_FLUSH_DELAY, runtime.wake.notified()).await;
        loop {
            flush_all().await;
            let _ = tokio::time::timeout(FLUSH_INTERVAL, runtime.wake.notified()).await;
        }
    });
}

/// Best-effort flush when the app exits, bounded by [`EXIT_FLUSH_TIMEOUT`].
pub fn flush_on_exit() {
    if RUNTIME.get().is_none() {
        return;
    }
    tauri::async_runtime::block_on(async {
        let _ = tokio::time::timeout(EXIT_FLUSH_TIMEOUT, flush_all()).await;
    });
}

/// The OS version string (`15.1`, `ubuntu 22.04`, `10.0.22631`), sanitized.
fn detect_os_version() -> String {
    #[cfg(target_os = "macos")]
    let raw = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist")
        .ok()
        .and_then(|plist| plist_string(&plist, "ProductVersion"))
        .unwrap_or_default();
    #[cfg(target_os = "linux")]
    let raw = std::fs::read_to_string("/etc/os-release")
        .ok()
        .map(|text| {
            let field = |key: &str| {
                text.lines()
                    .find_map(|line| line.strip_prefix(&format!("{key}=")))
                    .map(|v| v.trim_matches('"').to_string())
                    .unwrap_or_default()
            };
            format!("{} {}", field("ID"), field("VERSION_ID"))
        })
        .unwrap_or_default();
    #[cfg(windows)]
    let raw = crate::process::hidden_command("cmd")
        .args(["/C", "ver"])
        .output()
        .ok()
        .and_then(|out| {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let start = text.find("Version ")? + "Version ".len();
            let rest = &text[start..];
            Some(rest[..rest.find(']').unwrap_or(rest.len())].to_string())
        })
        .unwrap_or_default();
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    let raw = String::new();
    sanitize_os_version(&raw)
}

/// `<key>K</key><string>V</string>` -> `V` (enough for SystemVersion.plist).
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn plist_string(plist: &str, key: &str) -> Option<String> {
    let after = &plist[plist.find(&format!("<key>{key}</key>"))?..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")? + start;
    Some(after[start..end].trim().to_string())
}

// ---------------------------------------------------------------------------
// Renderer IPC
// ---------------------------------------------------------------------------

/// The renderer's uncaught error / unhandled rejection: ONLY an error name
/// (validated to `^[A-Za-z][A-Za-z0-9_]{0,63}$`, otherwise `Error`); the
/// renderer cannot add any other property. At most
/// [`RENDERER_CRASH_CAP`] per app session.
#[tauri::command]
pub fn telemetry_renderer_crash(name: String) {
    let Some(runtime) = RUNTIME.get() else {
        return;
    };
    if runtime.renderer_crashes.fetch_add(1, Ordering::SeqCst) >= RENDERER_CRASH_CAP {
        return;
    }
    record(None, crash_renderer(&name));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn::TurnEndReason;
    use std::io::Read;
    use std::net::TcpListener;
    use tempfile::TempDir;

    /// Canaries a careless builder could leak: a path, a URL, a secret, an
    /// email, a command line and plain message text.
    const CANARIES: &[&str] = &[
        "/Users/alice/Documents/contrato-privado.pdf",
        "C:\\Users\\alice\\secret.txt",
        "https://intranet.example.com/q?token=abc",
        "sk-hke_live_SECRET123456",
        "alice@example.com",
        "rm -rf ~/proyecto",
        "mi mensaje privado",
    ];

    fn summary(model: &str) -> TurnSummary {
        TurnSummary {
            profile_id: "nan".into(),
            reason: TurnEndReason::ToolCap,
            error_kind: Some(crate::chat::ErrorKind::RateLimited),
            rounds: 60,
            tool_calls: 59,
            duration_ms: 123_456,
            model: model.into(),
            continued: true,
        }
    }

    /// Every builder in the catalogue, with representative inputs.
    fn every_event() -> Vec<EventSpec> {
        let mut out = vec![app_start(), turn_end(&summary("deepseek-v4-flash"))];
        for reason in [
            TurnEndReason::Completed,
            TurnEndReason::ToolCap,
            TurnEndReason::StreamCut,
            TurnEndReason::Length,
            TurnEndReason::Interrupted,
            TurnEndReason::UserStop,
            TurnEndReason::Error,
        ] {
            let mut s = summary("glm5.3");
            s.reason = reason;
            s.error_kind = None;
            out.push(turn_end(&s));
        }
        for name in TOOL_NAMES.iter().copied().chain(["made_up_tool"]) {
            for outcome in [
                ToolOutcome::Ok,
                ToolOutcome::Error,
                ToolOutcome::Timeout,
                ToolOutcome::Denied,
            ] {
                out.push(tool_call(name, outcome, 42));
            }
        }
        use crate::chat::ErrorKind as Chat;
        for kind in [
            Chat::MissingKey,
            Chat::Unauthorized,
            Chat::RateLimited,
            Chat::Server,
            Chat::Network,
            Chat::Protocol,
            Chat::Decode,
        ] {
            out.push(error_shown(Surface::Chat, &kind));
        }
        use crate::image_edit::EditErrorKind as Img;
        for kind in [Img::InvalidInstruction, Img::MissingKey, Img::Unauthorized] {
            out.push(error_shown(Surface::Images, &kind));
        }
        use crate::device_flow::ErrorKind as Login;
        for kind in [
            Login::Network,
            Login::Timeout,
            Login::RateLimited,
            Login::Server,
            Login::Protocol,
            Login::Identity,
            Login::Migration,
        ] {
            out.push(error_shown(Surface::SignIn, &kind));
        }
        out.push(error_shown(Surface::Memory, &"unavailable"));
        out.push(crash_rust("src/chat.rs", 1200));
        out.push(crash_rust(
            "/Users/runner/.cargo/registry/src/index.crates.io-6f17d22bba15001f/reqwest-0.13.5/src/async_impl/client.rs",
            77,
        ));
        out.push(crash_renderer("TypeError"));
        out
    }

    /// The contract's allowed values per (event, prop).
    fn allowed(name: &str, key: &str, value: &Value) -> bool {
        let s = value.as_str();
        match (name, key) {
            ("turn_end", "reason") => matches!(
                s,
                Some(
                    "completed"
                        | "tool_cap"
                        | "stream_cut"
                        | "length"
                        | "interrupted"
                        | "user_stop"
                        | "error"
                )
            ),
            ("turn_end", "error_kind") => value.is_null() || s.is_some_and(valid_name),
            ("turn_end", "rounds" | "tool_calls" | "duration_ms")
            | ("tool_call", "duration_ms") => value.is_u64(),
            ("turn_end", "model") => s.is_some_and(|m| model_id(m) == m),
            ("turn_end", "continued") => value.is_boolean(),
            ("tool_call", "tool") => s.is_some_and(|t| t == "unknown" || TOOL_NAMES.contains(&t)),
            ("tool_call", "outcome") => matches!(s, Some("ok" | "error" | "timeout" | "denied")),
            ("error_shown", "surface") => {
                matches!(s, Some("chat" | "images" | "sign_in" | "memory"))
            }
            ("error_shown", "kind") => s.is_some_and(valid_name),
            ("crash", "source") => matches!(s, Some("rust_panic" | "renderer")),
            ("crash", "location") => s.is_some_and(|l| {
                l.len() <= MAX_PROP_STRING_CHARS
                    && l.chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-' | ':')
                    })
            }),
            _ => false,
        }
    }

    fn expected_keys(name: &str) -> &'static [&'static str] {
        match name {
            "app_start" => &[],
            "turn_end" => &[
                "reason",
                "error_kind",
                "rounds",
                "tool_calls",
                "duration_ms",
                "model",
                "continued",
            ],
            "tool_call" => &["tool", "outcome", "duration_ms"],
            "error_shown" => &["surface", "kind"],
            "crash" => &["source", "location"],
            other => panic!("event {other} is not in the catalogue"),
        }
    }

    #[test]
    fn every_event_matches_the_contract_catalogue_and_validation() {
        let events = every_event();
        let names: HashSet<&str> = events.iter().map(|e| e.name).collect();
        assert_eq!(
            names,
            HashSet::from(["app_start", "turn_end", "tool_call", "error_shown", "crash"])
        );
        for event in &events {
            assert!(valid_name(event.name), "{}", event.name);
            assert!(valid_props(&event.props), "{event:?}");
            let mut keys: Vec<&str> = event.props.keys().map(String::as_str).collect();
            keys.sort_unstable();
            let mut want = expected_keys(event.name).to_vec();
            want.sort_unstable();
            assert_eq!(keys, want, "{}", event.name);
            for (key, value) in &event.props {
                assert!(
                    allowed(event.name, key, value),
                    "{}.{key} = {value}",
                    event.name
                );
            }
        }
    }

    #[test]
    fn user_content_never_reaches_any_event() {
        let mut events = Vec::new();
        for canary in CANARIES {
            // A model id, a tool name, an error-kind-ish string, a panic
            // file and a renderer error name all carrying user content.
            events.push(turn_end(&summary(canary)));
            events.push(tool_call(canary, ToolOutcome::Ok, 1));
            events.push(error_shown(Surface::Chat, canary));
            events.push(crash_renderer(canary));
            let result = serde_json::json!({
                "ok": false, "error": "io", "message": canary, "path": canary
            })
            .to_string();
            events.push(tool_call("read_file", tool_outcome_from_result(&result), 1));
        }
        let meta = Meta::new(&uuid::Uuid::new_v4().to_string(), "0.2.13", "15.1");
        let stamped: Vec<Event> = events
            .into_iter()
            .map(|spec| stamp(spec, &uuid::Uuid::new_v4().to_string(), SystemTime::now()))
            .collect();
        let wire = batch_body(&meta, &stamped).to_string();
        for canary in CANARIES {
            assert!(!wire.contains(canary), "{canary} leaked into {wire}");
        }
        for fragment in ["alice", "Users", "intranet", "SECRET", "privado", "rm -rf"] {
            assert!(!wire.contains(fragment), "{fragment} leaked");
        }
    }

    #[test]
    fn a_turn_over_a_sensitive_conversation_reports_only_metadata() {
        // The summary is all report_turn sees; even a model id the renderer
        // could have tampered with collapses to `other`.
        let event = turn_end(&summary("/Users/alice/x https://evil.example sk-abc"));
        assert_eq!(event.props["model"], "other");
        assert_eq!(event.props["reason"], "tool_cap");
        assert_eq!(event.props["error_kind"], "rate_limited");
        assert_eq!(event.props["rounds"], 60);
        assert_eq!(event.props["continued"], true);
    }

    #[test]
    fn an_interrupted_turn_reports_its_real_error_kind() {
        let mut s = summary("glm5.3");
        s.reason = TurnEndReason::Interrupted;
        s.error_kind = Some(crate::chat::ErrorKind::Server);
        let event = turn_end(&s);
        assert_eq!(event.props["reason"], "interrupted");
        assert_eq!(event.props["error_kind"], "server");
    }

    #[test]
    fn tool_outcomes_are_classified_from_the_result_shape_only() {
        let cases = [
            (r#"{"ok":true,"summary":"x"}"#, ToolOutcome::Ok),
            (r#"{"ok":true,"timed_out":true}"#, ToolOutcome::Timeout),
            (r#"{"ok":false,"error":"declined"}"#, ToolOutcome::Denied),
            (
                r#"{"ok":false,"error":"io","message":"/a"}"#,
                ToolOutcome::Error,
            ),
            (r#"{"results":[]}"#, ToolOutcome::Ok),
            ("not json", ToolOutcome::Ok),
        ];
        for (content, want) in cases {
            assert_eq!(tool_outcome_from_result(content), want, "{content}");
        }
    }

    #[test]
    fn real_tool_results_classify_as_the_contract_outcomes() {
        use crate::chat::outcome_for_model;
        use crate::tools::{Rejection, ToolOutcome as Done};
        let ok = outcome_for_model(Ok(Done {
            summary: "/Users/alice/x: exit 0".into(),
            ..Default::default()
        }));
        let timed_out = outcome_for_model(Ok(Done {
            timed_out: true,
            ..Default::default()
        }));
        let declined = outcome_for_model(Err(Rejection::new("declined", "no")));
        let failed = outcome_for_model(Err(Rejection::new("io", "/Users/alice/x: denied")));
        assert_eq!(tool_outcome_from_result(&ok), ToolOutcome::Ok);
        assert_eq!(tool_outcome_from_result(&timed_out), ToolOutcome::Timeout);
        assert_eq!(tool_outcome_from_result(&declined), ToolOutcome::Denied);
        assert_eq!(tool_outcome_from_result(&failed), ToolOutcome::Error);
    }

    #[test]
    fn panic_locations_drop_build_machine_prefixes() {
        assert_eq!(panic_location("src/chat.rs", 12), "src/chat.rs:12");
        assert_eq!(
            panic_location(
                "/Users/runner/.cargo/registry/src/idx/reqwest-0.13.5/src/lib.rs",
                3
            ),
            "reqwest-0.13.5/src/lib.rs:3"
        );
        assert_eq!(
            panic_location(
                "C:\\Users\\bob\\.cargo\\registry\\src\\i\\tokio-1\\src\\rt.rs",
                9
            ),
            "tokio-1/src/rt.rs:9"
        );
        assert_eq!(panic_location("../x/y.rs", 1), "x/y.rs:1");
        let long = format!("src/{}.rs", "a".repeat(300));
        assert!(panic_location(&long, 1).len() <= MAX_PROP_STRING_CHARS);
    }

    #[test]
    fn renderer_error_names_are_constrained() {
        assert_eq!(renderer_error_name("TypeError"), "TypeError");
        assert_eq!(renderer_error_name("object"), "object");
        for bad in [
            "",
            "1abc",
            "Type Error",
            "a/b",
            "x".repeat(65).as_str(),
            "Error: secret",
        ] {
            assert_eq!(renderer_error_name(bad), "Error", "{bad}");
        }
    }

    #[test]
    fn unknown_tools_and_odd_models_collapse() {
        assert_eq!(tool_name("run_command"), "run_command");
        assert_eq!(tool_name("cat /etc/passwd"), "unknown");
        assert_eq!(model_id("glm5.3-flash"), "glm5.3-flash");
        assert_eq!(model_id("org/model"), "other");
        assert_eq!(
            model_id("sk-hke_live_SECRET123456"),
            "other",
            "not in the allowlist"
        );
        assert_eq!(model_id(""), "other");
    }

    #[test]
    fn meta_satisfies_the_backend_formats() {
        let meta = Meta::new("id", "0.2.13", "Version 10.0.22631\u{7}<x>");
        assert!(matches!(meta.os.as_str(), "macos" | "windows" | "linux"));
        assert!(valid_arch(&meta.arch));
        assert!(valid_app_version(&meta.app_version));
        assert_eq!(meta.os_version, "Version 10.0.22631x");
        assert_eq!(Meta::new("id", "bad version!", "").app_version, "0.0.0");
        assert!(sanitize_os_version(&"9".repeat(100)).len() <= 64);
    }

    #[test]
    fn plist_product_version_is_read() {
        let plist = "<dict><key>ProductName</key><string>macOS</string>\
                     <key>ProductVersion</key><string>15.1.1</string></dict>";
        assert_eq!(
            plist_string(plist, "ProductVersion").as_deref(),
            Some("15.1.1")
        );
        assert_eq!(plist_string(plist, "Missing"), None);
    }

    #[test]
    fn timestamps_are_rfc3339_utc() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let t = UNIX_EPOCH + Duration::from_millis(1_794_873_600_123); // 2026-11-17
        assert_eq!(rfc3339(t), "2026-11-17T00:00:00.123Z");
        let leap = UNIX_EPOCH + Duration::from_secs(1_709_164_800 + 3_661); // 2024-02-29
        assert_eq!(rfc3339(leap), "2024-02-29T01:01:01.000Z");
    }

    #[test]
    fn daily_cap_stops_recording_and_resets_the_next_day() {
        let mut cap = DailyCap::default();
        for _ in 0..DAILY_EVENT_CAP {
            assert!(cap.admit("2026-11-17"));
        }
        assert!(!cap.admit("2026-11-17"), "over the cap");
        assert!(cap.admit("2026-11-18"), "new day");
        assert_eq!(cap.count, 1);
        let tmp = TempDir::new().unwrap();
        cap.save(tmp.path());
        assert_eq!(DailyCap::load(tmp.path()), cap, "survives a restart");
        assert_eq!(
            DailyCap::load(&tmp.path().join("missing")),
            DailyCap::default()
        );
    }

    #[test]
    fn status_codes_map_to_the_documented_dispositions() {
        // Any 2xx is delivered, including the backends' 202 with
        // `dropped` (per-account cap): never retried.
        assert_eq!(classify_status(202), Disposition::Sent);
        for s in [400, 413, 422] {
            assert_eq!(classify_status(s), Disposition::Drop, "{s}");
        }
        for s in [401, 403, 404] {
            assert_eq!(classify_status(s), Disposition::Block, "{s}");
        }
        for s in [408, 429, 500, 502, 503] {
            assert_eq!(classify_status(s), Disposition::Retry, "{s}");
        }
    }

    #[test]
    fn backoff_doubles_up_to_the_cap_and_resets() {
        let mut backoff = Backoff::default();
        let now = Instant::now();
        assert!(backoff.ready("nan", now));
        backoff.fail("nan", now);
        assert!(!backoff.ready("nan", now));
        assert!(backoff.ready("helmcode", now), "per profile");
        assert!(backoff.ready("nan", now + FLUSH_INTERVAL));
        for _ in 0..20 {
            backoff.fail("nan", now);
        }
        assert_eq!(backoff.until["nan"].1, BACKOFF_MAX);
        backoff.reset("nan");
        assert!(backoff.ready("nan", now));
    }

    // ---- queue ---------------------------------------------------------------

    fn queued(profile: Option<&str>, realm: Option<&str>, at: u64) -> Queued {
        Queued {
            profile: profile.map(str::to_string),
            realm: realm.map(str::to_string),
            at,
            event: stamp(
                app_start(),
                &uuid::Uuid::new_v4().to_string(),
                SystemTime::now(),
            ),
        }
    }

    #[test]
    fn events_only_go_to_the_profile_and_user_that_produced_them() {
        let nan_a = queued(Some("nan"), Some("realm-a"), 0);
        let nan_any = queued(Some("nan"), None, 0);
        let helm = queued(Some("helmcode"), Some("realm-h"), 0);
        let install = queued(None, None, 0);
        assert!(nan_a.belongs_to("nan", "realm-a", false));
        assert!(!nan_a.belongs_to("nan", "realm-b", true), "another user");
        assert!(
            !nan_a.belongs_to("helmcode", "realm-a", true),
            "another tenant"
        );
        assert!(nan_any.belongs_to("nan", "realm-b", false));
        assert!(!helm.belongs_to("nan", "realm-h", true));
        assert!(install.belongs_to("nan", "x", true));
        assert!(
            !install.belongs_to("nan", "x", false),
            "only the active profile"
        );
    }

    #[test]
    fn the_queue_persists_caps_prunes_and_merges_the_crash_file() {
        let tmp = TempDir::new().unwrap();
        let now = unix_now();
        {
            let mut queue = Queue::open(tmp.path(), now);
            for _ in 0..QUEUE_CAP + 5 {
                queue.push(queued(Some("nan"), Some("r"), now));
            }
            assert_eq!(queue.len(), QUEUE_CAP, "oldest dropped");
            queue.push(queued(Some("nan"), Some("r"), 1)); // ancient
        }
        // A panic last launch left a crash line; a corrupt line is skipped.
        let crash = queued(None, None, now);
        std::fs::write(
            tmp.path().join(CRASH_FILE),
            format!("{}\nnot json\n", serde_json::to_string(&crash).unwrap()),
        )
        .unwrap();
        let queue = Queue::open(tmp.path(), now);
        assert_eq!(
            queue.len(),
            QUEUE_CAP,
            "ancient pruned, crash merged, capped"
        );
        assert_eq!(queue.items().last().unwrap().event.id, crash.event.id);
        assert!(!tmp.path().join(CRASH_FILE).exists());
        // Reopening yields the same queue (the merge was persisted).
        assert_eq!(Queue::open(tmp.path(), now).len(), QUEUE_CAP);
    }

    #[test]
    fn malformed_records_on_disk_are_dropped() {
        let tmp = TempDir::new().unwrap();
        let mut bad = queued(Some("nan"), None, unix_now());
        bad.event
            .props
            .insert("nested".into(), serde_json::json!({"a": 1}));
        let mut other_tenant = queued(Some("evil"), None, unix_now());
        other_tenant.event.name = "app_start".into();
        let good = queued(Some("nan"), None, unix_now());
        let text = [bad, other_tenant, good.clone()]
            .iter()
            .map(|q| serde_json::to_string(q).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(tmp.path().join(QUEUE_FILE), text).unwrap();
        let queue = Queue::open(tmp.path(), unix_now());
        assert_eq!(queue.items(), &[good]);
    }

    #[test]
    fn the_install_id_is_stable_and_a_valid_uuid() {
        let tmp = TempDir::new().unwrap();
        let first = load_install_id(tmp.path());
        assert!(is_uuid(&first));
        assert_eq!(load_install_id(tmp.path()), first);
        std::fs::write(
            tmp.path().join(INSTALL_FILE),
            "00000000-0000-0000-0000-000000000000",
        )
        .unwrap();
        let fresh = load_install_id(tmp.path());
        assert!(is_uuid(&fresh) && fresh != first, "nil id replaced");
    }

    #[test]
    fn oversized_batches_are_split_to_fit_the_body_limit() {
        let meta = Meta::new("id", "1.0.0", "");
        let mut props = Map::new();
        for i in 0..MAX_PROP_KEYS {
            props.insert(format!("k{i}"), Value::String("x".repeat(128)));
        }
        let events: Vec<Event> = (0..BATCH_MAX)
            .map(|_| {
                stamp(
                    EventSpec {
                        name: "big",
                        props: props.clone(),
                    },
                    &uuid::Uuid::new_v4().to_string(),
                    SystemTime::now(),
                )
            })
            .collect();
        let (body, kept) = fit_batch(&meta, events);
        assert!(serde_json::to_vec(&body).unwrap().len() <= MAX_BODY_BYTES);
        assert!(!kept.is_empty() && kept.len() < BATCH_MAX);
    }

    // ---- wire (std TcpListener mock) -------------------------------------------

    fn mock_server(statuses: Vec<u16>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("addr"));
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for status in statuses {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    let n = stream.read(&mut chunk).expect("read");
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + len {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                seen.push(String::from_utf8_lossy(&buf).to_string());
                // The per-account cap's shape: a 202 that dropped everything is
                // still delivered (removed from the queue, never retried).
                let body = r#"{"accepted":0,"duplicates":0,"dropped":3}"#;
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                std::io::Write::write_all(&mut stream, reply.as_bytes()).expect("write");
            }
            seen
        });
        (base, handle)
    }

    fn target(base: &str) -> FlushTarget {
        FlushTarget {
            profile: "nan".into(),
            realm: "realm-a".into(),
            active: true,
            base: base.into(),
            token: "jwt-canary".into(),
        }
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[test]
    fn flush_sends_batches_of_at_most_100_and_only_this_tenants_events() {
        let tmp = TempDir::new().unwrap();
        let mut queue = Queue::open(tmp.path(), unix_now());
        for _ in 0..150 {
            queue.push(queued(Some("nan"), Some("realm-a"), unix_now()));
        }
        queue.push(queued(Some("helmcode"), Some("realm-h"), unix_now()));
        queue.push(queued(None, None, unix_now()));
        let queue = Mutex::new(queue);
        let (base, server) = mock_server(vec![202, 202]);
        let meta = Meta::new(&uuid::Uuid::new_v4().to_string(), "0.2.13", "15.1");
        let last =
            tauri::async_runtime::block_on(flush_profile(&queue, &meta, &client(), &target(&base)));
        assert_eq!(last, Some(Disposition::Sent));
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        let mut sent = 0;
        for request in &requests {
            assert!(request.starts_with("POST /api/desktop/telemetry "));
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer jwt-canary")
            );
            let body: Value =
                serde_json::from_str(&request[request.find("\r\n\r\n").unwrap() + 4..]).unwrap();
            let events = body["events"].as_array().unwrap();
            assert!(!events.is_empty() && events.len() <= BATCH_MAX);
            sent += events.len();
            assert_eq!(body["app_version"], "0.2.13");
            assert!(is_uuid(body["install_id"].as_str().unwrap()));
        }
        assert_eq!(sent, 151, "150 nan events + the install-level one");
        let left = queue.lock().unwrap();
        assert_eq!(
            left.len(),
            1,
            "the helmcode event stays for its own platform"
        );
        assert_eq!(left.items()[0].profile.as_deref(), Some("helmcode"));
    }

    #[test]
    fn a_rejected_batch_is_dropped_and_a_rejected_session_keeps_the_queue() {
        for (status, want, left) in [
            (400, Disposition::Drop, 0),
            (401, Disposition::Block, 3),
            (404, Disposition::Block, 3),
            (429, Disposition::Retry, 3),
            (503, Disposition::Retry, 3),
        ] {
            let tmp = TempDir::new().unwrap();
            let mut queue = Queue::open(tmp.path(), unix_now());
            for _ in 0..3 {
                queue.push(queued(Some("nan"), None, unix_now()));
            }
            let queue = Mutex::new(queue);
            // A dropped batch empties the queue in one request.
            let (base, server) = mock_server(vec![status]);
            let meta = Meta::new("id", "1.0.0", "");
            let last = tauri::async_runtime::block_on(flush_profile(
                &queue,
                &meta,
                &client(),
                &target(&base),
            ));
            server.join().unwrap();
            assert_eq!(last, Some(want), "{status}");
            assert_eq!(queue.lock().unwrap().len(), left, "{status}");
        }
    }

    #[test]
    fn an_unreachable_platform_is_retried_later() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let tmp = TempDir::new().unwrap();
        let mut queue = Queue::open(tmp.path(), unix_now());
        queue.push(queued(Some("nan"), None, unix_now()));
        let queue = Mutex::new(queue);
        let last = tauri::async_runtime::block_on(flush_profile(
            &queue,
            &Meta::new("id", "1.0.0", ""),
            &client(),
            &target(&format!("http://127.0.0.1:{port}")),
        ));
        assert_eq!(last, Some(Disposition::Retry));
        assert_eq!(queue.lock().unwrap().len(), 1);
    }

    #[test]
    fn nothing_to_send_makes_no_request() {
        let tmp = TempDir::new().unwrap();
        let queue = Mutex::new(Queue::open(tmp.path(), unix_now()));
        let last = tauri::async_runtime::block_on(flush_profile(
            &queue,
            &Meta::new("id", "1.0.0", ""),
            &client(),
            &target("http://127.0.0.1:9"),
        ));
        assert_eq!(last, None);
    }
}
