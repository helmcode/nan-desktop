//! Chat persistence (T4, S3): conversations and messages in SQLite.
//!
//! The chat store lives in its own file (`chat.db` in the app data dir).
//!
//! All functions are connection-injected pure logic, unit-tested against a
//! temp file — never the real app dir.
//!
//! Memory sync (P1-6): every conversation carries a stable `remote_id`
//! (uuid) shared across devices and a `synced_at` watermark; deleting a
//! synced conversation leaves a row in `memory_tombstones` so the remote
//! copy is deleted on the next sync instead of being pulled back. Web
//! search sources (P1-7) are stored per message as a JSON array.
//!
//! Timestamps use `strftime('%Y-%m-%dT%H:%M:%fZ','now')` (millisecond ISO-8601)
//! so "most recent first" ordering is deterministic even for rows written in
//! the same second.
//!
//! Secrets (S4): this store holds conversation text only — never API keys,
//! never the session JWT.
//!
//! T4b streaming resilience: assistant rows carry a `status` column
//! (`complete` default, `in_progress` while the reply is streaming).
//! `in_progress` rows are flagged `partial: true` by the list functions and
//! their content is overwritten per network chunk, so a crash mid-stream
//! leaves the partial reply queryable.

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// One web search source cited under an assistant message (P1-7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebSource {
    pub title: String,
    pub url: String,
}

/// Decode the `sources` column: NULL or corrupt JSON → no sources.
fn decode_sources(raw: Option<String>) -> Vec<WebSource> {
    raw.and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Message status: the row is finalized (a normal historical message).
pub const STATUS_COMPLETE: &str = "complete";
/// Message status: the assistant reply is still streaming (or the process
/// died mid-stream — a crash leftover flagged `partial` by `messages_list`).
pub const STATUS_IN_PROGRESS: &str = "in_progress";

/// SQLite file name inside the app data dir.
pub const DB_FILE: &str = "chat.db";

/// Fallback title for conversations that have not been auto-titled yet (no
/// first user message seen). UI copy, so Spanish like the rest of the UI.
pub const UNTITLED_FALLBACK: &str = "Nueva conversación";

/// Maximum characters of the last message shown as a preview in the sidebar.
pub const PREVIEW_MAX_CHARS: usize = 80;

/// A conversation row as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    pub profile_id: String,
    pub created_at: String,
    pub updated_at: String,
}

/// A conversation as seen by the sidebar list: display title (with the
/// untitled fallback applied) and a truncated last-message preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConversationView {
    pub id: i64,
    pub title: String,
    pub updated_at: String,
    pub last_message: Option<String>,
}

/// A message row as stored (and returned by `messages_list`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatMessageRow {
    pub id: i64,
    pub conversation_id: i64,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub created_at: String,
    /// T4b: `true` only for `status='in_progress'` crash leftovers — the
    /// reply never finished, so the UI renders an interrupted notice.
    pub partial: bool,
    /// T5: absolute path of the generated image file for assistant image
    /// messages (`qwen-image-2.1`). `None` for every text row; the renderer
    /// loads the file through the asset protocol (never the raw bytes).
    pub media_path: Option<String>,
    /// P1-7: web search sources cited by this assistant reply (empty for
    /// every other row).
    pub sources: Vec<WebSource>,
}

/// Create both tables if missing and enable foreign keys for this
/// connection. Safe to call on every open.
pub fn ensure_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS conversations (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             title TEXT NOT NULL DEFAULT '',
             profile_id TEXT NOT NULL,
             created_at TEXT NOT NULL,
             updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS messages (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
             role TEXT NOT NULL,
             content TEXT NOT NULL,
             model TEXT,
             media_path TEXT,
             created_at TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'complete'
         );
         CREATE INDEX IF NOT EXISTS idx_messages_conversation
             ON messages(conversation_id, id);
         CREATE TABLE IF NOT EXISTS memory_tombstones (
             remote_id TEXT PRIMARY KEY,
             profile_id TEXT NOT NULL
         );",
    )?;
    ensure_status_column(conn)?;
    ensure_media_path_column(conn)?;
    ensure_column(conn, "messages", "sources", "TEXT")?;
    ensure_column(conn, "conversations", "remote_id", "TEXT")?;
    ensure_column(conn, "conversations", "synced_at", "TEXT")?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_remote_id
             ON conversations(remote_id);",
    )
}

/// Add a nullable column in place when an older database lacks it (same
/// pattern as the status/media_path migrations). `table`/`column`/`decl`
/// are compile-time constants, never user input.
fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> Result<(), rusqlite::Error> {
    let present: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
        [column],
        |row| row.get(0),
    )?;
    if present == 0 {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl};"))?;
    }
    Ok(())
}

/// Pre-T4b databases have a `messages` table without the `status` column
/// (`CREATE TABLE IF NOT EXISTS` is a no-op there). Add it in place with the
/// `complete` default so existing history keeps rendering as finalized.
fn ensure_status_column(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_status: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'status'",
        [],
        |row| row.get(0),
    )?;
    if has_status == 0 {
        conn.execute_batch(
            "ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';",
        )?;
    }
    Ok(())
}

/// Pre-T5 databases have a `messages` table without the `media_path` column
/// (`CREATE TABLE IF NOT EXISTS` is a no-op there). Add it in place — NULL
/// for every pre-existing row, so old messages render as text-only.
fn ensure_media_path_column(conn: &Connection) -> Result<(), rusqlite::Error> {
    let has_media_path: i64 = conn.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name = 'media_path'",
        [],
        |row| row.get(0),
    )?;
    if has_media_path == 0 {
        conn.execute_batch("ALTER TABLE messages ADD COLUMN media_path TEXT;")?;
    }
    Ok(())
}

/// Open (or create) the chat database under `dir` and make sure the schema
/// exists. Shared by every chat command.
pub fn open_db(dir: &std::path::Path) -> Result<Connection, String> {
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let conn = Connection::open(dir.join(DB_FILE)).map_err(|err| err.to_string())?;
    ensure_schema(&conn).map_err(|err| err.to_string())?;
    Ok(conn)
}

/// Insert a conversation and return its id. `title` may be empty — the empty
/// title means "auto-title from the first user message later".
pub fn insert_conversation(
    conn: &Connection,
    profile_id: &str,
    title: &str,
) -> Result<i64, rusqlite::Error> {
    // `remote_id` is assigned lazily by `ensure_remote_ids` (memory sync),
    // so this insert also works on a not-yet-migrated legacy schema.
    conn.execute(
        "INSERT INTO conversations (title, profile_id, created_at, updated_at)
         VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        rusqlite::params![title, profile_id],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Fetch one conversation by id.
pub fn conversation_get(
    conn: &Connection,
    conversation_id: i64,
) -> Result<Option<Conversation>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, profile_id, created_at, updated_at
         FROM conversations WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map([conversation_id], |row| {
        Ok(Conversation {
            id: row.get(0)?,
            title: row.get(1)?,
            profile_id: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
        })
    })?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Set a conversation's title (auto-title path: the empty title is replaced
/// by the first user message, truncated).
pub fn set_conversation_title(
    conn: &Connection,
    conversation_id: i64,
    title: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET title = ?1 WHERE id = ?2",
        rusqlite::params![title, conversation_id],
    )?;
    Ok(())
}

/// Bump a conversation's `updated_at` to now (recency ordering).
pub fn touch_conversation(conn: &Connection, conversation_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?1",
        [conversation_id],
    )?;
    Ok(())
}

/// Insert a message row and return its id. `model` is `None` for user
/// messages and the generating model for assistant messages.
pub fn insert_message(
    conn: &Connection,
    conversation_id: i64,
    role: &str,
    content: &str,
    model: Option<&str>,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, model, created_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        rusqlite::params![conversation_id, role, content, model],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Insert an assistant image message (T5): `content` is the generation
/// prompt, `model` the image model, `media_path` the saved file's absolute
/// path. Written directly as `status='complete'` (no streaming lifecycle).
pub fn insert_image_message(
    conn: &Connection,
    conversation_id: i64,
    content: &str,
    model: &str,
    media_path: &str,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, model, media_path, created_at, status)
         VALUES (?1, 'assistant', ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?5)",
        rusqlite::params![
            conversation_id,
            content,
            model,
            media_path,
            STATUS_COMPLETE
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Create the in-progress assistant row for a stream (T4b): `status=
/// 'in_progress'`, empty content, the generating model. Deltas overwrite
/// this row as they arrive; a clean finish or a stop finalizes it, an
/// error deletes it.
pub fn insert_in_progress_assistant(
    conn: &Connection,
    conversation_id: i64,
    model: Option<&str>,
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, model, created_at, status)
         VALUES (?1, 'assistant', '', ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?3)",
        rusqlite::params![conversation_id, model, STATUS_IN_PROGRESS],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Overwrite a message's content — the stream task's per-chunk delta flush
/// (T4b): each flush carries everything received so far, so the write is
/// idempotent and a crash mid-stream leaves the last flush in place.
pub fn update_message_content(
    conn: &Connection,
    message_id: i64,
    content: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET content = ?1 WHERE id = ?2",
        rusqlite::params![content, message_id],
    )?;
    Ok(())
}

/// Finalize a message in place: final content + `status='complete'` (the
/// clean-done path of the stream task).
pub fn finalize_message(
    conn: &Connection,
    message_id: i64,
    content: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET content = ?1, status = ?2 WHERE id = ?3",
        rusqlite::params![content, STATUS_COMPLETE, message_id],
    )?;
    Ok(())
}

/// Complete every in-progress row of a conversation — the stop path (T4b):
/// whatever text arrived stays, with no failed marker. Returns the number
/// of rows completed (0 when there was nothing in progress).
pub fn finalize_in_progress(
    conn: &Connection,
    conversation_id: i64,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET status = ?1 WHERE conversation_id = ?2 AND status = ?3",
        rusqlite::params![STATUS_COMPLETE, conversation_id, STATUS_IN_PROGRESS],
    )
}

/// Remove one message row — the stream error path (T4b): the partial text
/// is dropped by design, exactly as before T4b.
pub fn delete_message(conn: &Connection, message_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM messages WHERE id = ?1", [message_id])?;
    Ok(())
}

/// Attach web search sources to a message (P1-7). An empty slice clears
/// them (NULL).
pub fn set_message_sources(
    conn: &Connection,
    message_id: i64,
    sources: &[WebSource],
) -> Result<(), rusqlite::Error> {
    let json = if sources.is_empty() {
        None
    } else {
        Some(serde_json::to_string(sources).unwrap_or_else(|_| "[]".to_string()))
    };
    conn.execute(
        "UPDATE messages SET sources = ?1 WHERE id = ?2",
        rusqlite::params![json, message_id],
    )?;
    Ok(())
}

/// List a profile's conversations, most recently updated first. The title is
/// the stored one, or the untitled fallback when still empty; `last_message`
/// is the newest message's content, truncated to [`PREVIEW_MAX_CHARS`].
pub fn list_conversations(
    conn: &Connection,
    profile_id: &str,
) -> Result<Vec<ConversationView>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, title, updated_at FROM conversations
         WHERE profile_id = ?1
         ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([profile_id], |row| {
        Ok(ConversationView {
            id: row.get(0)?,
            title: row.get(1)?,
            updated_at: row.get(2)?,
            last_message: None,
        })
    })?;
    let mut views: Vec<ConversationView> = Vec::new();
    for row in rows {
        views.push(row?);
    }
    for view in &mut views {
        if view.title.is_empty() {
            view.title = UNTITLED_FALLBACK.to_string();
        }
        if let Some(last) = last_message(conn, view.id)? {
            view.last_message = Some(truncate_chars(&last.content, PREVIEW_MAX_CHARS));
        }
    }
    Ok(views)
}

/// Column list read by [`map_message_row`] (order matters).
const MESSAGE_COLUMNS: &str =
    "id, conversation_id, role, content, model, media_path, created_at, status, sources";

fn map_message_row(row: &rusqlite::Row<'_>) -> Result<ChatMessageRow, rusqlite::Error> {
    let status: String = row.get(7)?;
    Ok(ChatMessageRow {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        model: row.get(4)?,
        media_path: row.get(5)?,
        created_at: row.get(6)?,
        partial: status == STATUS_IN_PROGRESS,
        sources: decode_sources(row.get(8)?),
    })
}

/// The newest message of a conversation, if any.
fn last_message(
    conn: &Connection,
    conversation_id: i64,
) -> Result<Option<ChatMessageRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1"
    ))?;
    let mut rows = stmt.query_map([conversation_id], map_message_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// List a conversation's messages in ascending id order (chat transcript
/// order). Unknown conversation ids yield an empty list.
pub fn list_messages(
    conn: &Connection,
    conversation_id: i64,
) -> Result<Vec<ChatMessageRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ?1 ORDER BY id ASC"
    ))?;
    let rows = stmt.query_map([conversation_id], map_message_row)?;
    let mut messages: Vec<ChatMessageRow> = Vec::new();
    for row in rows {
        messages.push(row?);
    }
    Ok(messages)
}

/// Delete a conversation and (explicitly, before the FK cascade) its
/// messages. Deleting an unknown id is a no-op. A conversation that was
/// already synced to the account leaves a tombstone so the next memory sync
/// deletes the remote copy instead of pulling it back.
pub fn delete_conversation(conn: &Connection, conversation_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT OR IGNORE INTO memory_tombstones (remote_id, profile_id)
         SELECT remote_id, profile_id FROM conversations
         WHERE id = ?1 AND remote_id IS NOT NULL AND synced_at IS NOT NULL",
        [conversation_id],
    )?;
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        [conversation_id],
    )?;
    conn.execute("DELETE FROM conversations WHERE id = ?1", [conversation_id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Memory sync helpers (P1-6)
// ---------------------------------------------------------------------------

/// A message in the portable (device-independent) shape exchanged with the
/// account memory API. Image rows are never part of it: their files are
/// device-local.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MessageRecord {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub sources: Vec<WebSource>,
}

/// Sync metadata of one local conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncConversation {
    pub id: i64,
    pub remote_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub synced_at: Option<String>,
    /// A reply is streaming (or was interrupted): never overwrite or upload.
    pub has_in_progress: bool,
}

impl SyncConversation {
    /// Changed locally since the last successful upload.
    pub fn is_dirty(&self) -> bool {
        self.synced_at
            .as_deref()
            .is_none_or(|synced| self.updated_at.as_str() > synced)
    }
}

/// Normalize an RFC 3339 UTC timestamp to the store's millisecond form
/// (`YYYY-MM-DDTHH:MM:SS.mmmZ`) so lexicographic order is chronological
/// order (`…:00Z` vs `…:00.500Z` would otherwise sort wrong). Anything that
/// is not a recognizable UTC timestamp is returned unchanged.
pub fn normalize_timestamp(raw: &str) -> String {
    let raw = raw.trim();
    let (body, utc) = if let Some(body) = raw.strip_suffix('Z') {
        (body, true)
    } else if let Some(body) = raw.strip_suffix("+00:00") {
        (body, true)
    } else {
        (raw, false)
    };
    let bytes = body.as_bytes();
    let shape_ok = utc
        && bytes.len() >= 19
        && body.is_char_boundary(19)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && (bytes[10] == b'T' || bytes[10] == b' ')
        && bytes[13] == b':'
        && bytes[16] == b':';
    if !shape_ok {
        return raw.to_string();
    }
    let (seconds, fraction) = body.split_at(19);
    let digits: String = fraction
        .strip_prefix('.')
        .unwrap_or("")
        .chars()
        .filter(char::is_ascii_digit)
        .chain(std::iter::repeat('0'))
        .take(3)
        .collect();
    format!("{}T{}.{digits}Z", &seconds[..10], &seconds[11..])
}

/// Give every legacy conversation of a profile (created before memory
/// sync existed) a stable remote id.
pub fn ensure_remote_ids(conn: &Connection, profile_id: &str) -> Result<(), rusqlite::Error> {
    let ids: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT id FROM conversations WHERE profile_id = ?1 AND remote_id IS NULL")?;
        stmt.query_map([profile_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?
    };
    for id in ids {
        conn.execute(
            "UPDATE conversations SET remote_id = ?1 WHERE id = ?2",
            rusqlite::params![uuid::Uuid::new_v4().to_string(), id],
        )?;
    }
    Ok(())
}

/// Sync metadata for every conversation of a profile (remote ids are
/// backfilled first).
pub fn list_sync_conversations(
    conn: &Connection,
    profile_id: &str,
) -> Result<Vec<SyncConversation>, rusqlite::Error> {
    ensure_remote_ids(conn, profile_id)?;
    let mut stmt = conn.prepare(
        "SELECT c.id, c.remote_id, c.title, c.created_at, c.updated_at, c.synced_at,
                EXISTS (SELECT 1 FROM messages m
                        WHERE m.conversation_id = c.id AND m.status = ?2)
         FROM conversations c WHERE c.profile_id = ?1 ORDER BY c.id ASC",
    )?;
    stmt.query_map(rusqlite::params![profile_id, STATUS_IN_PROGRESS], |row| {
        Ok(SyncConversation {
            id: row.get(0)?,
            remote_id: row.get(1)?,
            title: row.get(2)?,
            created_at: row.get(3)?,
            updated_at: row.get(4)?,
            synced_at: row.get(5)?,
            has_in_progress: row.get(6)?,
        })
    })?
    .collect()
}

/// Owner profile and local id of a conversation by remote id, if present.
pub fn find_by_remote_id(
    conn: &Connection,
    remote_id: &str,
) -> Result<Option<(i64, String)>, rusqlite::Error> {
    conn.query_row(
        "SELECT id, profile_id FROM conversations WHERE remote_id = ?1",
        [remote_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

/// The portable messages of a conversation: complete text rows only (image
/// rows are device-local, in-progress rows are not final).
pub fn export_messages(
    conn: &Connection,
    conversation_id: i64,
) -> Result<Vec<MessageRecord>, rusqlite::Error> {
    Ok(list_messages(conn, conversation_id)?
        .into_iter()
        .filter(|row| row.media_path.is_none() && !row.partial)
        .map(|row| MessageRecord {
            role: row.role,
            content: row.content,
            model: row.model,
            created_at: row.created_at,
            sources: row.sources,
        })
        .collect())
}

/// Insert (`local_id: None`) or overwrite a conversation with the remote
/// copy: title, timestamps and all TEXT messages are replaced; local image
/// rows are kept (they never travel). The row is marked synced at the
/// remote `updated_at`. Runs in one transaction.
#[allow(clippy::too_many_arguments)]
pub fn write_remote_conversation(
    conn: &Connection,
    local_id: Option<i64>,
    profile_id: &str,
    remote_id: &str,
    title: &str,
    created_at: &str,
    updated_at: &str,
    messages: &[MessageRecord],
) -> Result<i64, rusqlite::Error> {
    let tx = conn.unchecked_transaction()?;
    let id = match local_id {
        Some(id) => {
            tx.execute(
                "UPDATE conversations SET title = ?1, updated_at = ?2, synced_at = ?2 WHERE id = ?3",
                rusqlite::params![title, updated_at, id],
            )?;
            tx.execute(
                "DELETE FROM messages WHERE conversation_id = ?1 AND media_path IS NULL",
                [id],
            )?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO conversations (title, profile_id, created_at, updated_at, remote_id, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?4)",
                rusqlite::params![title, profile_id, created_at, updated_at, remote_id],
            )?;
            tx.last_insert_rowid()
        }
    };
    for message in messages {
        let sources = if message.sources.is_empty() {
            None
        } else {
            serde_json::to_string(&message.sources).ok()
        };
        tx.execute(
            "INSERT INTO messages (conversation_id, role, content, model, created_at, status, sources)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                id,
                message.role,
                message.content,
                message.model,
                message.created_at,
                STATUS_COMPLETE,
                sources
            ],
        )?;
    }
    tx.commit()?;
    Ok(id)
}

/// Record a successful upload of the conversation state at `updated_at`.
pub fn mark_synced(
    conn: &Connection,
    conversation_id: i64,
    updated_at: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE conversations SET synced_at = ?1 WHERE id = ?2",
        rusqlite::params![updated_at, conversation_id],
    )?;
    Ok(())
}

/// Remote ids deleted locally whose remote copy still has to be removed.
pub fn list_tombstones(
    conn: &Connection,
    profile_id: &str,
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT remote_id FROM memory_tombstones WHERE profile_id = ?1 ORDER BY remote_id",
    )?;
    stmt.query_map([profile_id], |row| row.get(0))?.collect()
}

/// Forget a tombstone once the remote delete succeeded.
pub fn remove_tombstone(conn: &Connection, remote_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM memory_tombstones WHERE remote_id = ?1",
        [remote_id],
    )?;
    Ok(())
}

/// Truncate `text` to at most `max` chars (never splitting a multi-byte
/// character; 1 char = 1 Unicode scalar, not 1 byte).
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn open_temp_db(dir: &TempDir) -> Connection {
        let conn = Connection::open(dir.path().join("chat-test.db")).expect("open temp db");
        ensure_schema(&conn).expect("schema");
        conn
    }

    #[test]
    fn empty_profile_lists_no_conversations() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);

        let views = list_conversations(&conn, "nan").expect("list");
        assert!(views.is_empty());
        let messages = list_messages(&conn, 1).expect("list messages");
        assert!(messages.is_empty(), "unknown conversation id yields empty");
    }

    #[test]
    fn create_and_list_most_recent_first_with_fallback_title() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);

        let first = insert_conversation(&conn, "nan", "").expect("insert");
        std::thread::sleep(std::time::Duration::from_millis(5));
        let second = insert_conversation(&conn, "nan", "Pinned topic").expect("insert");

        let views = list_conversations(&conn, "nan").expect("list");
        assert_eq!(views.len(), 2);
        assert_eq!(views[0].id, second, "newest conversation first");
        assert_eq!(views[0].title, "Pinned topic");
        assert_eq!(views[1].id, first);
        // Empty title falls back to a displayable default.
        assert_eq!(views[1].title, UNTITLED_FALLBACK);
        assert_eq!(views[1].last_message, None, "no messages yet, no preview");

        // Another profile's conversations never leak across profiles.
        let other = list_conversations(&conn, "helmcode").expect("list");
        assert!(other.is_empty());
    }

    #[test]
    fn auto_title_replaces_empty_title_and_keeps_set_title() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);

        let id = insert_conversation(&conn, "nan", "").expect("insert");
        set_conversation_title(&conn, id, "How do I stream?").expect("set title");
        let conv = conversation_get(&conn, id).expect("get").expect("exists");
        assert_eq!(conv.title, "How do I stream?");

        // A conversation created with an explicit title keeps it (the
        // auto-title path only fires on the empty title).
        let titled = insert_conversation(&conn, "nan", "Manual title").expect("insert");
        set_conversation_title(&conn, titled, "should not stick in real flow").expect("set runs");
        let conv = conversation_get(&conn, titled)
            .expect("get")
            .expect("exists");
        assert_eq!(conv.title, "should not stick in real flow");

        assert!(conversation_get(&conn, 999).expect("get").is_none());
    }

    #[test]
    fn messages_roundtrip_ascending_with_models() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");

        insert_message(&conn, conv, "user", "hello there", None).expect("insert");
        insert_message(
            &conn,
            conv,
            "assistant",
            "hi! here is code",
            Some("deepseek-v4-flash"),
        )
        .expect("insert");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "user");
        assert_eq!(messages[0].content, "hello there");
        assert_eq!(messages[0].model, None, "user messages carry no model");
        assert!(
            messages[0].id < messages[1].id,
            "ascending transcript order"
        );
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].model.as_deref(), Some("deepseek-v4-flash"));
        assert!(!messages[1].created_at.is_empty());
        // T4b preserve: normal (non-streaming-written) rows stay complete —
        // never flagged as interrupted.
        assert!(!messages[1].partial, "completed rows are not partial");
    }

    #[test]
    fn preview_is_last_message_truncated() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "").expect("insert");

        insert_message(&conn, conv, "user", "first message", None).expect("insert");
        insert_message(&conn, conv, "assistant", "the reply", None).expect("insert");

        let views = list_conversations(&conn, "nan").expect("list");
        assert_eq!(
            views[0].last_message.as_deref(),
            Some("the reply"),
            "preview is the newest message, not the first"
        );

        let long = "x".repeat(PREVIEW_MAX_CHARS + 40);
        insert_message(&conn, conv, "user", &long, None).expect("insert");
        let views = list_conversations(&conn, "nan").expect("list");
        let preview = views[0].last_message.clone().expect("preview");
        assert_eq!(
            preview.chars().count(),
            PREVIEW_MAX_CHARS,
            "truncated to cap"
        );
    }

    #[test]
    fn delete_conversation_removes_messages_too() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_message(&conn, conv, "user", "hello", None).expect("insert");
        insert_message(&conn, conv, "assistant", "hi", Some("m")).expect("insert");

        delete_conversation(&conn, conv).expect("delete");

        assert!(conversation_get(&conn, conv).expect("get").is_none());
        assert!(list_messages(&conn, conv).expect("list").is_empty());
        assert!(list_conversations(&conn, "nan").expect("list").is_empty());
        // Deleting an unknown id is a no-op, not an error.
        delete_conversation(&conn, 424242).expect("delete unknown id");
    }

    // ---- T4b: delta persistence, stop finalize, partial flag ---------------

    /// Simulates the streaming loop: create the in-progress assistant row and
    /// flush received deltas into it.
    fn stream_partial_text(conn: &Connection, conv: i64, flushes: &[&str]) -> i64 {
        let row =
            insert_in_progress_assistant(conn, conv, Some("deepseek-v4-flash")).expect("insert");
        for flush in flushes {
            update_message_content(conn, row, flush).expect("update");
        }
        row
    }

    #[test]
    fn kill_mid_stream_partial_text_survives_without_done() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_message(&conn, conv, "user", "hello", None).expect("insert");

        // The stream task flushes deltas as they arrive…
        stream_partial_text(&conn, conv, &["partial ", "partial text"]);
        // …and the process is killed before any finalize/done runs.

        // The partial reply is still in the DB, flagged as interrupted.
        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 2);
        let last = &messages[1];
        assert_eq!(last.role, "assistant");
        assert_eq!(last.content, "partial text");
        assert_eq!(last.model.as_deref(), Some("deepseek-v4-flash"));
        assert!(last.partial, "an unfinished assistant row is partial");
    }

    #[test]
    fn finalize_message_completes_in_place_with_final_content() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_message(&conn, conv, "user", "hello", None).expect("insert");
        let row = stream_partial_text(&conn, conv, &["partial"]);

        finalize_message(&conn, row, "the complete reply").expect("finalize");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 2, "finalized in place — no duplicate row");
        assert_eq!(messages[1].id, row);
        assert_eq!(messages[1].content, "the complete reply");
        assert_eq!(messages[1].model.as_deref(), Some("deepseek-v4-flash"));
        assert!(!messages[1].partial, "finalize clears the partial flag");
    }

    #[test]
    fn finalize_in_progress_keeps_text_and_is_idempotent() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let row = stream_partial_text(&conn, conv, &["kept text"]);

        let finalized = finalize_in_progress(&conn, conv).expect("finalize");
        assert_eq!(finalized, 1, "exactly the one in-progress row completed");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages[0].id, row);
        assert_eq!(messages[0].content, "kept text", "stop keeps what arrived");
        assert!(!messages[0].partial, "a deliberate stop is not a failure");

        // Stopping again (idle conversation) changes nothing.
        let again = finalize_in_progress(&conn, conv).expect("finalize again");
        assert_eq!(again, 0);
        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages[0].content, "kept text");
        assert!(!messages[0].partial);
    }

    #[test]
    fn delete_message_drops_the_partial_row_on_error() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_message(&conn, conv, "user", "hello", None).expect("insert");
        let row = stream_partial_text(&conn, conv, &["doomed partial"]);

        delete_message(&conn, row).expect("delete");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 1, "only the user message remains");
        assert_eq!(messages[0].role, "user");
    }

    #[test]
    fn legacy_schema_without_status_column_is_migrated() {
        let dir = TempDir::new().expect("temp dir");
        let conn = Connection::open(dir.path().join("legacy.db")).expect("open");
        // The exact pre-T4b schema: `messages` without a `status` column.
        conn.execute_batch(
            "CREATE TABLE conversations (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 title TEXT NOT NULL DEFAULT '',
                 profile_id TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE messages (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 role TEXT NOT NULL,
                 content TEXT NOT NULL,
                 model TEXT,
                 created_at TEXT NOT NULL
             );",
        )
        .expect("legacy schema");
        let conv = insert_conversation(&conn, "nan", "legacy").expect("insert");
        insert_message(&conn, conv, "user", "old message", None).expect("insert");

        // Opening the store with the current schema migrates in place.
        ensure_schema(&conn).expect("migrate");

        // Old rows survive, rendered as complete; new T4b writes work.
        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 1);
        assert!(
            !messages[0].partial,
            "legacy rows are complete, not partial"
        );
        let row = insert_in_progress_assistant(&conn, conv, Some("m")).expect("insert");
        update_message_content(&conn, row, "streamed").expect("update");
        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 2);
        assert!(messages[1].partial);
    }

    // ---- T5: media_path (inline image messages) -------------------------------

    #[test]
    fn image_message_roundtrips_with_media_path() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");

        let row = insert_image_message(
            &conn,
            conv,
            "a cat on a roof at dusk",
            "qwen-image-2.1",
            "/data/images/abc.png",
        )
        .expect("insert image message");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, row);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].content, "a cat on a roof at dusk");
        assert_eq!(messages[0].model.as_deref(), Some("qwen-image-2.1"));
        assert_eq!(
            messages[0].media_path.as_deref(),
            Some("/data/images/abc.png")
        );
        assert!(!messages[0].partial, "image rows are written complete");
    }

    #[test]
    fn plain_messages_list_with_no_media_path() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_message(&conn, conv, "user", "hello", None).expect("insert");
        insert_message(&conn, conv, "assistant", "hi", Some("m")).expect("insert");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 2);
        assert!(messages[0].media_path.is_none(), "user rows carry no media");
        assert!(messages[1].media_path.is_none(), "text rows carry no media");
    }

    #[test]
    fn legacy_schema_without_media_path_column_is_migrated() {
        let dir = TempDir::new().expect("temp dir");
        let conn = Connection::open(dir.path().join("legacy-t5.db")).expect("open");
        // The exact pre-T5 (post-T4b) schema: `status` exists, `media_path`
        // does not.
        conn.execute_batch(
            "CREATE TABLE conversations (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 title TEXT NOT NULL DEFAULT '',
                 profile_id TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE messages (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                 role TEXT NOT NULL,
                 content TEXT NOT NULL,
                 model TEXT,
                 created_at TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'complete'
             );",
        )
        .expect("legacy schema");
        let conv = insert_conversation(&conn, "nan", "legacy").expect("insert");
        insert_message(&conn, conv, "user", "old message", None).expect("insert");

        // Opening the store with the current schema migrates in place.
        ensure_schema(&conn).expect("migrate");

        // Old rows survive with no media; new image rows work.
        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].media_path.is_none());
        insert_image_message(&conn, conv, "a castle", "qwen-image-2.1", "/data/x.png")
            .expect("insert image after migration");
        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1].media_path.as_deref(), Some("/data/x.png"));
    }

    // ---- P1-7: web search sources -------------------------------------------

    #[test]
    fn sources_roundtrip_and_clear() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let row = insert_message(&conn, conv, "assistant", "answer", Some("m")).expect("insert");
        assert!(
            list_messages(&conn, conv).expect("list")[0]
                .sources
                .is_empty()
        );

        let sources = vec![
            WebSource {
                title: "Example".into(),
                url: "https://example.com/a".into(),
            },
            WebSource {
                title: "Other".into(),
                url: "https://example.org/b".into(),
            },
        ];
        set_message_sources(&conn, row, &sources).expect("set");
        assert_eq!(
            list_messages(&conn, conv).expect("list")[0].sources,
            sources
        );

        set_message_sources(&conn, row, &[]).expect("clear");
        assert!(
            list_messages(&conn, conv).expect("list")[0]
                .sources
                .is_empty()
        );
    }

    #[test]
    fn corrupt_sources_json_reads_as_empty() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let row = insert_message(&conn, conv, "assistant", "answer", None).expect("insert");
        conn.execute(
            "UPDATE messages SET sources = 'not json' WHERE id = ?1",
            [row],
        )
        .expect("corrupt");
        assert!(
            list_messages(&conn, conv).expect("list")[0]
                .sources
                .is_empty()
        );
    }

    // ---- P1-6: memory sync helpers ------------------------------------------

    #[test]
    fn new_conversations_get_a_unique_remote_id_and_start_dirty() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        insert_conversation(&conn, "nan", "a").expect("insert");
        insert_conversation(&conn, "nan", "b").expect("insert");
        let sync = list_sync_conversations(&conn, "nan").expect("list");
        assert_eq!(sync.len(), 2);
        assert_ne!(sync[0].remote_id, sync[1].remote_id);
        assert!(sync.iter().all(|c| !c.remote_id.is_empty()));
        assert!(sync.iter().all(SyncConversation::is_dirty), "never synced");
    }

    #[test]
    fn legacy_conversations_are_backfilled_with_remote_ids() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let id = insert_conversation(&conn, "nan", "legacy").expect("insert");
        conn.execute(
            "UPDATE conversations SET remote_id = NULL WHERE id = ?1",
            [id],
        )
        .expect("null");
        let sync = list_sync_conversations(&conn, "nan").expect("list");
        assert_eq!(sync[0].id, id);
        assert!(!sync[0].remote_id.is_empty());
        // Stable: a second listing keeps the same id.
        let again = list_sync_conversations(&conn, "nan").expect("list");
        assert_eq!(again[0].remote_id, sync[0].remote_id);
    }

    #[test]
    fn dirty_tracks_updates_after_the_sync_watermark() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let id = insert_conversation(&conn, "nan", "t").expect("insert");
        let sync = list_sync_conversations(&conn, "nan").expect("list");
        mark_synced(&conn, id, &sync[0].updated_at).expect("mark");
        assert!(!list_sync_conversations(&conn, "nan").expect("list")[0].is_dirty());

        conn.execute(
            "UPDATE conversations SET updated_at = '2999-01-01T00:00:00.000Z' WHERE id = ?1",
            [id],
        )
        .expect("bump");
        assert!(list_sync_conversations(&conn, "nan").expect("list")[0].is_dirty());
    }

    #[test]
    fn in_progress_rows_are_flagged_for_sync() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        assert!(!list_sync_conversations(&conn, "nan").expect("list")[0].has_in_progress);
        insert_in_progress_assistant(&conn, conv, Some("m")).expect("insert");
        assert!(list_sync_conversations(&conn, "nan").expect("list")[0].has_in_progress);
    }

    #[test]
    fn export_excludes_image_and_in_progress_rows() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_message(&conn, conv, "user", "draw a cat", None).expect("insert");
        insert_image_message(&conn, conv, "a cat", "qwen-image-2.1", "/local/cat.png")
            .expect("image");
        insert_message(&conn, conv, "assistant", "done", Some("m")).expect("insert");
        insert_in_progress_assistant(&conn, conv, Some("m")).expect("in progress");

        let exported = export_messages(&conn, conv).expect("export");
        assert_eq!(
            exported
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            vec!["draw a cat", "done"]
        );
        assert!(
            serde_json::to_string(&exported)
                .expect("json")
                .find("/local/cat.png")
                .is_none(),
            "media paths never leave the device"
        );
    }

    #[test]
    fn write_remote_conversation_inserts_then_replaces_text_keeping_images() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let first = vec![MessageRecord {
            role: "user".into(),
            content: "hola".into(),
            model: None,
            created_at: "2026-10-01T00:00:00.000Z".into(),
            sources: vec![],
        }];
        let id = write_remote_conversation(
            &conn,
            None,
            "nan",
            "rid-1",
            "Remote title",
            "2026-10-01T00:00:00.000Z",
            "2026-10-01T00:00:01.000Z",
            &first,
        )
        .expect("insert");
        assert_eq!(
            find_by_remote_id(&conn, "rid-1").expect("find"),
            Some((id, "nan".into()))
        );
        let sync = &list_sync_conversations(&conn, "nan").expect("list")[0];
        assert!(!sync.is_dirty(), "a pulled conversation is already synced");

        insert_image_message(&conn, id, "img", "qwen-image-2.1", "/local/x.png").expect("img");
        let second = vec![
            first[0].clone(),
            MessageRecord {
                role: "assistant".into(),
                content: "¡hola!".into(),
                model: Some("m".into()),
                created_at: "2026-10-02T00:00:00.000Z".into(),
                sources: vec![WebSource {
                    title: "t".into(),
                    url: "https://example.com".into(),
                }],
            },
        ];
        let same = write_remote_conversation(
            &conn,
            Some(id),
            "nan",
            "rid-1",
            "New title",
            "2026-10-01T00:00:00.000Z",
            "2026-10-02T00:00:00.000Z",
            &second,
        )
        .expect("replace");
        assert_eq!(same, id);
        let conv = conversation_get(&conn, id).expect("get").expect("exists");
        assert_eq!(conv.title, "New title");
        assert_eq!(conv.updated_at, "2026-10-02T00:00:00.000Z");
        let messages = list_messages(&conn, id).expect("list");
        assert_eq!(messages.len(), 3, "2 text rows + the kept local image");
        assert_eq!(
            messages.iter().filter(|m| m.media_path.is_some()).count(),
            1
        );
        assert_eq!(messages.last().expect("last").sources.len(), 1);
    }

    #[test]
    fn deleting_a_synced_conversation_leaves_a_tombstone() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let never_synced = insert_conversation(&conn, "nan", "local only").expect("insert");
        let synced = insert_conversation(&conn, "nan", "synced").expect("insert");
        mark_synced(&conn, synced, "2026-10-01T00:00:00.000Z").expect("mark");
        let remote_id = list_sync_conversations(&conn, "nan")
            .expect("list")
            .into_iter()
            .find(|c| c.id == synced)
            .expect("synced row")
            .remote_id;

        delete_conversation(&conn, never_synced).expect("delete");
        assert!(
            list_tombstones(&conn, "nan")
                .expect("tombstones")
                .is_empty()
        );

        delete_conversation(&conn, synced).expect("delete");
        assert_eq!(
            list_tombstones(&conn, "nan").expect("tombstones"),
            vec![remote_id.clone()]
        );
        assert!(
            list_tombstones(&conn, "helmcode")
                .expect("tombstones")
                .is_empty()
        );

        remove_tombstone(&conn, &remote_id).expect("remove");
        assert!(
            list_tombstones(&conn, "nan")
                .expect("tombstones")
                .is_empty()
        );
    }

    #[test]
    fn normalize_timestamp_makes_lexicographic_order_chronological() {
        assert_eq!(
            normalize_timestamp("2026-10-30T12:00:00Z"),
            "2026-10-30T12:00:00.000Z"
        );
        assert_eq!(
            normalize_timestamp("2026-10-30T12:00:00.5+00:00"),
            "2026-10-30T12:00:00.500Z"
        );
        assert_eq!(
            normalize_timestamp("2026-10-30T12:00:00.123456Z"),
            "2026-10-30T12:00:00.123Z"
        );
        assert!(
            normalize_timestamp("2026-10-30T12:00:00Z")
                < normalize_timestamp("2026-10-30T12:00:00.5Z")
        );
        assert_eq!(normalize_timestamp("garbage"), "garbage");
        assert_eq!(
            normalize_timestamp("2026-10-30T12:00:00+02:00"),
            "2026-10-30T12:00:00+02:00",
            "non-UTC offsets are left untouched"
        );
    }

    #[test]
    fn touch_and_explicit_timestamps_order_conversations() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);

        let older = insert_conversation(&conn, "nan", "older").expect("insert");
        let newer = insert_conversation(&conn, "nan", "newer").expect("insert");
        // Force distinct, deterministic timestamps (same-millisecond writes
        // would tie and fall back to id ordering).
        conn.execute(
            "UPDATE conversations SET updated_at = '2026-01-01T00:00:00.000Z' WHERE id = ?1",
            [older],
        )
        .expect("backdate");
        conn.execute(
            "UPDATE conversations SET updated_at = '2026-02-01T00:00:00.000Z' WHERE id = ?1",
            [newer],
        )
        .expect("backdate");
        assert_eq!(
            list_conversations(&conn, "nan")
                .expect("list")
                .iter()
                .map(|v| v.id)
                .collect::<Vec<_>>(),
            vec![newer, older]
        );

        // Touching the older conversation makes it the most recent one.
        conn.execute(
            "UPDATE conversations SET updated_at = '2026-03-01T00:00:00.000Z' WHERE id = ?1",
            [older],
        )
        .expect("forwarddate");
        assert_eq!(
            list_conversations(&conn, "nan")
                .expect("list")
                .iter()
                .map(|v| v.id)
                .collect::<Vec<_>>(),
            vec![older, newer]
        );
    }
}
