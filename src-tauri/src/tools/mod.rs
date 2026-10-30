//! Tools subsystem (T8 / spec S7): model-proposes, user-approves, Rust-core-executes.
//!
//! Data flow (the security boundary lives HERE, not in the renderer):
//! 1. `tools_propose` validates and normalizes an action against the user's
//!    folder grants. Nothing is executed. A proposal (exact stored action,
//!    canonical paths) lives in the Rust core for TTL 5 minutes,
//!    single-use.
//! 2. The UI shows the summary + unified diff to the user.
//! 3. `tools_execute` runs ONLY the exact stored action — paths are
//!    re-canonicalized and re-verified under the grant right before use,
//!    so symlink swaps or grant revocations between propose and execute
//!    fail closed. `tools_deny` discards a proposal.
//!
//! Caps (spec S7): read/write ≤ 2 MiB, list depth ≤ 3 / 500 entries,
//! command output ≤ 64 KiB, command timeout 30 s, binary files refused.
//! `run_command` is experimental: OFF by default, gated by
//! `tools_set_run_command_enabled`, per-action approval always applies.
//!
//! Audit: every propose/approve/deny/execute outcome is appended to
//! `tools-audit.log` (paths + summaries only — never file contents).

pub mod audit;
pub mod diff;
pub mod grants;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::profile;
use audit::AuditEntry;
use grants::GrantsStore;

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
}

impl ToolAction {
    pub fn kind(&self) -> &'static str {
        match self {
            ToolAction::ReadFile { .. } => "read_file",
            ToolAction::ListFiles { .. } => "list_files",
            ToolAction::WriteFile { .. } => "write_file",
            ToolAction::ReplaceFile { .. } => "replace_file",
            ToolAction::RunCommand { .. } => "run_command",
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
}

/// A pending proposal held in the Rust core. The renderer only ever sees
/// `ProposalView`; the stored action cannot be modified from outside.
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
    pub created_at: Instant,
}

/// Rust-core state: pending proposals keyed by id.
pub struct ToolsState {
    inner: Mutex<HashMap<String, PendingProposal>>,
    /// TTL for proposals. Tests shrink this to assert expiry.
    pub ttl: Duration,
}

impl Default for ToolsState {
    fn default() -> Self {
        ToolsState {
            inner: Mutex::new(HashMap::new()),
            ttl: PROPOSAL_TTL,
        }
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
}

/// `tools_settings_get` view.
#[derive(Debug, Clone, Serialize)]
pub struct ToolsSettingsView {
    pub tools_allow_run_command: bool,
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
        return Ok((None, " (existing file over cap — no diff)".to_string()));
    }
    let bytes =
        std::fs::read(canonical).map_err(|err| io_rejection("cannot read write target", err))?;
    if is_binary(&bytes) {
        return Ok((None, " (overwrite binary file — no diff)".to_string()));
    }
    match String::from_utf8(bytes) {
        Ok(old) => {
            let diff_text = diff::unified_diff(&canonical.display().to_string(), &old, content);
            Ok((Some(diff_text), String::new()))
        }
        Err(_) => Ok((None, " (overwrite non-UTF-8 file — no diff)".to_string())),
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
            Ok(Validated {
                action: ToolAction::ReadFile {
                    path: canonical.display().to_string(),
                },
                summary: format!("read_file {}", canonical.display()),
                diff: None,
                grant_id: Some(grant_id),
                canonical_path: Some(canonical),
            })
        }
        ToolAction::ListFiles { path } => {
            let (grant_id, canonical) = grants::resolve_under_grant(store, profile_id, path)?;
            Ok(Validated {
                action: ToolAction::ListFiles {
                    path: canonical.display().to_string(),
                },
                summary: format!("list_files {}", canonical.display()),
                diff: None,
                grant_id: Some(grant_id),
                canonical_path: Some(canonical),
            })
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
            Ok(Validated {
                action: ToolAction::WriteFile {
                    path: canonical.display().to_string(),
                    content: content.clone(),
                },
                summary: format!(
                    "write_file {} (+{added} −{removed} lines, {} bytes){note}",
                    canonical.display(),
                    content.len()
                ),
                diff: diff_text,
                grant_id: Some(grant_id),
                canonical_path: Some(canonical),
            })
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
                    format!("old text matches {matches} times — not unique"),
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
            Ok(Validated {
                action: ToolAction::ReplaceFile {
                    path: canonical.display().to_string(),
                    old: old.clone(),
                    new: new.clone(),
                },
                summary: format!(
                    "replace_file {} (+{added} −{removed} lines)",
                    canonical.display()
                ),
                diff: Some(diff_text),
                grant_id: Some(grant_id),
                canonical_path: Some(canonical),
            })
        }
        ToolAction::RunCommand { cmd, cwd_in_grant } => {
            if !store.tools_allow_run_command {
                return Err(Rejection::new(
                    "disabled",
                    "run_command is experimental and disabled — enable it in Tools settings",
                ));
            }
            if cmd.trim().is_empty() {
                return Err(Rejection::new("protocol", "command must not be empty"));
            }
            let (grant_id, canonical) =
                grants::resolve_under_grant(store, profile_id, cwd_in_grant)?;
            Ok(Validated {
                action: ToolAction::RunCommand {
                    cmd: cmd.clone(),
                    cwd_in_grant: canonical.display().to_string(),
                },
                summary: format!("run_command \"{cmd}\" in {}", canonical.display()),
                diff: None,
                grant_id: Some(grant_id),
                canonical_path: Some(canonical),
            })
        }
    }
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
fn reject_protected(dir: &Path, validated: Validated) -> Result<Validated, Rejection> {
    if validated
        .canonical_path
        .as_deref()
        .is_some_and(|path| grants::is_protected(dir, path))
    {
        return Err(Rejection::new(
            "scope",
            "the app's own data folder is off limits to tool actions",
        ));
    }
    Ok(validated)
}

/// Store a proposal (TTL + single-use enforced by the state map).
pub fn propose(
    dir: &Path,
    state: &ToolsState,
    profile_id: &str,
    conversation_id: Option<i64>,
    action: &ToolAction,
) -> Result<PendingProposal, Rejection> {
    if !profile::is_known_profile_id(profile_id) {
        let rejection = Rejection::new("protocol", format!("unknown profile {profile_id}"));
        audit_rejection(dir, action, profile_id, &rejection)?;
        return Err(rejection);
    }
    let store = load_store(dir)?;
    let validated = match validate_action(&store, profile_id, action)
        .and_then(|validated| reject_protected(dir, validated))
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
pub fn execute_proposal(dir: &Path, proposal: &PendingProposal) -> Result<ToolOutcome, Rejection> {
    let store = load_store(dir)?;
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
    if grants::is_protected(dir, canonical) {
        return Err(Rejection::new(
            "scope",
            "the app's own data folder is off limits to tool actions",
        ));
    }
    // Re-verify the exact stored paths against the CURRENT filesystem and
    // the CURRENT grant set before touching anything.
    match &proposal.action {
        ToolAction::ReadFile { .. } | ToolAction::ListFiles { .. } => {
            grants::verify_stable(&grant.canonical_path, canonical)?;
        }
        ToolAction::WriteFile { .. } | ToolAction::ReplaceFile { .. } => {
            grants::verify_writable(&grant.canonical_path, canonical)?;
        }
        ToolAction::RunCommand { cwd_in_grant, .. } => {
            grants::verify_stable(&grant.canonical_path, Path::new(cwd_in_grant))?;
        }
    }
    // Dispatch the EXACT stored action.
    match &proposal.action {
        ToolAction::ReadFile { .. } => exec_read_file(canonical),
        ToolAction::ListFiles { .. } => exec_list_files(canonical),
        ToolAction::WriteFile { content, .. } => exec_write_file(canonical, content),
        ToolAction::ReplaceFile { old, new, .. } => exec_replace_file(canonical, old, new),
        ToolAction::RunCommand { cmd, .. } => {
            let output = run_captured(cmd, canonical, COMMAND_TIMEOUT)?;
            let truncated_note = if output.stdout_truncated || output.stderr_truncated {
                " (output truncated at 64 KiB)"
            } else {
                ""
            };
            Ok(ToolOutcome {
                action: "run_command".into(),
                summary: format!(
                    "{} — exit {}{}{truncated_note}",
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
                ..Default::default()
            })
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
            "list_files {} — {} entries{}",
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
                "proposal expired (TTL 5 minutes) — ask for a new one",
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
    match execute_proposal(dir, &claimed) {
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
/// `async` on purpose (P0-3): see the regression note above.
#[tauri::command]
pub async fn tools_grant_add(
    app: AppHandle,
    profile_id: String,
) -> Result<Option<grants::Grant>, Rejection> {
    use tauri_plugin_dialog::DialogExt;
    let dir = data_dir(&app).map_err(|err| Rejection::new("io", err))?;
    if !profile::is_known_profile_id(&profile_id) {
        return Err(Rejection::new("protocol", "unknown profile"));
    }
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
    Ok(Some(grant))
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
        // B1: enabling the experimental shell escape hatch must be
        // confirmed by a NATIVE dialog the renderer cannot fake.
        let dialog_app = app.clone();
        let confirmed = off_main_thread(move || {
            native_confirm(
                &dialog_app,
                "Ejecutar órdenes (experimental)",
                "El asistente podrá pedirte permiso para EJECUTAR ÓRDENES en tu equipo, \
                 dentro de tus carpetas de trabajo.\n\nUna orden puede hacer cualquier cosa \
                 que harías tú: leer archivos, usar internet o cambiar ajustes. Te pedirá \
                 confirmación antes de cada una.\n\nDéjalo desactivado si no lo necesitas."
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
    }
}

/// The model asked for a tool action during a chat (chat.rs tool loop):
/// propose (grant + scope validation, audit) → NATIVE confirmation for EVERY
/// action, reads included (there is no renderer approval step any more) →
/// execute the exact stored action. A declined dialog is audited as a deny
/// and reported as `declined`.
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
    let (title, text) = confirmation_text(
        &proposal.action,
        &proposal.summary,
        proposal.diff.as_deref(),
    );
    let dialog_app = app.clone();
    let approved = off_main_thread(move || {
        native_confirm(&dialog_app, &title, text, "Permitir", "No permitir")
    })
    .await
    .unwrap_or(false);
    if !approved {
        let state = app.state::<ToolsState>();
        deny(&dir, &state, &proposal.id).map_err(|msg| Rejection::new("io", msg))?;
        return Err(Rejection::new(
            "declined",
            "the user did not allow this action",
        ));
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

/// Where the assistant may work for one profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    /// Canonical grant roots (folders, or `$HOME` in computer-wide mode).
    pub roots: Vec<PathBuf>,
    pub computer_wide: bool,
    pub run_command: bool,
}

/// The profile's workspace, or None when no folder is granted (the chat
/// then offers no file tools at all).
pub fn workspace_from_store(store: &GrantsStore, profile_id: &str) -> Option<Workspace> {
    let roots: Vec<PathBuf> = store
        .grants_for(profile_id)
        .into_iter()
        .map(|grant| grant.canonical_path.clone())
        .collect();
    if roots.is_empty() {
        return None;
    }
    Some(Workspace {
        roots,
        computer_wide: store.computer_wide_grant(profile_id).is_some(),
        run_command: store.tools_allow_run_command,
    })
}

/// [`workspace_from_store`] against the app's own tools store.
pub(crate) fn workspace_for(app: &AppHandle, profile_id: &str) -> Option<Workspace> {
    let dir = data_dir(app).ok()?;
    let store = grants::load_or_seed(&dir).ok()?;
    workspace_from_store(&store, profile_id)
}

// --------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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
        ];
        for (json, kind) in cases {
            let action = parse_action(json).expect("parse");
            assert_eq!(action.kind(), kind);
        }
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
            inner: Mutex::new(HashMap::new()),
            ttl: Duration::ZERO,
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
    fn run_command_disabled_by_default() {
        let (folder, _guard) = tempdir();
        let (dir, _guard2) = granted_dir(&folder);
        let store = grants::load_or_seed(&dir).expect("store");
        assert!(!store.tools_allow_run_command, "default must be OFF");
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
}
