//! Folder grants for the desktop tools subsystem (T8 / spec S7).
//!
//! A grant is a user-approved folder the agent may operate on. Grants are
//! per profile, stored in `tools.json` under the app data dir, and are the
//! ONLY roots from which a tool action may read or write. Every path used
//! by an action is canonicalized (symlinks resolved) and verified to sit
//! component-wise under a granted root; lexical `..` components are
//! rejected before any I/O.
//!
//! Security invariants (enforced here, never in the renderer):
//! - grants are created only through explicit user action (native folder
//!   picker or a typed absolute path) — never inferred from chat context;
//! - the stored path is the canonical path, so a later symlink swap of any
//!   ancestor makes re-canonicalization disagree and the action fails
//!   closed (`verify_stable` / `verify_writable`);
//! - `tools_allow_run_command` defaults to FALSE and lives in the same
//!   store so the Rust core, not the renderer, owns the switch.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::Rejection;

/// Name of the tools settings file under the app data dir.
pub const STORE_FILE: &str = "tools.json";
/// Store schema version. A mismatch refuses to load (fail closed).
pub const STORE_VERSION: u32 = 1;

/// One approved folder grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Grant {
    pub id: String,
    /// Canonical (symlink-resolved) folder path at grant time.
    pub canonical_path: PathBuf,
    /// RFC 3339 UTC timestamp.
    pub granted_at: String,
    pub profile_id: String,
}

/// On-disk tools settings: folder grants plus the experimental
/// `run_command` switch (default OFF, spec S7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantsStore {
    pub version: u32,
    #[serde(default)]
    pub tools_allow_run_command: bool,
    #[serde(default)]
    pub grants: Vec<Grant>,
}

pub fn default_store() -> GrantsStore {
    GrantsStore {
        version: STORE_VERSION,
        tools_allow_run_command: false,
        grants: Vec::new(),
    }
}

/// Parse a stored file. Unknown schema versions and corrupt JSON fail
/// closed instead of being silently re-seeded.
pub fn parse_store(raw: &str) -> Result<GrantsStore, String> {
    let store: GrantsStore =
        serde_json::from_str(raw).map_err(|err| format!("corrupt {STORE_FILE}: {err}"))?;
    if store.version != STORE_VERSION {
        return Err(format!(
            "unsupported {STORE_FILE} version {} (expected {STORE_VERSION})",
            store.version
        ));
    }
    Ok(store)
}

/// Load `tools.json` from `dir`, seeding the default store (empty grants,
/// `run_command` OFF) when the file does not exist yet.
pub fn load_or_seed(dir: &Path) -> Result<GrantsStore, String> {
    let path = dir.join(STORE_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => parse_store(&raw),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(default_store()),
        Err(err) => Err(format!("cannot read {}: {err}", path.display())),
    }
}

/// Persist the store to `dir/tools.json`, creating `dir` when missing.
pub fn save(dir: &Path, store: &GrantsStore) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|err| format!("cannot create {}: {err}", dir.display()))?;
    let path = dir.join(STORE_FILE);
    let raw = serde_json::to_string_pretty(store).map_err(|err| err.to_string())?;
    std::fs::write(&path, raw).map_err(|err| format!("cannot write {}: {err}", path.display()))
}

impl GrantsStore {
    pub fn grants_for(&self, profile_id: &str) -> Vec<&Grant> {
        self.grants
            .iter()
            .filter(|grant| grant.profile_id == profile_id)
            .collect()
    }

    /// Add a grant. Idempotent per (profile, canonical path): re-granting
    /// the same folder returns the existing grant instead of duplicating.
    pub fn add_grant(
        &mut self,
        grant_id: String,
        profile_id: &str,
        canonical_path: PathBuf,
        granted_at: String,
    ) -> Result<Grant, String> {
        if let Some(existing) = self
            .grants
            .iter()
            .find(|grant| grant.profile_id == profile_id && grant.canonical_path == canonical_path)
        {
            return Ok(existing.clone());
        }
        let grant = Grant {
            id: grant_id,
            canonical_path,
            granted_at,
            profile_id: profile_id.to_string(),
        };
        self.grants.push(grant.clone());
        Ok(grant)
    }

    /// Remove a grant by id. Returns true when a grant was removed.
    pub fn revoke(&mut self, grant_id: &str) -> bool {
        let before = self.grants.len();
        self.grants.retain(|grant| grant.id != grant_id);
        self.grants.len() != before
    }

    pub fn set_run_command_enabled(&mut self, enabled: bool) {
        self.tools_allow_run_command = enabled;
    }
}

/// True when any path component is `..`. Lexical traversal is rejected
/// before any I/O so filesystem aliasing can never "accidentally" resolve
/// an escape into a granted folder.
pub fn has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
}

/// Component-wise containment: `candidate` equals `root` or lies below it.
/// `Path::starts_with` compares components, so `/grant-evil` is NOT under
/// `/grant`.
pub fn is_under(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

/// Canonicalize `path` even when its tail does not exist yet:
/// 1. reject lexical `..` and relative paths;
/// 2. canonicalize the deepest existing ancestor (resolves symlinks);
/// 3. re-attach the remaining components verbatim.
///
/// A tail component that is a symlink with an existing target is resolved
/// by step 2 automatically (the full path "exists"). A DANGling tail — a
/// missing leaf or a broken symlink — is re-attached unresolved. Note it
/// does NOT "fail later at open time": `fs::write` follows the whole chain
/// the moment the symlink target materializes, so every caller that WRITES
/// must reject symlink path components before opening (see
/// [`verify_writable`]).
pub fn canonicalize_best_effort(path: &Path) -> Result<PathBuf, Rejection> {
    if has_parent_component(path) {
        return Err(Rejection::new("traversal", "path contains `..`"));
    }
    if !path.is_absolute() {
        return Err(Rejection::new("protocol", "path must be absolute"));
    }
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return Ok(canonical);
    }
    // Walk up to the deepest existing ancestor, then re-attach the tail.
    let mut components: Vec<std::ffi::OsString> = path
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while components.len() > 1 {
        let candidate: PathBuf = components.iter().collect();
        if candidate.exists() {
            break;
        }
        tail.push(components.pop().expect("component checked non-empty above"));
    }
    let base: PathBuf = components.iter().collect();
    let canonical_base = std::fs::canonicalize(&base).map_err(|err| {
        Rejection::new(
            "io",
            format!("cannot canonicalize {}: {err}", base.display()),
        )
    })?;
    let mut result = canonical_base;
    for component in tail.iter().rev() {
        result.push(component);
    }
    Ok(result)
}

/// Resolve `raw` and verify it sits under a grant of `profile_id`.
/// Returns `(grant_id, canonical_path)`.
///
/// Rejections: `traversal` (lexical `..`), `protocol` (empty/relative),
/// `io` (cannot canonicalize), `no_grant` (profile has no grants),
/// `escape` (profile has grants but none covers the path).
pub fn resolve_under_grant(
    store: &GrantsStore,
    profile_id: &str,
    raw: &str,
) -> Result<(String, PathBuf), Rejection> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Rejection::new("protocol", "path must not be empty"));
    }
    let canonical = canonicalize_best_effort(Path::new(trimmed))?;
    let profile_grants = store.grants_for(profile_id);
    let Some(grant) = longest_covering(&profile_grants, &canonical) else {
        let kind = if profile_grants.is_empty() {
            "no_grant"
        } else {
            "escape"
        };
        return Err(Rejection::new(
            kind,
            format!(
                "{} is outside every folder granted to this profile",
                canonical.display()
            ),
        ));
    };
    Ok((grant.id.clone(), canonical))
}

/// Re-verify a previously canonicalized path right before use: canonicalizing
/// it again must yield the identical path, still under `root`. This is what
/// makes symlink swaps between propose and execute fail closed.
pub fn verify_stable(root: &Path, canonical: &Path) -> Result<(), Rejection> {
    let now = std::fs::canonicalize(canonical)
        .map_err(|err| Rejection::new("io", format!("path no longer resolves: {err}")))?;
    if now != canonical {
        return Err(Rejection::new(
            "escape",
            "path changed between propose and execute (symlink swap?)",
        ));
    }
    if !is_under(root, &now) {
        return Err(Rejection::new("escape", "path escaped its grant"));
    }
    Ok(())
}

/// Reject when ANY component of `canonical` (root to full path) is a
/// symlink. Missing components are skipped: nothing below the first missing
/// component exists, so nothing below it can be a symlink either.
///
/// This is the deterministic defense against dangling INTERMEDIATE
/// symlinks: canonicalization cannot see them (there is nothing to
/// resolve), but `fs::write` follows the chain once the target
/// materializes, which would land the write outside the grant.
fn reject_symlink_components(canonical: &Path) -> Result<(), Rejection> {
    let mut prefix: PathBuf = PathBuf::new();
    for component in canonical.components() {
        prefix.push(component);
        match std::fs::symlink_metadata(&prefix) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(Rejection::new(
                        "escape",
                        format!(
                            "path component {} is a symlink; refusing to write through it",
                            prefix.display()
                        ),
                    ));
                }
            }
            // Nothing below a missing component exists — stop scanning.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => break,
            Err(err) => {
                return Err(Rejection::new(
                    "io",
                    format!("cannot stat {}: {err}", prefix.display()),
                ));
            }
        }
    }
    Ok(())
}

/// Same check for a write target whose leaf may legitimately not exist yet.
/// A leaf that exists as a symlink is rejected outright: writing through a
/// symlink could land outside everything we just verified. When the leaf is
/// missing, EVERY path component is inspected: a dangling intermediate
/// symlink would be followed by `fs::write` the moment its target
/// materializes (canonicalization cannot see it), so any symlink component
/// — not just the leaf — is rejected.
pub fn verify_writable(root: &Path, canonical: &Path) -> Result<(), Rejection> {
    match std::fs::symlink_metadata(canonical) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                // A symlink leaf could redirect the write anywhere; refuse.
                return Err(Rejection::new(
                    "escape",
                    "write target is a symlink; refusing to write through it",
                ));
            }
            verify_stable(root, canonical)
        }
        Err(_) => {
            // Missing leaf: best-effort re-canonicalization of the base.
            let now = canonicalize_best_effort(canonical)?;
            if now != canonical {
                return Err(Rejection::new(
                    "escape",
                    "path changed between propose and execute (symlink swap?)",
                ));
            }
            if !is_under(root, &now) {
                return Err(Rejection::new("escape", "path escaped its grant"));
            }
            // A dangling intermediate symlink is invisible to the
            // canonicalization above but would be followed by fs::write as
            // soon as its target materializes — reject any symlink
            // component outright (deterministic, no race window on the
            // symlink itself).
            reject_symlink_components(canonical)?;
            Ok(())
        }
    }
}

fn longest_covering<'a>(grants: &[&'a Grant], canonical: &Path) -> Option<&'a Grant> {
    grants
        .iter()
        .copied()
        .filter(|grant| is_under(&grant.canonical_path, canonical))
        .max_by_key(|grant| grant.canonical_path.components().count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir() -> (PathBuf, tempfile::TempDir) {
        let tmp = tempfile::tempdir().expect("tempdir");
        (tmp.path().to_path_buf(), tmp)
    }

    // ------------------------------------------------------------- store --

    #[test]
    fn store_round_trips_through_disk() {
        let (dir, _tmp) = tempdir();
        let mut store = default_store();
        store
            .add_grant(
                "g1".into(),
                "nan",
                PathBuf::from("/tmp/grant"),
                "2026-01-01T00:00:00Z".into(),
            )
            .expect("add");
        save(&dir, &store).expect("save");
        let loaded = load_or_seed(&dir).expect("load");
        assert_eq!(loaded, store);
    }

    #[test]
    fn load_or_seed_seeds_default_on_missing_store() {
        let (dir, _tmp) = tempdir();
        let store = load_or_seed(&dir).expect("seed");
        assert_eq!(store, default_store());
        assert!(
            !store.tools_allow_run_command,
            "run_command must default OFF"
        );
        assert!(store.grants.is_empty());
    }

    #[test]
    fn corrupt_or_future_store_version_fails_closed() {
        assert!(parse_store("{not json").is_err());
        let future = format!("{{\"version\":{}}}", STORE_VERSION + 7);
        assert!(parse_store(&future).is_err());
        let (dir, _tmp) = tempdir();
        fs::write(dir.join(STORE_FILE), "{not json").expect("write corrupt");
        assert!(
            load_or_seed(&dir).is_err(),
            "corrupt store must not silently re-seed"
        );
    }

    #[test]
    fn add_grant_is_idempotent_per_profile_and_path() {
        let mut store = default_store();
        let first = store
            .add_grant("g1".into(), "nan", PathBuf::from("/tmp/grant"), "t1".into())
            .expect("add");
        let again = store
            .add_grant("g2".into(), "nan", PathBuf::from("/tmp/grant"), "t2".into())
            .expect("re-add");
        assert_eq!(first.id, again.id, "re-grant returns the existing grant");
        assert_eq!(store.grants.len(), 1);
        store
            .add_grant(
                "g3".into(),
                "helmcode",
                PathBuf::from("/tmp/grant"),
                "t3".into(),
            )
            .expect("other profile");
        assert_eq!(
            store.grants.len(),
            2,
            "same path, other profile → own grant"
        );
    }

    #[test]
    fn revoke_removes_only_matching_grant() {
        let mut store = default_store();
        store
            .add_grant("g1".into(), "nan", PathBuf::from("/tmp/a"), "t".into())
            .expect("add g1");
        store
            .add_grant("g2".into(), "nan", PathBuf::from("/tmp/b"), "t".into())
            .expect("add g2");
        assert!(store.revoke("g1"));
        assert!(!store.revoke("g1"), "second revoke finds nothing");
        assert!(!store.revoke("missing"));
        assert_eq!(store.grants.len(), 1);
        assert_eq!(store.grants[0].id, "g2");
    }

    // ------------------------------------------------------------- paths --

    #[test]
    fn has_parent_component_detects_traversal_only_in_components() {
        assert!(has_parent_component(Path::new("/a/../b")));
        assert!(has_parent_component(Path::new("../etc/passwd")));
        assert!(
            !has_parent_component(Path::new("/a..b/c")),
            "literal dot-dot in a name is not traversal"
        );
        assert!(!has_parent_component(Path::new("/grant/sub/file.txt")));
    }

    #[test]
    fn is_under_is_component_wise() {
        let root = Path::new("/grant");
        assert!(is_under(root, Path::new("/grant")));
        assert!(is_under(root, Path::new("/grant/sub/file.txt")));
        assert!(
            !is_under(root, Path::new("/grant-evil/file.txt")),
            "prefix-string match must not count"
        );
        assert!(!is_under(root, Path::new("/etc/passwd")));
    }

    #[test]
    fn canonicalize_best_effort_resolves_existing_and_keeps_missing_tail() {
        let (dir, _tmp) = tempdir();
        fs::create_dir_all(dir.join("a/b")).expect("mkdir");
        let target = dir.join("a/b/missing.txt");
        let canonical = canonicalize_best_effort(&target).expect("canonicalize");
        // The base is canonicalized (macOS /var symlink!) while the missing
        // tail is re-attached verbatim.
        let expected_base = fs::canonicalize(dir.join("a/b")).expect("base");
        assert_eq!(canonical, expected_base.join("missing.txt"));
    }

    #[test]
    fn canonicalize_best_effort_resolves_symlinks() {
        let (dir, _tmp) = tempdir();
        fs::create_dir_all(dir.join("real")).expect("mkdir");
        fs::write(dir.join("real/f.txt"), "x").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).expect("symlink");
        #[cfg(unix)]
        {
            let canonical =
                canonicalize_best_effort(&dir.join("link/f.txt")).expect("canonicalize");
            assert_eq!(
                canonical,
                fs::canonicalize(dir.join("real/f.txt")).expect("real")
            );
        }
    }

    #[test]
    fn canonicalize_best_effort_rejects_traversal_and_relative() {
        let (dir, _tmp) = tempdir();
        let traversal = dir.join("a/../b");
        let err = canonicalize_best_effort(&traversal).expect_err("traversal rejected");
        assert_eq!(err.kind, "traversal");
        let err =
            canonicalize_best_effort(Path::new("relative/path")).expect_err("relative rejected");
        assert_eq!(err.kind, "protocol");
    }

    // ------------------------------------------------------ grant checks --

    fn store_with_grant(root: &Path, sub: Option<&str>) -> GrantsStore {
        let mut store = default_store();
        // Grants are stored CANONICALIZED (macOS /var → /private/var),
        // mirroring what tools_grant_add does.
        let canonical_root = fs::canonicalize(root).expect("canonicalize root");
        let path = match sub {
            Some(s) => canonical_root.join(s),
            None => canonical_root,
        };
        store
            .add_grant(
                format!("g-{}", sub.unwrap_or("root")),
                "nan",
                path,
                "t".into(),
            )
            .expect("add grant");
        store
    }

    #[test]
    fn resolve_under_grant_accepts_nested_path_and_returns_grant() {
        let (root, _tmp) = tempdir();
        let root = fs::canonicalize(&root).expect("canonical root");
        fs::create_dir_all(root.join("sub")).expect("mkdir");
        let store = store_with_grant(&root, None);
        let (grant_id, canonical) =
            resolve_under_grant(&store, "nan", &root.join("sub/f.txt").display().to_string())
                .expect("under grant");
        assert_eq!(grant_id, "g-root");
        assert!(is_under(&root, &canonical));
    }

    #[test]
    fn resolve_under_grant_rejects_traversal() {
        let (root, _tmp) = tempdir();
        let store = store_with_grant(&root, None);
        let path = root.join("../etc/passwd");
        let err =
            resolve_under_grant(&store, "nan", &path.display().to_string()).expect_err("rejected");
        assert_eq!(err.kind, "traversal");
    }

    #[test]
    fn resolve_under_grant_rejects_outside_paths() {
        let (root, _tmp) = tempdir();
        let outside = {
            let (p, t) = tempdir();
            (p, t)
        };
        // With a grant present, an outside path is an escape attempt.
        let store = store_with_grant(&root, None);
        let err = resolve_under_grant(&store, "nan", &outside.0.display().to_string())
            .expect_err("escape");
        assert_eq!(err.kind, "escape");
        // With no grants at all, it is simply ungranted.
        let empty = default_store();
        let err =
            resolve_under_grant(&empty, "nan", &root.display().to_string()).expect_err("no grant");
        assert_eq!(err.kind, "no_grant");
    }

    #[test]
    fn resolve_under_grant_rejects_symlink_escape() {
        let (root, _tmp) = tempdir();
        let (outside, _tmp2) = tempdir();
        fs::create_dir_all(root.join("sub")).expect("mkdir");
        fs::write(outside.join("secret.txt"), "top secret").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("sub/escape")).expect("symlink");
        #[cfg(unix)]
        {
            let store = store_with_grant(&root, None);
            // Direct symlink to an outside FILE.
            fs::write(outside.join("file.txt"), "x").expect("write");
            std::os::unix::fs::symlink(outside.join("file.txt"), root.join("sub/link-file"))
                .expect("symlink");
            let err = resolve_under_grant(
                &store,
                "nan",
                &root.join("sub/link-file").display().to_string(),
            )
            .expect_err("symlinked file outside grant");
            assert_eq!(err.kind, "escape");
            // Symlinked dir + file below it.
            let err = resolve_under_grant(
                &store,
                "nan",
                &root.join("sub/escape/secret.txt").display().to_string(),
            )
            .expect_err("file under symlinked dir outside grant");
            assert_eq!(err.kind, "escape");
        }
    }

    #[test]
    fn resolve_under_grant_allows_symlink_inside_grant() {
        let (root, _tmp) = tempdir();
        let root = fs::canonicalize(&root).expect("canonical root");
        fs::create_dir_all(root.join("real")).expect("mkdir");
        fs::write(root.join("real/f.txt"), "x").expect("write");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).expect("symlink");
        #[cfg(unix)]
        {
            let store = store_with_grant(&root, None);
            let (_, canonical) = resolve_under_grant(
                &store,
                "nan",
                &root.join("link/f.txt").display().to_string(),
            )
            .expect("inside-grant symlink resolves");
            assert!(
                is_under(&root, &canonical),
                "resolved path stays under the grant"
            );
        }
    }

    #[test]
    fn longest_prefix_wins() {
        let (root, _tmp) = tempdir();
        fs::create_dir_all(root.join("sub")).expect("mkdir");
        let mut store = store_with_grant(&root, None);
        store
            .add_grant(
                "g-sub".into(),
                "nan",
                fs::canonicalize(root.join("sub")).expect("canonical sub"),
                "t".into(),
            )
            .expect("add sub grant");
        let (grant_id, _) =
            resolve_under_grant(&store, "nan", &root.join("sub/f.txt").display().to_string())
                .expect("nested resolve");
        assert_eq!(grant_id, "g-sub", "deepest covering grant wins");
        let (grant_id, _) =
            resolve_under_grant(&store, "nan", &root.join("other.txt").display().to_string())
                .expect("root resolve");
        assert_eq!(grant_id, "g-root");
    }

    #[test]
    fn verify_stable_accepts_unchanged_path() {
        let (root, _tmp) = tempdir();
        let root = fs::canonicalize(&root).expect("canonical root");
        fs::write(root.join("f.txt"), "x").expect("write");
        let canonical = fs::canonicalize(root.join("f.txt")).expect("canonical");
        verify_stable(&root, &canonical).expect("stable");
    }

    #[test]
    fn verify_stable_detects_symlink_swap() {
        let (root, _tmp) = tempdir();
        let (outside, _tmp2) = tempdir();
        fs::create_dir_all(root.join("a")).expect("mkdir");
        fs::write(root.join("a/f.txt"), "x").expect("write");
        fs::write(outside.join("evil.txt"), "x").expect("write");
        let canonical = fs::canonicalize(root.join("a/f.txt")).expect("canonical");
        // Swap: real folder replaced by a folder containing a symlink that
        // points outside the grant.
        fs::remove_dir_all(root.join("a")).expect("remove");
        fs::create_dir_all(root.join("a")).expect("mkdir");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("evil.txt"), root.join("a/f.txt"))
            .expect("symlink");
        #[cfg(unix)]
        {
            let err = verify_stable(&root, &canonical).expect_err("swap detected");
            assert_eq!(err.kind, "escape");
        }
    }

    #[test]
    fn verify_writable_accepts_missing_leaf() {
        let (root, _tmp) = tempdir();
        let root = fs::canonicalize(&root).expect("canonical root");
        let canonical = root.join("new.txt");
        verify_writable(&root, &canonical).expect("missing leaf is writable");
    }

    #[test]
    fn verify_writable_rejects_broken_symlink_leaf() {
        let (root, _tmp) = tempdir();
        let (outside, _tmp2) = tempdir();
        let root = fs::canonicalize(&root).expect("canonical root");
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("does-not-exist-yet"), root.join("new.txt"))
            .expect("symlink");
        #[cfg(unix)]
        {
            let canonical = root.join("new.txt");
            let err = verify_writable(&root, &canonical).expect_err("broken symlink leaf rejected");
            assert_eq!(err.kind, "escape");
        }
    }

    #[cfg(unix)]
    #[test]
    fn verify_writable_rejects_dangling_intermediate_symlink() {
        // A dangling symlink BETWEEN the grant root and the missing leaf is
        // invisible to canonicalization (nothing to resolve), but fs::write
        // would follow the chain the moment its target materializes. The
        // write must be rejected because a PATH COMPONENT is a symlink.
        let (root, _tmp) = tempdir();
        let (outside, _tmp2) = tempdir();
        let root = fs::canonicalize(&root).expect("canon");
        let outside = fs::canonicalize(&outside).expect("canon");
        std::os::unix::fs::symlink(outside.join("later"), root.join("blink")).expect("symlink");
        let target = root.join("blink").join("evil.txt");
        // Precondition: canonicalization still resolves it INTO the grant —
        // that is exactly the hole being pinned shut.
        let canonical = canonicalize_best_effort(&target).expect("resolves into grant");
        assert!(is_under(&root, &canonical));
        let err =
            verify_writable(&root, &canonical).expect_err("dangling intermediate must be rejected");
        assert_eq!(err.kind, "escape");
        // Nothing materialized outside.
        assert!(!outside.join("later").exists());
    }

    #[cfg(unix)]
    #[test]
    fn verify_writable_allows_plain_missing_leaf() {
        // Guard against over-blocking: a missing leaf with NO symlink in any
        // component must stay writable (the normal create-new-file flow).
        let (root, _tmp) = tempdir();
        let root = fs::canonicalize(&root).expect("canon");
        fs::create_dir(root.join("sub")).expect("dir");
        let canonical = canonicalize_best_effort(&root.join("sub").join("new.txt")).expect("ok");
        verify_writable(&root, &canonical).expect("plain missing leaf stays writable");
    }
}
