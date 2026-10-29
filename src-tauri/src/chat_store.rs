//! Chat persistence (T4, S3): conversations and messages in SQLite.
//!
//! The chat store lives in its own file (`chat.db` in the app data dir) —
//! deliberately separate from the T1 spike's `spike.db` so the demo
//! `messages` table (no conversation/model columns) can never collide with
//! the real schema.
//!
//! All functions are connection-injected pure logic (same pattern as
//! `spike_db`), unit-tested against a temp file — never the real app dir.
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

use rusqlite::Connection;
use serde::Serialize;

/// Message status: the row is finalized (a normal historical message).
pub const STATUS_COMPLETE: &str = "complete";
/// Message status: the assistant reply is still streaming (or the process
/// died mid-stream — a crash leftover flagged `partial` by `messages_list`).
pub const STATUS_IN_PROGRESS: &str = "in_progress";

/// SQLite file name inside the app data dir.
pub const DB_FILE: &str = "chat.db";

/// Fallback title for conversations that have not been auto-titled yet (no
/// first user message seen).
pub const UNTITLED_FALLBACK: &str = "New chat";

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
             created_at TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'complete'
         );
         CREATE INDEX IF NOT EXISTS idx_messages_conversation
             ON messages(conversation_id, id);",
    )?;
    ensure_status_column(conn)
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

/// The newest message of a conversation, if any.
fn last_message(
    conn: &Connection,
    conversation_id: i64,
) -> Result<Option<ChatMessageRow>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, role, content, model, created_at, status
         FROM messages WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 1",
    )?;
    let mut rows = stmt.query_map([conversation_id], |row| {
        Ok(ChatMessageRow {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            model: row.get(4)?,
            created_at: row.get(5)?,
            partial: {
                let status: String = row.get(6)?;
                status == STATUS_IN_PROGRESS
            },
        })
    })?;
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
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, role, content, model, created_at, status
         FROM messages WHERE conversation_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([conversation_id], |row| {
        Ok(ChatMessageRow {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            model: row.get(4)?,
            created_at: row.get(5)?,
            partial: {
                let status: String = row.get(6)?;
                status == STATUS_IN_PROGRESS
            },
        })
    })?;
    let mut messages: Vec<ChatMessageRow> = Vec::new();
    for row in rows {
        messages.push(row?);
    }
    Ok(messages)
}

/// Delete a conversation and (explicitly, before the FK cascade) its
/// messages. Deleting an unknown id is a no-op.
pub fn delete_conversation(conn: &Connection, conversation_id: i64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        [conversation_id],
    )?;
    conn.execute("DELETE FROM conversations WHERE id = ?1", [conversation_id])?;
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
