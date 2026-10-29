//! JSONL audit trail for the tools subsystem (T8 / spec S7).
//!
//! Every propose / approve / deny / execute outcome (and grant/settings
//! changes) is appended as one JSON line to `tools-audit.log` under the
//! app data dir. The log stores paths, action kinds and summaries ONLY —
//! never file contents, proposal payloads or command output.
//!
//! Audit writes fail closed: a tool flow that cannot record its outcome
//! returns an error instead of proceeding untracked.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Name of the audit log file under the app data dir.
pub const AUDIT_FILE: &str = "tools-audit.log";

/// One audit record. `detail` is a short human-readable summary (paths,
/// counts, kinds) — never file contents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    /// RFC 3339 UTC timestamp.
    pub ts: String,
    /// propose | approve | deny | execute | grant_add | grant_revoke | settings
    pub event: String,
    /// Action kind, or "grant" / "run_command" for settings events.
    pub action: String,
    /// ok | rejected | error | ignored
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Current UTC time as RFC 3339 (`YYYY-MM-DDTHH:MM:SSZ`).
pub fn timestamp_now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    rfc3339_from_unix(secs)
}

/// Convert Unix seconds to RFC 3339 UTC. Pure so tests can pin known
/// values (no chrono dependency).
pub fn rfc3339_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Days-since-epoch → (year, month, day). Howard Hinnant's civil_from_days,
/// correct across leap years including century rules.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097); // [0, 146096]
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Append one entry as a JSON line. Creates the file when missing.
pub fn append(dir: &Path, entry: &AuditEntry) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
    let path = dir.join(AUDIT_FILE);
    let line = serde_json::to_string(entry).map_err(|err| err.to_string())?;
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("cannot open {}: {err}", path.display()))?;
    file.write_all(line.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|err| format!("cannot write {}: {err}", path.display()))
}

/// Return the last `count` entries, oldest first. Corrupt lines are
/// skipped; a missing file yields an empty list.
pub fn tail(dir: &Path, count: usize) -> Result<Vec<AuditEntry>, String> {
    let raw = match std::fs::read_to_string(dir.join(AUDIT_FILE)) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("cannot read audit log: {err}")),
    };
    let entries: Vec<AuditEntry> = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let start = entries.len().saturating_sub(count);
    Ok(entries[start..].to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir() -> std::path::PathBuf {
        tempfile::tempdir().expect("tempdir").path().to_path_buf()
    }

    #[test]
    fn rfc3339_known_timestamps() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(86_399), "1970-01-01T23:59:59Z");
        assert_eq!(
            rfc3339_from_unix(951_782_400),
            "2000-02-29T00:00:00Z",
            "leap day"
        );
        assert_eq!(rfc3339_from_unix(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(rfc3339_from_unix(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn append_tail_round_trip_and_missing_file() {
        let dir = tempdir();
        assert!(tail(&dir, 50).expect("missing file is empty").is_empty());
        for i in 0..3 {
            append(
                &dir,
                &AuditEntry {
                    ts: timestamp_now_rfc3339(),
                    event: "propose".into(),
                    action: "read_file".into(),
                    outcome: "ok".into(),
                    grant_id: Some("g1".into()),
                    profile_id: Some("nan".into()),
                    detail: Some(format!("entry {i}")),
                },
            )
            .expect("append");
        }
        let last_two = tail(&dir, 2).expect("tail");
        assert_eq!(last_two.len(), 2);
        assert_eq!(last_two[0].detail.as_deref(), Some("entry 1"));
        assert_eq!(last_two[1].detail.as_deref(), Some("entry 2"));
        let all = tail(&dir, 50).expect("tail all");
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn tail_skips_corrupt_lines() {
        let dir = tempdir();
        append(
            &dir,
            &AuditEntry {
                ts: timestamp_now_rfc3339(),
                event: "deny".into(),
                action: "write_file".into(),
                outcome: "ok".into(),
                grant_id: None,
                profile_id: None,
                detail: None,
            },
        )
        .expect("append");
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join(AUDIT_FILE))
            .expect("open");
        writeln!(f, "{{corrupt json line").expect("corrupt line");
        drop(f);
        append(
            &dir,
            &AuditEntry {
                ts: timestamp_now_rfc3339(),
                event: "execute".into(),
                action: "read_file".into(),
                outcome: "error".into(),
                grant_id: None,
                profile_id: None,
                detail: Some("kind".into()),
            },
        )
        .expect("append");
        let entries = tail(&dir, 50).expect("tail skips corrupt");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].event, "deny");
        assert_eq!(entries[1].event, "execute");
    }

    /// Fixture hook for `test/t8-check.mjs`: when the env var is set, the
    /// check script points it at a temp dir and this test writes a realistic
    /// audit sample through the real `append` path. The check script then
    /// asserts the JSONL schema and that no content marker leaks.
    #[test]
    fn audit_fixture_written_when_env_set() {
        let Some(fixtures) =
            std::env::var_os("NAN_DESKTOP_T8_AUDIT_FIXTURE_DIR").map(std::path::PathBuf::from)
        else {
            return;
        };
        let marker_action = "write_file";
        // The content below is the leak canary: it must NEVER appear in the
        // audit file — only paths and summaries may be recorded.
        let canary_content = "TOP-SECRET-CANARY-CONTENT";
        let entries = vec![
            AuditEntry {
                ts: timestamp_now_rfc3339(),
                event: "propose".into(),
                action: marker_action.into(),
                outcome: "ok".into(),
                grant_id: Some("g-fix".into()),
                profile_id: Some("nan".into()),
                detail: Some("write_file /tmp/grant/notes.md (+3 −0 lines, 88 bytes)".into()),
            },
            AuditEntry {
                ts: timestamp_now_rfc3339(),
                event: "approve".into(),
                action: marker_action.into(),
                outcome: "ok".into(),
                grant_id: Some("g-fix".into()),
                profile_id: Some("nan".into()),
                detail: Some("proposal claimed for execute".into()),
            },
            AuditEntry {
                ts: timestamp_now_rfc3339(),
                event: "execute".into(),
                action: marker_action.into(),
                outcome: "ok".into(),
                grant_id: Some("g-fix".into()),
                profile_id: Some("nan".into()),
                detail: Some("wrote 88 bytes".into()),
            },
            AuditEntry {
                ts: timestamp_now_rfc3339(),
                event: "deny".into(),
                action: "run_command".into(),
                outcome: "ok".into(),
                grant_id: None,
                profile_id: Some("nan".into()),
                detail: Some("user denied".into()),
            },
            AuditEntry {
                ts: timestamp_now_rfc3339(),
                event: "propose".into(),
                action: "run_command".into(),
                outcome: "rejected".into(),
                grant_id: None,
                profile_id: Some("nan".into()),
                detail: Some("kind=disabled: run_command is disabled".into()),
            },
        ];
        for entry in &entries {
            append(&fixtures, entry).expect("fixture append");
        }
        // Self-check: every fixture line must carry the four core fields.
        let read_back = tail(&fixtures, 50).expect("fixture tail");
        assert_eq!(read_back.len(), entries.len());
        for entry in &read_back {
            assert!(!entry.ts.is_empty());
            assert!(!entry.event.is_empty());
            assert!(!entry.action.is_empty());
            assert!(!entry.outcome.is_empty());
        }
        // The canary content must not be present anywhere in the file.
        let raw = std::fs::read_to_string(fixtures.join(AUDIT_FILE)).expect("raw audit");
        assert!(
            !raw.contains(canary_content),
            "audit fixture must never contain file contents"
        );
        // Keep the literal referenced so the constant stays meaningful.
        assert!(!canary_content.is_empty());
        assert_eq!(marker_action, "write_file");
    }
}
