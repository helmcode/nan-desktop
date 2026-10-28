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

use rusqlite::Connection;
use serde::Serialize;

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
             created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_messages_conversation
             ON messages(conversation_id, id);",
    )
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
        "SELECT id, conversation_id, role, content, model, created_at
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
        "SELECT id, conversation_id, role, content, model, created_at
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
