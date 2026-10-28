//! SQLite demo for the T1 spike: local conversation-history foundation (S3).
//!
//! The logic is kept out of the Tauri command so it can be unit-tested
//! against a temp file instead of the real app data dir.

use rusqlite::Connection;
use serde::Serialize;

/// A chat message row, as returned by the demo command.
#[derive(Debug, PartialEq, Serialize)]
pub struct Message {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

/// Create the `messages` table if missing, insert one row and return the
/// last 10 messages ordered by ascending id.
pub fn insert_and_recent_messages(
    conn: &mut Connection,
    role: &str,
    content: &str,
) -> Result<Vec<Message>, rusqlite::Error> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "INSERT INTO messages (role, content, created_at) VALUES (?1, ?2, datetime('now'))",
        [role, content],
    )?;

    let mut stmt = conn
        .prepare("SELECT id, role, content, created_at FROM messages ORDER BY id DESC LIMIT 10")?;
    let rows = stmt.query_map([], |row| {
        Ok(Message {
            id: row.get(0)?,
            role: row.get(1)?,
            content: row.get(2)?,
            created_at: row.get(3)?,
        })
    })?;

    let mut messages: Vec<Message> = Vec::new();
    for row in rows {
        messages.push(row?);
    }
    // The query returns DESC; reverse so callers get ascending order by id.
    messages.reverse();
    Ok(messages)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn open_temp_db(dir: &TempDir) -> Connection {
        Connection::open(dir.path().join("spike-test.db")).expect("open temp db")
    }

    #[test]
    fn creates_table_and_inserts_one_row_per_call() {
        let dir = TempDir::new().expect("temp dir");
        let mut conn = open_temp_db(&dir);

        let first =
            insert_and_recent_messages(&mut conn, "assistant", "demo 1").expect("first call");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, 1);
        assert_eq!(first[0].role, "assistant");
        assert_eq!(first[0].content, "demo 1");
        assert!(!first[0].created_at.is_empty());

        let second =
            insert_and_recent_messages(&mut conn, "assistant", "demo 2").expect("second call");
        assert_eq!(second.len(), 2);
        assert_eq!(second[1].id, 2);
        assert_eq!(second[1].content, "demo 2");
    }

    #[test]
    fn returns_at_most_last_ten_rows_ascending() {
        let dir = TempDir::new().expect("temp dir");
        let mut conn = open_temp_db(&dir);

        let mut last = Vec::new();
        for n in 1..=12 {
            last = insert_and_recent_messages(&mut conn, "assistant", &format!("demo {n}"))
                .expect("insert");
        }

        assert_eq!(last.len(), 10);
        assert_eq!(last[0].id, 3);
        assert_eq!(last[9].id, 12);
        assert_eq!(last[9].content, "demo 12");
        for window in last.windows(2) {
            assert!(window[0].id < window[1].id, "rows must be ascending by id");
        }
    }
}
