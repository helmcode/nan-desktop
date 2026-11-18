//! Chat persistence (T4, S3): conversations and messages in SQLite.
//!
//! The chat store lives in its own file: `chat.db` inside the signed-in
//! user's realm folder (`<app data>/realms/<hash>/chat.db`, see `realm.rs`).
//! A pre-realm `<app data>/chat.db` is split per profile into the first
//! bound realm by [`claim_profile`].
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
//!
//! Turn continuity: every assistant reply records WHY its turn ended
//! (`end_reason`: `completed`, `tool_cap`, `stream_cut`, `length`,
//! `user_stop`; NULL for rows written before this existed and for crash
//! leftovers) so the UI can offer to continue after a reload, and the tool
//! exchange of the turn (`tool_trace`: the OpenAI-shaped assistant
//! `tool_calls` and `tool` result messages, results already truncated) so
//! the next turn can replay it. Both are device-local: they never reach
//! the renderer as trace text (`tool_trace` is not serialized) nor the
//! account (memory sync exports text rows only and keeps both columns of
//! replies still present when a remote copy overwrites the rows).

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

/// How many of a conversation's newest assistant replies keep their tool
/// trace (raw tool output, possibly sensitive file content). Older traces
/// are deleted: only these are ever replayed (`turn::REPLAY_TURNS`).
pub const TRACE_KEEP_TURNS: usize = 2;

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
    /// messages (`<uuid>.png` or, for FLUX JPEGs, `<uuid>.jpg`). `None` for
    /// every text row; the renderer
    /// loads the file through the asset protocol (never the raw bytes).
    pub media_path: Option<String>,
    /// P1-7: web search sources cited by this assistant reply (empty for
    /// every other row).
    pub sources: Vec<WebSource>,
    /// Round 3: files the reply's tool actions produced (preview chips) and
    /// images it generated (shown inline). Empty for every other row.
    pub artifacts: Vec<Artifact>,
    /// Image edit lineage: the message whose image was the edit's source
    /// (an image row or a tool reply carrying an image artifact). `None` for
    /// every other row, and for edits made only from picked local files.
    pub parent_message_id: Option<i64>,
    /// Why this assistant reply's turn ended (`completed`, `tool_cap`,
    /// `stream_cut`, `length`, `user_stop`). `None` for user rows, older
    /// replies and crash leftovers.
    pub end_reason: Option<String>,
    /// The turn's tool exchange as a JSON array of OpenAI messages, replayed
    /// to the model on the next turns. Device-local and never sent to the
    /// renderer (it carries raw tool output; S16).
    #[serde(skip)]
    pub tool_trace: Option<String>,
    /// Files attached to a user message (device-local). The renderer gets
    /// views without the extracted document text.
    #[serde(serialize_with = "crate::attachments::serialize_views")]
    pub attachments: Vec<crate::attachments::AttachmentRecord>,
}

/// What a produced artifact is: a file inside the user's folders (opened in
/// the preview pane) or a generated image under `app_data/images` (shown
/// inline through the asset protocol).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    File,
    Image,
}

/// One file a reply produced, by absolute path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    pub path: String,
    pub kind: ArtifactKind,
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
    ensure_column(conn, "messages", "artifacts", "TEXT")?;
    ensure_column(conn, "messages", "parent_message_id", "INTEGER")?;
    ensure_column(conn, "messages", "end_reason", "TEXT")?;
    ensure_column(conn, "messages", "tool_trace", "TEXT")?;
    ensure_column(conn, "messages", "attachments", "TEXT")?;
    ensure_column(conn, "conversations", "remote_id", "TEXT")?;
    ensure_column(conn, "conversations", "synced_at", "TEXT")?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_remote_id
             ON conversations(remote_id);",
    )?;
    // Retention: databases written before pruning existed (or a crash
    // between finalize and prune) lose the traces no turn will replay.
    prune_tool_traces(conn, None)?;
    Ok(())
}

/// Delete the tool trace of every assistant reply except the
/// [`TRACE_KEEP_TURNS`] newest of its conversation (`conversation_id`), or
/// of every conversation (`None`). Returns how many traces were deleted.
pub fn prune_tool_traces(
    conn: &Connection,
    conversation_id: Option<i64>,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET tool_trace = NULL
         WHERE tool_trace IS NOT NULL
           AND (?1 IS NULL OR conversation_id = ?1)
           AND id NOT IN (
               SELECT newest.id FROM messages AS newest
               WHERE newest.conversation_id = messages.conversation_id
                 AND newest.role = 'assistant'
               ORDER BY newest.id DESC
               LIMIT ?2
           )",
        rusqlite::params![conversation_id, TRACE_KEEP_TURNS as i64],
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

/// Table written INSIDE a realm chat database when the legacy rows of a
/// profile were fully copied into it (the claim marker). Its presence is
/// what allows [`claim_profile`] to prune the legacy rows.
const CLAIM_TABLE: &str = "realm_claim";

/// Privacy fix (realms): move every row of `profile_id` from the pre-realm
/// `<root>/chat.db` into `<realm_dir>/chat.db`, without duplicating them and
/// without ever losing one.
///
/// The legacy rows are deleted ONLY when the realm database carries the
/// claim marker for this profile (a `realm_claim` row recording how many
/// conversations, messages and tombstones were copied). The marker is
/// written in the same unit as the copy, so its presence proves the copy is
/// complete:
///
/// - no realm database yet: the copy is built as a temp file (`VACUUM
///   INTO`, then the OTHER profiles' rows are deleted and the file vacuumed
///   so no freed page keeps their text), the marker is written into it, and
///   only then is it renamed into place;
/// - a realm database WITHOUT the marker (an earlier claim failed, e.g. the
///   disk filled up during `VACUUM INTO`, and the user chatted afterwards so
///   the realm file was created empty): the claim is resumed by merging the
///   legacy rows into it (new ids, see [`merge_legacy_rows`]) and writing
///   the marker, in ONE transaction;
/// - a realm database WITH the marker (the copy landed, the prune did not):
///   only the prune runs.
///
/// Every interruption therefore leaves the legacy rows in place for the
/// next login. The moved rows are then deleted from the legacy file
/// (vacuumed too); a legacy file left with no rows at all is removed.
/// Returns whether any row was moved. Never touches a realm database of
/// another user.
pub fn claim_profile(
    root: &std::path::Path,
    realm_dir: &std::path::Path,
    profile_id: &str,
) -> Result<bool, String> {
    let legacy_path = root.join(DB_FILE);
    if !legacy_path.is_file() {
        return Ok(false);
    }
    let legacy = open_db(root)?;
    let owned: i64 = legacy
        .query_row(
            "SELECT (SELECT COUNT(*) FROM conversations WHERE profile_id = ?1)
                  + (SELECT COUNT(*) FROM memory_tombstones WHERE profile_id = ?1)",
            [profile_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    if owned == 0 {
        return Ok(false);
    }
    std::fs::create_dir_all(realm_dir).map_err(|err| err.to_string())?;
    let dest = realm_dir.join(DB_FILE);
    if dest.exists() {
        let mut realm = open_db(realm_dir)?;
        if !has_claim_marker(&realm, profile_id).map_err(|err| err.to_string())? {
            merge_legacy_rows(&mut realm, &legacy_path, profile_id)
                .map_err(|err| err.to_string())?;
        }
    } else {
        let tmp = realm_dir.join(format!("{DB_FILE}.claim.tmp"));
        let _ = std::fs::remove_file(&tmp);
        let built = (|| -> Result<(), rusqlite::Error> {
            legacy.execute("VACUUM INTO ?1", [tmp.to_string_lossy().as_ref()])?;
            let copy = Connection::open(&tmp)?;
            copy.execute_batch("PRAGMA foreign_keys = ON;")?;
            delete_profile_rows(&copy, profile_id, false)?;
            copy.execute_batch("VACUUM;")?;
            write_claim_marker(&copy, profile_id)?;
            Ok(())
        })();
        if let Err(err) = built {
            let _ = std::fs::remove_file(&tmp);
            return Err(err.to_string());
        }
        std::fs::rename(&tmp, &dest).map_err(|err| err.to_string())?;
    }
    delete_profile_rows(&legacy, profile_id, true).map_err(|err| err.to_string())?;
    legacy
        .execute_batch("VACUUM;")
        .map_err(|err| err.to_string())?;
    let left: i64 = legacy
        .query_row(
            "SELECT (SELECT COUNT(*) FROM conversations) + (SELECT COUNT(*) FROM memory_tombstones)",
            [],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    drop(legacy);
    if left == 0 {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let _ = std::fs::remove_file(root.join(format!("{DB_FILE}{suffix}")));
        }
    }
    Ok(true)
}

/// Whether `conn` carries the claim marker of `profile_id`.
fn has_claim_marker(conn: &Connection, profile_id: &str) -> Result<bool, rusqlite::Error> {
    let table: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [CLAIM_TABLE],
        |row| row.get(0),
    )?;
    if table == 0 {
        return Ok(false);
    }
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {CLAIM_TABLE} WHERE profile_id = ?1"),
        [profile_id],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
}

/// Record that every legacy row of `profile_id` is now in `conn`, with the
/// counts it holds for that profile (audit trail of the completed claim).
fn write_claim_marker(conn: &Connection, profile_id: &str) -> Result<(), rusqlite::Error> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {CLAIM_TABLE} (
             profile_id TEXT PRIMARY KEY,
             conversations INTEGER NOT NULL,
             messages INTEGER NOT NULL,
             tombstones INTEGER NOT NULL,
             completed_at TEXT NOT NULL
         );"
    ))?;
    conn.execute(
        &format!(
            "INSERT OR REPLACE INTO {CLAIM_TABLE}
                 (profile_id, conversations, messages, tombstones, completed_at)
             VALUES (?1,
                 (SELECT COUNT(*) FROM conversations WHERE profile_id = ?1),
                 (SELECT COUNT(*) FROM messages WHERE conversation_id IN
                     (SELECT id FROM conversations WHERE profile_id = ?1)),
                 (SELECT COUNT(*) FROM memory_tombstones WHERE profile_id = ?1),
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
        ),
        [profile_id],
    )?;
    Ok(())
}

/// The column names of `table` in the main database, minus `skip`.
fn columns_except(
    conn: &Connection,
    table: &str,
    skip: &[&str],
) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(names
        .into_iter()
        .filter(|name| !skip.contains(&name.as_str()))
        .collect())
}

/// Resume an interrupted claim: copy every legacy row of `profile_id` into
/// the (unmarked) realm database `realm` and write the claim marker, all in
/// one transaction (a failure rolls back to the realm file as it was, the
/// legacy rows stay). Rows get new ids; message `parent_message_id`s are
/// remapped (to NULL when their parent was not copied). A conversation whose
/// `remote_id` already exists in the realm with at least as many messages is
/// the same synced conversation and is skipped, so a retry never
/// duplicates; with FEWER messages both are kept (the legacy one under a
/// new remote id), never one dropped.
fn merge_legacy_rows(
    realm: &mut Connection,
    legacy_path: &std::path::Path,
    profile_id: &str,
) -> Result<(), rusqlite::Error> {
    use std::collections::HashMap;
    realm.execute(
        "ATTACH DATABASE ?1 AS legacy",
        [legacy_path.to_string_lossy().as_ref()],
    )?;
    let merged = (|| -> Result<(), rusqlite::Error> {
        let tx = realm.transaction()?;
        let conv_cols = columns_except(&tx, "conversations", &["id"])?.join(", ");
        let unsynced_cols =
            columns_except(&tx, "conversations", &["id", "remote_id", "synced_at"])?.join(", ");
        let msg_cols = columns_except(
            &tx,
            "messages",
            &["id", "conversation_id", "parent_message_id"],
        )?
        .join(", ");
        let conversations: Vec<(i64, Option<String>)> = {
            let mut stmt = tx.prepare(
                "SELECT id, remote_id FROM legacy.conversations WHERE profile_id = ?1 ORDER BY id",
            )?;
            stmt.query_map([profile_id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?
        };
        let mut message_ids: HashMap<i64, i64> = HashMap::new();
        let mut parents: Vec<(i64, i64)> = Vec::new();
        for (old_conv, remote_id) in conversations {
            let mut clash = false;
            if let Some(remote_id) = &remote_id {
                // Messages the realm copy of this synced conversation is
                // missing (None: the realm does not have it).
                let missing: Option<i64> = tx
                    .query_row(
                        "SELECT (SELECT COUNT(*) FROM legacy.messages WHERE conversation_id = ?2)
                              - (SELECT COUNT(*) FROM main.messages WHERE conversation_id = c.id)
                         FROM main.conversations c WHERE c.remote_id = ?1",
                        rusqlite::params![remote_id, old_conv],
                        |row| row.get(0),
                    )
                    .optional()?;
                match missing {
                    Some(missing) if missing <= 0 => continue,
                    Some(_) => clash = true,
                    None => {}
                }
            }
            // On a clash the realm's copy has fewer messages: keep both
            // rather than drop any. The legacy one is copied without its
            // sync identity and gets a fresh remote id later (backfill), so
            // the two never collide on sync.
            let cols = if clash { &unsynced_cols } else { &conv_cols };
            tx.execute(
                &format!(
                    "INSERT INTO main.conversations ({cols})
                     SELECT {cols} FROM legacy.conversations WHERE id = ?1"
                ),
                [old_conv],
            )?;
            let new_conv = tx.last_insert_rowid();
            let messages: Vec<(i64, Option<i64>)> = {
                let mut stmt = tx.prepare(
                    "SELECT id, parent_message_id FROM legacy.messages
                     WHERE conversation_id = ?1 ORDER BY id",
                )?;
                stmt.query_map([old_conv], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect::<Result<_, _>>()?
            };
            for (old_msg, parent) in messages {
                tx.execute(
                    &format!(
                        "INSERT INTO main.messages (conversation_id, {msg_cols})
                         SELECT ?1, {msg_cols} FROM legacy.messages WHERE id = ?2"
                    ),
                    [new_conv, old_msg],
                )?;
                let new_msg = tx.last_insert_rowid();
                message_ids.insert(old_msg, new_msg);
                if let Some(parent) = parent {
                    parents.push((new_msg, parent));
                }
            }
        }
        for (new_msg, old_parent) in parents {
            if let Some(new_parent) = message_ids.get(&old_parent) {
                tx.execute(
                    "UPDATE main.messages SET parent_message_id = ?1 WHERE id = ?2",
                    [*new_parent, new_msg],
                )?;
            }
        }
        tx.execute(
            "INSERT OR IGNORE INTO main.memory_tombstones (remote_id, profile_id)
             SELECT remote_id, profile_id FROM legacy.memory_tombstones WHERE profile_id = ?1",
            [profile_id],
        )?;
        write_claim_marker(&tx, profile_id)?;
        tx.commit()
    })();
    let detached = realm.execute("DETACH DATABASE legacy", []);
    merged?;
    detached.map(|_| ())
}

/// Delete the rows of `profile_id` (`matching = true`) or of every OTHER
/// profile (`matching = false`): messages first, then conversations, then
/// memory tombstones.
fn delete_profile_rows(
    conn: &Connection,
    profile_id: &str,
    matching: bool,
) -> Result<(), rusqlite::Error> {
    let op = if matching { "=" } else { "!=" };
    conn.execute(
        &format!(
            "DELETE FROM messages WHERE conversation_id IN
                 (SELECT id FROM conversations WHERE profile_id {op} ?1)"
        ),
        [profile_id],
    )?;
    conn.execute(
        &format!("DELETE FROM conversations WHERE profile_id {op} ?1"),
        [profile_id],
    )?;
    conn.execute(
        &format!("DELETE FROM memory_tombstones WHERE profile_id {op} ?1"),
        [profile_id],
    )?;
    Ok(())
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

/// The model of the newest assistant reply of a conversation, if any.
pub fn last_assistant_model(
    conn: &Connection,
    conversation_id: i64,
) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row(
        "SELECT model FROM messages WHERE conversation_id = ?1 AND role = 'assistant'
         ORDER BY id DESC LIMIT 1",
        [conversation_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
}

/// Insert a user message with its attachments (device-local JSON column).
pub fn insert_user_message_with_attachments(
    conn: &Connection,
    conversation_id: i64,
    content: &str,
    attachments: &[crate::attachments::AttachmentRecord],
) -> Result<i64, rusqlite::Error> {
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, created_at, attachments)
         VALUES (?1, 'user', ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?3)",
        rusqlite::params![
            conversation_id,
            content,
            crate::attachments::encode_records(attachments)
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Store the description of one image attachment of a message (the side
/// request finished). Read-modify-write of the JSON column; `false` when the
/// message or the attachment is gone.
pub fn set_attachment_description(
    conn: &Connection,
    message_id: i64,
    attachment_id: &str,
    description: &str,
) -> Result<bool, rusqlite::Error> {
    let raw: Option<Option<String>> = conn
        .query_row(
            "SELECT attachments FROM messages WHERE id = ?1",
            [message_id],
            |row| row.get(0),
        )
        .optional()?;
    let mut records = crate::attachments::decode_records(raw.flatten());
    let Some(record) = records.iter_mut().find(|r| r.id == attachment_id) else {
        return Ok(false);
    };
    record.description = Some(description.to_string());
    conn.execute(
        "UPDATE messages SET attachments = ?1 WHERE id = ?2",
        rusqlite::params![crate::attachments::encode_records(&records), message_id],
    )?;
    Ok(true)
}

/// Flag images a vision model rejected (400): later requests send their
/// stand-in. Unknown messages or attachments are skipped.
pub fn mark_images_vision_rejected(
    conn: &Connection,
    images: &[(i64, String)],
) -> Result<(), rusqlite::Error> {
    for (message_id, attachment_id) in images {
        let raw: Option<Option<String>> = conn
            .query_row(
                "SELECT attachments FROM messages WHERE id = ?1",
                [message_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut records = crate::attachments::decode_records(raw.flatten());
        let Some(record) = records.iter_mut().find(|r| &r.id == attachment_id) else {
            continue;
        };
        record.vision_rejected = true;
        conn.execute(
            "UPDATE messages SET attachments = ?1 WHERE id = ?2",
            rusqlite::params![crate::attachments::encode_records(&records), message_id],
        )?;
    }
    Ok(())
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

/// Insert an assistant image row produced by an image EDIT: like
/// [`insert_image_message`] (`content` = the edit instruction, `model` = the
/// edit model, `media_path` = the saved result) plus the lineage link to the
/// message the source image came from. A `parent_message_id` that is not a
/// row of `conversation_id` is refused (`QueryReturnedNoRows`): lineage
/// never crosses conversations.
pub fn insert_edited_image_message(
    conn: &Connection,
    conversation_id: i64,
    content: &str,
    model: &str,
    media_path: &str,
    parent_message_id: Option<i64>,
) -> Result<i64, rusqlite::Error> {
    if let Some(parent) = parent_message_id
        && !message_in_conversation(conn, conversation_id, parent)?
    {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    conn.execute(
        "INSERT INTO messages (conversation_id, role, content, model, media_path, created_at, status, parent_message_id)
         VALUES (?1, 'assistant', ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?5, ?6)",
        rusqlite::params![
            conversation_id,
            content,
            model,
            media_path,
            STATUS_COMPLETE,
            parent_message_id
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Whether `message_id` is a row of `conversation_id`.
pub fn message_in_conversation(
    conn: &Connection,
    conversation_id: i64,
    message_id: i64,
) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages WHERE id = ?1 AND conversation_id = ?2)",
        rusqlite::params![message_id, conversation_id],
        |row| row.get::<_, bool>(0),
    )
}

/// Whether any message still references a file by its name (round 6, the
/// orphan-image sweep): the `media_path` of image rows, the `artifacts`
/// JSON of tool replies, or the reply text itself (the model is told the
/// path and may quote it). A plain substring match on the raw columns, so a
/// row whose artifacts JSON no longer parses still keeps its files.
pub fn references_file_name(conn: &Connection, file_name: &str) -> Result<bool, rusqlite::Error> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM messages
             WHERE instr(COALESCE(media_path, ''), ?1) > 0
                OR instr(COALESCE(artifacts, ''), ?1) > 0
                OR instr(COALESCE(attachments, ''), ?1) > 0
                OR instr(content, ?1) > 0)",
        [file_name],
        |row| row.get::<_, bool>(0),
    )
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
/// whatever text arrived stays, with no failed marker, and the rows record
/// `end_reason` (the stop reason). Returns the number of rows completed (0
/// when there was nothing in progress).
pub fn finalize_in_progress(
    conn: &Connection,
    conversation_id: i64,
    end_reason: &str,
) -> Result<usize, rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET status = ?1, end_reason = ?4 WHERE conversation_id = ?2 AND status = ?3",
        rusqlite::params![
            STATUS_COMPLETE,
            conversation_id,
            STATUS_IN_PROGRESS,
            end_reason
        ],
    )
}

/// Record why an assistant reply's turn ended.
pub fn set_message_end_reason(
    conn: &Connection,
    message_id: i64,
    end_reason: &str,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET end_reason = ?1 WHERE id = ?2",
        rusqlite::params![end_reason, message_id],
    )?;
    Ok(())
}

/// Store the turn's tool exchange (a JSON array). `None` clears it.
/// Written after every complete tool round, so a stopped turn keeps the
/// rounds that finished.
pub fn set_message_tool_trace(
    conn: &Connection,
    message_id: i64,
    trace: Option<&str>,
) -> Result<(), rusqlite::Error> {
    conn.execute(
        "UPDATE messages SET tool_trace = ?1 WHERE id = ?2",
        rusqlite::params![trace, message_id],
    )?;
    Ok(())
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

/// Attach the files/images a reply produced (round 3). An empty slice
/// clears them (NULL).
pub fn set_message_artifacts(
    conn: &Connection,
    message_id: i64,
    artifacts: &[Artifact],
) -> Result<(), rusqlite::Error> {
    let json = if artifacts.is_empty() {
        None
    } else {
        Some(serde_json::to_string(artifacts).unwrap_or_else(|_| "[]".to_string()))
    };
    conn.execute(
        "UPDATE messages SET artifacts = ?1 WHERE id = ?2",
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
            // A message with only attachments previews their names.
            let preview = if last.content.trim().is_empty() && !last.attachments.is_empty() {
                last.attachments
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                last.content
            };
            view.last_message = Some(truncate_chars(&preview, PREVIEW_MAX_CHARS));
        }
    }
    Ok(views)
}

/// Column list read by [`map_message_row`] (order matters).
const MESSAGE_COLUMNS: &str = "id, conversation_id, role, content, model, media_path, created_at, status, sources, artifacts, parent_message_id, end_reason, tool_trace, attachments";

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
        artifacts: row
            .get::<_, Option<String>>(9)?
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default(),
        parent_message_id: row.get(10)?,
        end_reason: row.get(11)?,
        tool_trace: row.get(12)?,
        attachments: crate::attachments::decode_records(row.get(13)?),
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
            // Attachments never travel: their text placeholder does.
            content: crate::attachments::sync_content(&row.content, &row.attachments),
            model: row.model,
            created_at: row.created_at,
            sources: row.sources,
        })
        .collect())
}

/// Device-local columns of a text row, kept across a remote overwrite when
/// the same message (role, content, instant) is still in the remote copy.
struct KeptLocal {
    role: String,
    content: String,
    created_at: String,
    artifacts: Option<String>,
    end_reason: Option<String>,
    tool_trace: Option<String>,
    attachments: Option<String>,
}

impl KeptLocal {
    /// Whether `message` (from the remote copy) is this local row. A row
    /// with attachments was uploaded as its text plus placeholders
    /// ([`crate::attachments::sync_content`]); a description that arrived
    /// after the upload may have changed the placeholder, so its text
    /// PREFIX is what must match.
    fn matches(&self, message: &MessageRecord, created: &str) -> bool {
        if self.role != message.role || self.created_at != created {
            return false;
        }
        match &self.attachments {
            Some(_) => message.content.starts_with(&self.content),
            None => self.content == message.content,
        }
    }
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
    // Artifacts (produced files / generated images) are device-local paths
    // that never travel to the account; remember them per text row so the
    // overwrite below does not silently drop the chips/inline images of
    // replies that are still present in the remote copy (round 4). The
    // turn end reason and the tool trace are device-local too and kept the
    // same way.
    let mut kept_local: Vec<KeptLocal> = Vec::new();
    let id = match local_id {
        Some(id) => {
            {
                let mut stmt = tx.prepare(
                    "SELECT role, content, created_at, artifacts, end_reason, tool_trace, attachments FROM messages
                     WHERE conversation_id = ?1 AND media_path IS NULL
                       AND (artifacts IS NOT NULL OR end_reason IS NOT NULL OR tool_trace IS NOT NULL
                            OR attachments IS NOT NULL)",
                )?;
                let rows = stmt.query_map([id], |row| {
                    Ok(KeptLocal {
                        role: row.get(0)?,
                        content: row.get(1)?,
                        created_at: normalize_timestamp(&row.get::<_, String>(2)?),
                        artifacts: row.get(3)?,
                        end_reason: row.get(4)?,
                        tool_trace: row.get(5)?,
                        attachments: row.get(6)?,
                    })
                })?;
                for row in rows {
                    kept_local.push(row?);
                }
            }
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
        let created = normalize_timestamp(&message.created_at);
        let matched = kept_local
            .iter()
            .position(|kept| kept.matches(message, &created));
        let kept = matched.map(|index| kept_local.swap_remove(index));
        // A row with attachments keeps its LOCAL text (the remote copy has
        // the placeholders appended) and its attachments.
        let (content, artifacts, end_reason, tool_trace, attachments) = match kept {
            Some(kept) if kept.attachments.is_some() => (
                kept.content,
                kept.artifacts,
                kept.end_reason,
                kept.tool_trace,
                kept.attachments,
            ),
            Some(kept) => (
                message.content.clone(),
                kept.artifacts,
                kept.end_reason,
                kept.tool_trace,
                None,
            ),
            None => (message.content.clone(), None, None, None, None),
        };
        tx.execute(
            "INSERT INTO messages (conversation_id, role, content, model, created_at, status, sources, artifacts, end_reason, tool_trace, attachments)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                id,
                message.role,
                content,
                message.model,
                message.created_at,
                STATUS_COMPLETE,
                sources,
                artifacts,
                end_reason,
                tool_trace,
                attachments
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

    // ---- privacy fix: per-user realms (legacy chat.db split) -------------

    /// A pre-realm chat.db holding both tenants' conversations.
    fn legacy_db(root: &std::path::Path) {
        let conn = open_db(root).expect("legacy db");
        let nan = insert_conversation(&conn, "nan", "nan secret plans").unwrap();
        insert_message(&conn, nan, "user", "NAN-PRIVATE-TEXT", None).unwrap();
        let helm = insert_conversation(&conn, "helmcode", "helm roadmap").unwrap();
        insert_message(&conn, helm, "user", "HELM-PRIVATE-TEXT", None).unwrap();
        conn.execute(
            "INSERT INTO memory_tombstones (remote_id, profile_id) VALUES ('r-nan', 'nan'), ('r-helm', 'helmcode')",
            [],
        )
        .unwrap();
    }

    fn file_contains(path: &std::path::Path, needle: &str) -> bool {
        let bytes = std::fs::read(path).unwrap_or_default();
        bytes.windows(needle.len()).any(|w| w == needle.as_bytes())
    }

    #[test]
    fn claim_moves_one_profile_into_its_realm_and_scrubs_the_other() {
        let root = TempDir::new().unwrap();
        legacy_db(root.path());
        let realm = root.path().join("realms").join("a".repeat(32));

        assert!(claim_profile(root.path(), &realm, "nan").expect("claim"));

        let mine = open_db(&realm).unwrap();
        let listed = list_conversations(&mine, "nan").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "nan secret plans");
        let rows = list_messages(&mine, listed[0].id).unwrap();
        assert_eq!(rows[0].content, "NAN-PRIVATE-TEXT");
        assert!(list_conversations(&mine, "helmcode").unwrap().is_empty());
        assert_eq!(
            list_tombstones(&mine, "nan").unwrap(),
            vec!["r-nan".to_string()]
        );
        assert!(list_tombstones(&mine, "helmcode").unwrap().is_empty());
        drop(mine);
        // Not a byte of the other tenant's text survives in the realm file.
        assert!(!file_contains(&realm.join(DB_FILE), "HELM-PRIVATE-TEXT"));

        // Moved, not duplicated: the legacy file keeps only helmcode.
        let legacy = open_db(root.path()).unwrap();
        assert!(list_conversations(&legacy, "nan").unwrap().is_empty());
        assert_eq!(list_conversations(&legacy, "helmcode").unwrap().len(), 1);
        assert!(list_tombstones(&legacy, "nan").unwrap().is_empty());
        drop(legacy);
        assert!(!file_contains(
            &root.path().join(DB_FILE),
            "NAN-PRIVATE-TEXT"
        ));
        // A second claim of the same profile moves nothing more.
        assert!(!claim_profile(root.path(), &realm, "nan").unwrap());
    }

    #[test]
    fn claiming_the_last_profile_removes_the_legacy_file() {
        let root = TempDir::new().unwrap();
        legacy_db(root.path());
        let a = root.path().join("realms").join("a".repeat(32));
        let h = root.path().join("realms").join("b".repeat(32));
        assert!(claim_profile(root.path(), &a, "nan").unwrap());
        assert!(claim_profile(root.path(), &h, "helmcode").unwrap());
        assert!(!root.path().join(DB_FILE).exists(), "nothing left: removed");
        let helm = open_db(&h).unwrap();
        assert_eq!(list_conversations(&helm, "helmcode").unwrap().len(), 1);
        assert!(list_conversations(&helm, "nan").unwrap().is_empty());
    }

    #[test]
    fn claim_without_a_legacy_file_or_rows_is_a_no_op() {
        let root = TempDir::new().unwrap();
        let realm = root.path().join("realms").join("c".repeat(32));
        assert!(!claim_profile(root.path(), &realm, "nan").unwrap());
        assert!(!realm.join(DB_FILE).exists());
        // A legacy file with only the other tenant's rows: nothing moves.
        let conn = open_db(root.path()).unwrap();
        insert_conversation(&conn, "helmcode", "h").unwrap();
        drop(conn);
        assert!(!claim_profile(root.path(), &realm, "nan").unwrap());
        assert!(!realm.join(DB_FILE).exists());
    }

    fn titles(conn: &Connection, profile_id: &str) -> Vec<String> {
        let mut titles: Vec<String> = list_conversations(conn, profile_id)
            .unwrap()
            .into_iter()
            .map(|c| c.title)
            .collect();
        titles.sort();
        titles
    }

    fn all_contents(conn: &Connection, profile_id: &str) -> Vec<String> {
        let mut out = Vec::new();
        for conv in list_conversations(conn, profile_id).unwrap() {
            for row in list_messages(conn, conv.id).unwrap() {
                out.push(row.content);
            }
        }
        out.sort();
        out
    }

    #[test]
    fn a_completed_claim_carries_the_marker() {
        let root = TempDir::new().unwrap();
        legacy_db(root.path());
        let realm = root.path().join("realms").join("m".repeat(32));
        assert!(claim_profile(root.path(), &realm, "nan").unwrap());
        let mine = open_db(&realm).unwrap();
        assert!(has_claim_marker(&mine, "nan").unwrap());
        assert!(!has_claim_marker(&mine, "helmcode").unwrap());
        let counts: (i64, i64, i64) = mine
            .query_row(
                "SELECT conversations, messages, tombstones FROM realm_claim WHERE profile_id = 'nan'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(counts, (1, 1, 1));
    }

    #[test]
    fn a_marked_realm_copy_only_prunes() {
        // The rename landed (marker inside) but the prune did not: the
        // retry must not rebuild, merge into or overwrite the realm copy.
        let root = TempDir::new().unwrap();
        legacy_db(root.path());
        let realm = root.path().join("realms").join("d".repeat(32));
        let existing = open_db(&realm).unwrap();
        insert_conversation(&existing, "nan", "already moved").unwrap();
        write_claim_marker(&existing, "nan").unwrap();
        drop(existing);

        assert!(claim_profile(root.path(), &realm, "nan").unwrap());
        let mine = open_db(&realm).unwrap();
        assert_eq!(titles(&mine, "nan"), vec!["already moved".to_string()]);
        let legacy = open_db(root.path()).unwrap();
        assert!(list_conversations(&legacy, "nan").unwrap().is_empty());
    }

    #[test]
    fn an_unmarked_realm_db_is_merged_never_pruned_blindly() {
        // An earlier claim failed before the rename; the user then chatted,
        // which created an EMPTY realm db. The next claim must keep both
        // the new chat and the whole legacy history.
        let root = TempDir::new().unwrap();
        legacy_db(root.path());
        let realm = root.path().join("realms").join("e".repeat(32));
        let partial = open_db(&realm).unwrap();
        let after = insert_conversation(&partial, "nan", "chat after the failure").unwrap();
        insert_message(&partial, after, "user", "NEW-TEXT", None).unwrap();
        drop(partial);

        assert!(claim_profile(root.path(), &realm, "nan").unwrap());
        let mine = open_db(&realm).unwrap();
        assert_eq!(
            titles(&mine, "nan"),
            vec![
                "chat after the failure".to_string(),
                "nan secret plans".to_string()
            ]
        );
        assert_eq!(
            all_contents(&mine, "nan"),
            vec!["NAN-PRIVATE-TEXT".to_string(), "NEW-TEXT".to_string()]
        );
        assert_eq!(
            list_tombstones(&mine, "nan").unwrap(),
            vec!["r-nan".to_string()]
        );
        assert!(list_conversations(&mine, "helmcode").unwrap().is_empty());
        assert!(has_claim_marker(&mine, "nan").unwrap());
        drop(mine);
        assert!(!file_contains(&realm.join(DB_FILE), "HELM-PRIVATE-TEXT"));
        // Only now is the legacy copy pruned; a retry moves nothing more.
        let legacy = open_db(root.path()).unwrap();
        assert!(list_conversations(&legacy, "nan").unwrap().is_empty());
        assert_eq!(list_conversations(&legacy, "helmcode").unwrap().len(), 1);
        drop(legacy);
        assert!(!claim_profile(root.path(), &realm, "nan").unwrap());
        assert_eq!(titles(&open_db(&realm).unwrap(), "nan").len(), 2);
    }

    #[test]
    fn an_aborted_copy_keeps_the_legacy_history_and_the_next_login_recovers_it() {
        // ENOSPC-style abort: the temp copy cannot be written (here its
        // path is a directory), so `VACUUM INTO` fails mid-claim.
        let root = TempDir::new().unwrap();
        legacy_db(root.path());
        let realm = root.path().join("realms").join("f".repeat(32));
        let blocker = realm.join(format!("{DB_FILE}.claim.tmp"));
        std::fs::create_dir_all(&blocker).unwrap();

        assert!(claim_profile(root.path(), &realm, "nan").is_err());
        assert!(!realm.join(DB_FILE).exists(), "no half copy in place");
        let legacy = open_db(root.path()).unwrap();
        assert_eq!(
            all_contents(&legacy, "nan"),
            vec!["NAN-PRIVATE-TEXT".to_string()]
        );
        assert_eq!(
            list_tombstones(&legacy, "nan").unwrap(),
            vec!["r-nan".to_string()]
        );
        drop(legacy);

        // Worst interleaving: the user still reached the chat and wrote
        // into a new, unmarked realm db before the disk was freed.
        let partial = open_db(&realm).unwrap();
        insert_conversation(&partial, "nan", "written meanwhile").unwrap();
        drop(partial);
        std::fs::remove_dir(&blocker).unwrap();

        assert!(claim_profile(root.path(), &realm, "nan").unwrap());
        let mine = open_db(&realm).unwrap();
        assert_eq!(
            titles(&mine, "nan"),
            vec![
                "nan secret plans".to_string(),
                "written meanwhile".to_string()
            ]
        );
        assert_eq!(
            all_contents(&mine, "nan"),
            vec!["NAN-PRIVATE-TEXT".to_string()]
        );
        assert_eq!(
            list_tombstones(&mine, "nan").unwrap(),
            vec!["r-nan".to_string()]
        );
    }

    #[test]
    fn a_merge_that_fails_midway_rolls_back_and_prunes_nothing() {
        let root = TempDir::new().unwrap();
        legacy_db(root.path());
        let legacy = open_db(root.path()).unwrap();
        let conv = list_conversations(&legacy, "nan").unwrap()[0].id;
        insert_message(&legacy, conv, "assistant", "SECOND-MESSAGE", None).unwrap();
        drop(legacy);
        let realm = root.path().join("realms").join("g".repeat(32));
        let partial = open_db(&realm).unwrap();
        insert_conversation(&partial, "nan", "written meanwhile").unwrap();
        // The disk "fills up" on the second copied message.
        partial
            .execute_batch(
                "CREATE TRIGGER full_disk BEFORE INSERT ON messages
                 WHEN NEW.content = 'SECOND-MESSAGE'
                 BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END;",
            )
            .unwrap();
        drop(partial);

        assert!(claim_profile(root.path(), &realm, "nan").is_err());
        let mine = open_db(&realm).unwrap();
        assert_eq!(titles(&mine, "nan"), vec!["written meanwhile".to_string()]);
        assert!(!has_claim_marker(&mine, "nan").unwrap());
        mine.execute_batch("DROP TRIGGER full_disk;").unwrap();
        drop(mine);
        let legacy = open_db(root.path()).unwrap();
        assert_eq!(
            all_contents(&legacy, "nan"),
            vec!["NAN-PRIVATE-TEXT".to_string(), "SECOND-MESSAGE".to_string()]
        );
        drop(legacy);

        assert!(claim_profile(root.path(), &realm, "nan").unwrap());
        let mine = open_db(&realm).unwrap();
        assert_eq!(
            all_contents(&mine, "nan"),
            vec!["NAN-PRIVATE-TEXT".to_string(), "SECOND-MESSAGE".to_string()]
        );
        assert_eq!(titles(&mine, "nan").len(), 2);
    }

    #[test]
    fn a_merge_remaps_ids_and_dedupes_synced_conversations() {
        let root = TempDir::new().unwrap();
        let legacy = open_db(root.path()).unwrap();
        let synced = insert_conversation(&legacy, "nan", "synced").unwrap();
        insert_message(&legacy, synced, "user", "S1", None).unwrap();
        let longer = insert_conversation(&legacy, "nan", "longer here").unwrap();
        insert_message(&legacy, longer, "user", "L1", None).unwrap();
        insert_message(&legacy, longer, "assistant", "L2", None).unwrap();
        let edits = insert_conversation(&legacy, "nan", "edits").unwrap();
        let source = insert_message(&legacy, edits, "assistant", "SOURCE", None).unwrap();
        let edit = insert_message(&legacy, edits, "assistant", "EDIT", None).unwrap();
        legacy
            .execute(
                "UPDATE messages SET parent_message_id = ?1 WHERE id = ?2",
                [source, edit],
            )
            .unwrap();
        legacy
            .execute_batch(
                "UPDATE conversations SET remote_id = 'r-synced' WHERE title = 'synced';
                 UPDATE conversations SET remote_id = 'r-longer' WHERE title = 'longer here';",
            )
            .unwrap();
        drop(legacy);
        // The realm db already pulled both synced conversations (ids shifted
        // by a conversation of its own), the second one with fewer messages.
        let realm = root.path().join("realms").join("h".repeat(32));
        let partial = open_db(&realm).unwrap();
        insert_conversation(&partial, "nan", "own").unwrap();
        let pulled = insert_conversation(&partial, "nan", "synced").unwrap();
        insert_message(&partial, pulled, "user", "S1", None).unwrap();
        let short = insert_conversation(&partial, "nan", "longer here").unwrap();
        partial
            .execute_batch(&format!(
                "UPDATE conversations SET remote_id = 'r-synced' WHERE id = {pulled};
                 UPDATE conversations SET remote_id = 'r-longer' WHERE id = {short};"
            ))
            .unwrap();
        drop(partial);

        assert!(claim_profile(root.path(), &realm, "nan").unwrap());
        let mine = open_db(&realm).unwrap();
        // "synced" is not duplicated; the shorter "longer here" copy is kept
        // AND the legacy one is added (no message lost).
        assert_eq!(
            titles(&mine, "nan"),
            vec![
                "edits".to_string(),
                "longer here".to_string(),
                "longer here".to_string(),
                "own".to_string(),
                "synced".to_string()
            ]
        );
        let remote_ids: i64 = mine
            .query_row(
                "SELECT COUNT(*) FROM conversations WHERE remote_id = 'r-longer'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(remote_ids, 1, "the added copy never reuses the remote id");
        // The edit lineage points at the copied source, not the old id.
        let (edit_parent, source_id): (i64, i64) = mine
            .query_row(
                "SELECT e.parent_message_id, s.id FROM messages e, messages s
                 WHERE e.content = 'EDIT' AND s.content = 'SOURCE'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(edit_parent, source_id);
    }

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

        let finalized = finalize_in_progress(&conn, conv, "user_stop").expect("finalize");
        assert_eq!(finalized, 1, "exactly the one in-progress row completed");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages[0].id, row);
        assert_eq!(messages[0].content, "kept text", "stop keeps what arrived");
        assert!(!messages[0].partial, "a deliberate stop is not a failure");
        assert_eq!(
            messages[0].end_reason.as_deref(),
            Some("user_stop"),
            "the stop is recorded as the turn's end reason"
        );

        // Stopping again (idle conversation) changes nothing.
        let again = finalize_in_progress(&conn, conv, "user_stop").expect("finalize again");
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

    // ---- image edits: child rows linked to their source message --------------

    #[test]
    fn edited_image_is_a_child_row_linked_to_its_parent() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let parent = insert_image_message(&conn, conv, "a fox", "qwen-image-2.1", "/d/a.png")
            .expect("parent");

        let child = insert_edited_image_message(
            &conn,
            conv,
            "make it snowy",
            "qwen-image-3.0-pro",
            "/d/b.png",
            Some(parent),
        )
        .expect("child");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].parent_message_id, None,
            "originals have no parent"
        );
        assert_eq!(messages[1].id, child);
        assert_eq!(messages[1].role, "assistant");
        assert_eq!(messages[1].content, "make it snowy");
        assert_eq!(messages[1].model.as_deref(), Some("qwen-image-3.0-pro"));
        assert_eq!(messages[1].media_path.as_deref(), Some("/d/b.png"));
        assert_eq!(messages[1].parent_message_id, Some(parent));
        assert!(!messages[1].partial);
    }

    #[test]
    fn edited_image_without_a_parent_is_allowed_for_picked_files() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_edited_image_message(&conn, conv, "brighter", "m", "/d/c.png", None)
            .expect("insert");
        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages[0].parent_message_id, None);
        assert_eq!(messages[0].media_path.as_deref(), Some("/d/c.png"));
    }

    #[test]
    fn edit_lineage_never_crosses_conversations() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let a = insert_conversation(&conn, "nan", "a").expect("a");
        let b = insert_conversation(&conn, "nan", "b").expect("b");
        let foreign = insert_image_message(&conn, a, "x", "m", "/d/x.png").expect("x");

        assert!(message_in_conversation(&conn, a, foreign).expect("query"));
        assert!(!message_in_conversation(&conn, b, foreign).expect("query"));
        assert!(
            insert_edited_image_message(&conn, b, "edit", "m", "/d/y.png", Some(foreign)).is_err(),
            "a parent from another conversation is refused"
        );
        assert!(
            insert_edited_image_message(&conn, b, "edit", "m", "/d/y.png", Some(9999)).is_err(),
            "a missing parent is refused"
        );
        assert!(
            list_messages(&conn, b).expect("list").is_empty(),
            "nothing written"
        );
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

    // ---- Round 3: produced files / generated images ---------------------------

    #[test]
    fn artifacts_roundtrip_clear_and_tolerate_corrupt_json() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let row = insert_message(&conn, conv, "assistant", "hecho", Some("m")).expect("insert");
        assert!(
            list_messages(&conn, conv).expect("list")[0]
                .artifacts
                .is_empty()
        );

        let artifacts = vec![
            Artifact {
                path: "/u/web/index.html".into(),
                kind: ArtifactKind::File,
            },
            Artifact {
                path: "/data/images/a.png".into(),
                kind: ArtifactKind::Image,
            },
        ];
        set_message_artifacts(&conn, row, &artifacts).expect("set");
        assert_eq!(
            list_messages(&conn, conv).expect("list")[0].artifacts,
            artifacts
        );
        // Wire shape the renderer reads.
        assert_eq!(
            serde_json::to_value(&artifacts[1]).expect("json"),
            serde_json::json!({ "path": "/data/images/a.png", "kind": "image" })
        );

        set_message_artifacts(&conn, row, &[]).expect("clear");
        assert!(
            list_messages(&conn, conv).expect("list")[0]
                .artifacts
                .is_empty()
        );

        conn.execute(
            "UPDATE messages SET artifacts = 'not json' WHERE id = ?1",
            [row],
        )
        .expect("corrupt");
        assert!(
            list_messages(&conn, conv).expect("list")[0]
                .artifacts
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

    fn attached(
        kind: crate::attachments::AttachmentKind,
        id: &str,
        name: &str,
    ) -> crate::attachments::AttachmentRecord {
        crate::attachments::AttachmentRecord {
            id: id.into(),
            kind,
            name: name.into(),
            size: 3,
            path: kind
                .is_image()
                .then(|| format!("/local/images/attachments/{id}.jpg")),
            text: (!kind.is_image()).then(|| "PRIVATE EXTRACTED TEXT".to_string()),
            truncated: false,
            description: None,
            vision_rejected: false,
        }
    }

    #[test]
    fn attachments_persist_reach_the_renderer_as_views_and_sync_as_placeholders() {
        use crate::attachments::AttachmentKind;
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let records = vec![
            attached(AttachmentKind::Pdf, "d1", "plan.pdf"),
            attached(AttachmentKind::Image, "i1", "cat.jpg"),
        ];
        let row =
            insert_user_message_with_attachments(&conn, conv, "look", &records).expect("insert");
        let listed = list_messages(&conn, conv).expect("list");
        assert_eq!(
            listed[0].attachments, records,
            "history keeps the extracted text"
        );
        let json = serde_json::to_string(&listed[0]).expect("json");
        assert!(json.contains("\"attachments\":[{\"id\":\"d1\""), "{json}");
        assert!(
            !json.contains("PRIVATE"),
            "the renderer never gets extracted text"
        );

        assert!(set_attachment_description(&conn, row, "i1", "A cat.").expect("set"));
        assert!(!set_attachment_description(&conn, row, "nope", "x").expect("set"));
        assert!(!set_attachment_description(&conn, 9999, "i1", "x").expect("set"));
        let listed = list_messages(&conn, conv).expect("list");
        assert_eq!(
            listed[0].attachments[1].description.as_deref(),
            Some("A cat.")
        );

        let exported = export_messages(&conn, conv).expect("export");
        assert_eq!(
            exported[0].content,
            "look\n\n[Attached file: plan.pdf]\n[Image: cat.jpg]"
        );
        let wire = serde_json::to_string(&exported).expect("json");
        assert!(
            !wire.contains("PRIVATE") && !wire.contains("/local/"),
            "{wire}"
        );

        // A file attached on its own previews its name in the list.
        let views = list_conversations(&conn, "nan").expect("views");
        assert_eq!(views[0].last_message.as_deref(), Some("look"));
        insert_user_message_with_attachments(&conn, conv, "", &records[..1]).expect("insert");
        let views = list_conversations(&conn, "nan").expect("views");
        assert_eq!(views[0].last_message.as_deref(), Some("plan.pdf"));
        // The orphan sweep sees attachment files as referenced.
        assert!(references_file_name(&conn, "i1.jpg").expect("refs"));
    }

    #[test]
    fn rejected_images_are_remembered() {
        use crate::attachments::AttachmentKind;
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let records = vec![
            attached(AttachmentKind::Image, "i1", "a.jpg"),
            attached(AttachmentKind::Image, "i2", "b.jpg"),
        ];
        let row = insert_user_message_with_attachments(&conn, conv, "x", &records).expect("insert");
        mark_images_vision_rejected(&conn, &[(row, "i2".into()), (999, "zz".into())])
            .expect("mark");
        let listed = list_messages(&conn, conv).expect("list");
        assert!(!listed[0].attachments[0].vision_rejected);
        assert!(listed[0].attachments[1].vision_rejected);
        let json = serde_json::to_string(&listed[0]).expect("json");
        assert!(!json.contains("vision_rejected"), "device-local detail");
    }

    #[test]
    fn the_last_reply_model_drives_a_continuation() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        assert_eq!(last_assistant_model(&conn, conv).expect("q"), None);
        insert_message(&conn, conv, "user", "hi", None).expect("insert");
        insert_message(&conn, conv, "assistant", "a", Some("glm5.3")).expect("insert");
        insert_message(&conn, conv, "assistant", "b", Some("glm5.3-flash")).expect("insert");
        assert_eq!(
            last_assistant_model(&conn, conv).expect("q").as_deref(),
            Some("glm5.3-flash")
        );
    }

    #[test]
    fn a_remote_overwrite_keeps_the_local_text_and_attachments_of_a_row() {
        use crate::attachments::AttachmentKind;
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let records = vec![attached(AttachmentKind::Image, "i1", "cat.jpg")];
        insert_user_message_with_attachments(&conn, conv, "look", &records).expect("insert");
        let mut remote = export_messages(&conn, conv).expect("export");
        // Uploaded before the description arrived; then the description is
        // stored locally and another device adds a reply.
        let row = list_messages(&conn, conv).expect("list")[0].id;
        set_attachment_description(&conn, row, "i1", "A cat.").expect("set");
        remote.push(MessageRecord {
            role: "assistant".into(),
            content: "Nice cat".into(),
            model: None,
            created_at: "2026-11-18T10:00:00.000Z".into(),
            sources: vec![],
        });
        write_remote_conversation(
            &conn,
            Some(conv),
            "nan",
            "r1",
            "t",
            "2026-01-01",
            "2026-12-01",
            &remote,
        )
        .expect("write");
        let listed = list_messages(&conn, conv).expect("list");
        assert_eq!(
            listed[0].content, "look",
            "the local text, not the placeholder copy"
        );
        assert_eq!(listed[0].attachments.len(), 1);
        assert_eq!(
            listed[0].attachments[0].description.as_deref(),
            Some("A cat.")
        );
        assert_eq!(listed[1].content, "Nice cat");
        // A remote-only message with placeholders stays plain text.
        let other = vec![MessageRecord {
            role: "user".into(),
            content: "[Image: x.jpg]".into(),
            model: None,
            created_at: "2026-11-18T11:00:00.000Z".into(),
            sources: vec![],
        }];
        write_remote_conversation(
            &conn,
            Some(conv),
            "nan",
            "r1",
            "t",
            "2026-01-01",
            "2026-12-02",
            &other,
        )
        .expect("write");
        let listed = list_messages(&conn, conv).expect("list");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].attachments.is_empty());
        assert_eq!(listed[0].content, "[Image: x.jpg]");
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
    fn memory_sync_overwrite_keeps_the_artifacts_of_replies_still_present() {
        // Round 4: a reply that produced a PDF (+ a generated image) is
        // exported to the account WITHOUT its device-local artifacts; when
        // the remote copy comes back and overwrites the text rows, the
        // chips/inline image of that reply must survive.
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_message(&conn, conv, "user", "hazme un pdf", None).expect("user");
        let reply =
            insert_message(&conn, conv, "assistant", "PDF listo.", Some("m")).expect("reply");
        let artifacts = vec![
            Artifact {
                path: "/Users/ana/Proyecto/informe.pdf".into(),
                kind: ArtifactKind::File,
            },
            Artifact {
                path: "/data/images/portada.png".into(),
                kind: ArtifactKind::Image,
            },
        ];
        set_message_artifacts(&conn, reply, &artifacts).expect("set");

        // Exactly what the sync uploads, plus one new remote message, with
        // a timestamp spelled differently (no millis) to prove the match
        // is on the normalized instant.
        let mut remote = export_messages(&conn, conv).expect("export");
        assert!(remote.iter().all(|m| !m.content.contains("informe.pdf")));
        let reply_created = remote[1].created_at.clone();
        if let Some(stripped) = reply_created.strip_suffix(".000Z") {
            remote[1].created_at = format!("{stripped}Z");
        }
        remote.push(MessageRecord {
            role: "user".into(),
            content: "gracias".into(),
            model: None,
            created_at: "2099-01-01T00:00:00.000Z".into(),
            sources: vec![],
        });
        write_remote_conversation(
            &conn,
            Some(conv),
            "nan",
            "rid-art",
            "t",
            "2026-10-01T00:00:00.000Z",
            "2099-01-01T00:00:00.000Z",
            &remote,
        )
        .expect("overwrite");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 3);
        let kept = messages
            .iter()
            .find(|m| m.content == "PDF listo.")
            .expect("reply row");
        assert_eq!(kept.artifacts, artifacts, "artifacts survived the sync");
        assert!(
            messages
                .iter()
                .filter(|m| m.content != "PDF listo.")
                .all(|m| m.artifacts.is_empty())
        );

        // A reply the remote copy no longer has takes its artifacts with it.
        write_remote_conversation(
            &conn,
            Some(conv),
            "nan",
            "rid-art",
            "t",
            "2026-10-01T00:00:00.000Z",
            "2099-01-02T00:00:00.000Z",
            &remote[..1],
        )
        .expect("overwrite 2");
        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages.len(), 1);
        assert!(messages[0].artifacts.is_empty());
    }

    #[test]
    fn end_reason_and_tool_trace_roundtrip_and_the_trace_never_reaches_the_ui() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let user = insert_message(&conn, conv, "user", "build it", None).expect("user");
        let reply = insert_in_progress_assistant(&conn, conv, Some("m")).expect("reply");
        let trace = r#"[{"role":"tool","tool_call_id":"c1","content":"SECRET_OUTPUT"}]"#;
        set_message_tool_trace(&conn, reply, Some(trace)).expect("trace");
        finalize_message(&conn, reply, "done so far").expect("finalize");
        set_message_end_reason(&conn, reply, "tool_cap").expect("reason");

        let messages = list_messages(&conn, conv).expect("list");
        assert_eq!(messages[0].id, user);
        assert_eq!(messages[0].end_reason, None, "user rows carry no reason");
        assert_eq!(messages[1].end_reason.as_deref(), Some("tool_cap"));
        assert_eq!(messages[1].tool_trace.as_deref(), Some(trace));

        let json = serde_json::to_string(&messages).expect("serialize");
        assert!(json.contains("\"end_reason\":\"tool_cap\""));
        assert!(!json.contains("tool_trace"), "no trace field over IPC");
        assert!(!json.contains("SECRET_OUTPUT"), "no tool output over IPC");

        set_message_tool_trace(&conn, reply, None).expect("clear");
        assert_eq!(
            list_messages(&conn, conv).expect("list")[1].tool_trace,
            None
        );
    }

    #[test]
    fn only_the_newest_replies_keep_their_tool_trace() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        let other = insert_conversation(&conn, "nan", "other").expect("insert");
        let other_reply = insert_message(&conn, other, "assistant", "x", None).expect("o");
        set_message_tool_trace(&conn, other_reply, Some("[]")).expect("trace");
        let mut replies = Vec::new();
        for turn in 0..3 {
            insert_message(&conn, conv, "user", &format!("turn {turn}"), None).expect("user");
            let reply = insert_message(&conn, conv, "assistant", "r", None).expect("reply");
            set_message_tool_trace(&conn, reply, Some(r#"[{"role":"tool","content":".env"}]"#))
                .expect("trace");
            replies.push(reply);
        }
        assert_eq!(prune_tool_traces(&conn, Some(conv)).expect("prune"), 1);
        let traces: Vec<Option<String>> = list_messages(&conn, conv)
            .expect("list")
            .into_iter()
            .filter(|m| m.role == "assistant")
            .map(|m| m.tool_trace)
            .collect();
        assert_eq!(traces[0], None, "the oldest trace is deleted");
        assert!(
            traces[1].is_some() && traces[2].is_some(),
            "the 2 newest stay"
        );
        assert!(
            list_messages(&conn, other).expect("list")[0]
                .tool_trace
                .is_some(),
            "other conversations are untouched"
        );

        // Opening the store prunes every conversation (older databases).
        set_message_tool_trace(&conn, replies[0], Some("[]")).expect("re-add");
        drop(conn);
        let conn = open_temp_db(&dir);
        assert_eq!(
            list_messages(&conn, conv).expect("list")[1].tool_trace,
            None,
            "pruned on open"
        );
    }

    #[test]
    fn legacy_schema_without_turn_columns_is_migrated() {
        let dir = TempDir::new().expect("temp dir");
        let conn = Connection::open(dir.path().join("legacy.db")).expect("open");
        // A database from before turn continuity: no end_reason/tool_trace.
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
                 media_path TEXT,
                 created_at TEXT NOT NULL,
                 status TEXT NOT NULL DEFAULT 'complete'
             );
             INSERT INTO conversations (title, profile_id, created_at, updated_at)
                 VALUES ('old', 'nan', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
             INSERT INTO messages (conversation_id, role, content, created_at)
                 VALUES (1, 'assistant', 'old reply', '2026-01-01T00:00:00.000Z');",
        )
        .expect("legacy schema");
        ensure_schema(&conn).expect("migrate");
        ensure_schema(&conn).expect("migrating twice is a no-op");

        let messages = list_messages(&conn, 1).expect("list");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "old reply");
        assert_eq!(messages[0].end_reason, None);
        assert_eq!(messages[0].tool_trace, None);
        set_message_end_reason(&conn, messages[0].id, "completed").expect("new column writable");
    }

    #[test]
    fn memory_sync_never_exports_and_never_drops_the_local_turn_columns() {
        let dir = TempDir::new().expect("temp dir");
        let conn = open_temp_db(&dir);
        let conv = insert_conversation(&conn, "nan", "t").expect("insert");
        insert_message(&conn, conv, "user", "scrape it", None).expect("user");
        let reply = insert_message(&conn, conv, "assistant", "half way", Some("m")).expect("reply");
        let trace = r#"[{"role":"tool","tool_call_id":"c1","content":"LOCAL_ONLY"}]"#;
        set_message_tool_trace(&conn, reply, Some(trace)).expect("trace");
        set_message_end_reason(&conn, reply, "tool_cap").expect("reason");

        let remote = export_messages(&conn, conv).expect("export");
        let uploaded = serde_json::to_string(&remote).expect("serialize export");
        assert!(!uploaded.contains("LOCAL_ONLY"), "traces never travel");
        assert!(!uploaded.contains("tool_cap"), "end reasons never travel");

        write_remote_conversation(
            &conn,
            Some(conv),
            "nan",
            "rid-turn",
            "t",
            "2026-10-01T00:00:00.000Z",
            "2099-01-01T00:00:00.000Z",
            &remote,
        )
        .expect("overwrite");
        let messages = list_messages(&conn, conv).expect("list");
        let kept = messages
            .iter()
            .find(|m| m.content == "half way")
            .expect("reply");
        assert_eq!(kept.end_reason.as_deref(), Some("tool_cap"));
        assert_eq!(kept.tool_trace.as_deref(), Some(trace));
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
