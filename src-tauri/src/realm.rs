//! Per-user data realms (privacy fix, owner S1).
//!
//! # Why
//!
//! Up to v0.2.6 every local store was keyed by the PLATFORM profile (`nan` /
//! `helmcode`): one `chat.db`, one skills folder, one tools policy, one
//! vault slot per tenant. Two accounts of the same tenant on one device
//! therefore shared everything: signing in with a second account showed the
//! first account's conversations, skills and folder grants.
//!
//! # Design
//!
//! * **Realm key.** Local isolation is per AUTHENTICATED USER. A user's
//!   realm key is `<profile-id>:<user-id>` (the user id the platform reports
//!   at login through `GET /api/auth/me`), stable and collision free across
//!   tenants. Paths never embed it raw: the realm folder is
//!   `<app data>/realms/<realm hash>` with `realm hash = hex(sha256(realm
//!   key)[0..16])` (32 hex chars).
//! * **Binding.** `profiles.json` (schema v3) records, per platform profile,
//!   the user currently bound to it ([`profile::BoundUser`]). It changes only
//!   after an explicit, successful device-flow login whose identity was
//!   verified with the NEW session ([`bind_login_in`]); sign-out keeps it.
//!   It lives outside the vault on purpose: a vault reset (round 13 stamp)
//!   must sign the user out without forgetting whose data is whose.
//! * **What lives in a realm.** Everything user-identifying: `chat.db`
//!   (conversations, messages, memory tombstones), local skills (`skills/`),
//!   the org skills cache (`skills-cache/<profile>`), the tools policy and
//!   folder grants (`tools.json`), the tools audit log and the memory
//!   settings (`memory.json`). Vault accounts are realm keyed too
//!   (`<realm key>` / `<realm key>.session`).
//! * **What stays shared.** The vault file itself (one encrypted map, one
//!   master key: only the accounts are per realm), `profiles.json` (bindings,
//!   no content) and generated images under `images/` (the asset protocol
//!   scope): their names are random v4 uuids, no IPC lists them and they are
//!   only reachable through a realm's own `chat.db` reference.
//! * **Resolution.** A command reaches a realm only through [`active_dir_in`]
//!   / [`dir_for_in`], which require a profile that is ACTIVE and BOUND. A
//!   signed-out app (no active profile) reads no realm at all.
//! * **Root vs realm.** Code that needs the app data ROOT (the tool sandbox
//!   protection, the shared images folder) derives it with [`root_of`], so a
//!   realm folder never shrinks what the tools guard protects.
//!
//! # One-time migration (legacy data)
//!
//! Data written before realms existed carries no user, only a profile. The
//! documented assumption is that it belongs to whoever signs in to that
//! profile FIRST after the update: [`bind_login_in`] moves it into that
//! user's realm ([`claim_legacy`]) when the profile has no bound user yet
//! (or the same user re-binds after an interrupted move). After that, any
//! other user id gets a FRESH, empty realm; re-signing the bound user brings
//! their realm back. Profile-less legacy stores (local skills) go to the
//! first claim on the device.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::chat_store;
use crate::profile::{self, BoundUser, ProfileStore};

/// Folder (under the app data root) holding one sub-folder per realm.
pub const REALMS_DIR: &str = "realms";
/// Hex length of a realm hash (16 bytes of sha256).
const REALM_HASH_HEX_LEN: usize = 32;
/// Longest accepted platform user id.
const MAX_USER_ID_LEN: usize = 128;
/// Longest accepted email (RFC 5321 path limit).
const MAX_EMAIL_LEN: usize = 320;

/// `<profile-id>:<user-id>`. Profile ids never contain `:`, so the key is
/// unambiguous even for user ids that do.
pub fn realm_key(profile_id: &str, user_id: &str) -> String {
    format!("{profile_id}:{user_id}")
}

/// `hex(sha256(realm_key)[0..16])`: the realm's folder name.
pub fn realm_hash(realm_key: &str) -> String {
    let digest = Sha256::digest(realm_key.as_bytes());
    digest[..REALM_HASH_HEX_LEN / 2]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Whether `name` has the exact shape of a realm hash.
pub fn is_realm_hash(name: &str) -> bool {
    name.len() == REALM_HASH_HEX_LEN
        && name
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, 'a'..='f'))
}

/// A platform user id this app accepts: 1..=128 printable ASCII chars, no
/// whitespace. Anything else fails the login closed (no realm can be chosen).
pub fn valid_user_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_USER_ID_LEN && id.chars().all(|c| c.is_ascii_graphic())
}

/// A displayable email: non-empty, bounded, no control characters.
pub fn valid_email(email: &str) -> bool {
    !email.is_empty() && email.len() <= MAX_EMAIL_LEN && !email.chars().any(char::is_control)
}

/// The folder of the realm `hash` under the app data `root`.
pub fn realm_dir(root: &Path, hash: &str) -> PathBuf {
    root.join(REALMS_DIR).join(hash)
}

/// The app data ROOT for `dir`: the root itself, or the root a realm folder
/// (`<root>/realms/<hash>`) lives in. Used by everything that must see the
/// whole app data folder (tool sandbox protection, shared images).
pub fn root_of(dir: &Path) -> &Path {
    let is_realm = dir
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(is_realm_hash);
    if is_realm
        && let Some(realms) = dir.parent()
        && realms.file_name() == Some(OsStr::new(REALMS_DIR))
        && let Some(root) = realms.parent()
    {
        return root;
    }
    dir
}

/// Why no realm could be resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RealmError {
    /// No profile is active, or the active one has no bound user.
    SignedOut,
    /// The command named a profile that is not the active one.
    ProfileNotActive,
    /// `profiles.json` could not be read or written.
    Io(String),
}

impl std::fmt::Display for RealmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RealmError::SignedOut => write!(f, "signed_out"),
            RealmError::ProfileNotActive => write!(f, "profile_not_active"),
            RealmError::Io(msg) => write!(f, "{msg}"),
        }
    }
}

/// The realm folder of the active profile's bound user.
pub fn active_dir_in(root: &Path) -> Result<PathBuf, RealmError> {
    let store = profile::load_or_seed(root).map_err(RealmError::Io)?;
    let (_, user) = store.active_binding().ok_or(RealmError::SignedOut)?;
    Ok(realm_dir(root, &user.realm))
}

/// The realm folder for a command that names `profile_id`: only the ACTIVE,
/// BOUND profile resolves (a stale renderer naming another profile reads
/// nothing).
pub fn dir_for_in(root: &Path, profile_id: &str) -> Result<PathBuf, RealmError> {
    let store = profile::load_or_seed(root).map_err(RealmError::Io)?;
    match store.active_binding() {
        Some((active, user)) if active == profile_id => Ok(realm_dir(root, &user.realm)),
        Some(_) => Err(RealmError::ProfileNotActive),
        None => Err(RealmError::SignedOut),
    }
}

/// The vault accounts (`key`, `session`) of the user bound to `profile_id`;
/// `None` when the profile has no bound user (= signed out: the legacy
/// profile-keyed accounts are never read as credentials).
pub fn accounts_in(root: &Path, profile_id: &str) -> Option<(String, String)> {
    let store = profile::load_or_seed(root).ok()?;
    let user = store.binding(profile_id)?;
    let key = user.realm_key(profile_id);
    Some((profile::key_account(&key), profile::session_account(&key)))
}

// ---------------------------------------------------------------------------
// Process-wide root (credential lookups happen deep in async tasks that do
// not carry an AppHandle).
// ---------------------------------------------------------------------------

static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Record the app data root (called once from the Tauri `setup`).
pub fn init(root: &Path) {
    let _ = ROOT.set(root.to_path_buf());
}

/// [`accounts_in`] against the app data root; `None` before [`init`].
pub fn accounts(profile_id: &str) -> Option<(String, String)> {
    accounts_in(ROOT.get()?, profile_id)
}

/// [`active_dir_in`] for a command.
pub fn active_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|err| err.to_string())?;
    active_dir_in(&root).map_err(|err| err.to_string())
}

/// [`dir_for_in`] for a command.
pub fn dir_for(app: &AppHandle, profile_id: &str) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|err| err.to_string())?;
    dir_for_in(&root, profile_id).map_err(|err| err.to_string())
}

// ---------------------------------------------------------------------------
// Identity (GET /api/auth/me with the NEW session)
// ---------------------------------------------------------------------------

/// The account a fresh login belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub id: String,
    pub email: Option<String>,
}

fn non_empty<'a>(
    map: &'a serde_json::Map<String, serde_json::Value>,
    keys: &[&str],
) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        map.get(*key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

/// Parse `/api/auth/me`. enterprise-api answers `{id, email, ...}`;
/// cloud-api answers `{userUUID, email, discordId, ...}` (a nested `user`
/// object is accepted too). A body without a valid user id is `None`: the
/// login then fails closed, because no realm can be chosen for it.
pub fn parse_identity(body: &serde_json::Value) -> Option<Identity> {
    const ID_KEYS: &[&str] = &["id", "userUUID", "user_uuid"];
    let top = body.as_object()?;
    let nested = top.get("user").and_then(serde_json::Value::as_object);
    let id = non_empty(top, ID_KEYS)
        .or_else(|| nested.and_then(|user| non_empty(user, ID_KEYS)))
        .map(str::to_string)
        // Pre-UUID community accounts: the Discord id is still one stable
        // id per person; prefixed so it can never equal a UUID.
        .or_else(|| non_empty(top, &["discordId"]).map(|id| format!("discord-{id}")))
        .filter(|id| valid_user_id(id))?;
    let email = non_empty(top, &["email"])
        .or_else(|| nested.and_then(|user| non_empty(user, &["email"])))
        .filter(|email| valid_email(email))
        .map(str::to_string);
    Some(Identity { id, email })
}

/// `GET {base}/api/auth/me` with `session_token`, through the same closed
/// route allowlist as the org skills library. Any failure (offline, non-200,
/// no user id) is an error: the caller refuses the login.
pub async fn fetch_identity(base: &str, session_token: &str) -> Result<Identity, ()> {
    let response = crate::skills_team::send(
        base,
        session_token,
        "GET",
        crate::skills_team::API_ME,
        None,
        None,
    )
    .await
    .map_err(|_| ())?;
    if response.status != 200 {
        return Err(());
    }
    parse_identity(&response.body).ok_or(())
}

// ---------------------------------------------------------------------------
// Binding a login + the one-time legacy claim
// ---------------------------------------------------------------------------

/// What [`bind_login_in`] decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginBinding {
    /// The new user's realm key (vault accounts derive from it).
    pub realm_key: String,
    /// The user previously bound to this profile, when it was SOMEONE ELSE
    /// (their vault credentials are dropped; their realm data is kept).
    pub replaced: Option<BoundUser>,
    /// True when this user had no realm on this device and nothing legacy
    /// was claimed: the UI shows the fresh state explicitly.
    pub fresh: bool,
}

/// Why [`bind_login_in`] refused a login. Either way nothing was bound.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BindError {
    /// Invalid identity, or a local step (profiles store, realm folder)
    /// failed.
    Local(String),
    /// This user's pre-realm chat history (or folder grants) could not be
    /// moved into their realm, e.g. the disk is full. The legacy data is
    /// intact and the next login retries; binding anyway would show the
    /// user a silently empty realm.
    Claim(String),
}

impl From<String> for BindError {
    fn from(err: String) -> Self {
        BindError::Local(err)
    }
}

/// Bind a VERIFIED login of `identity` to `profile_id`: claim legacy data
/// when allowed, create the realm folder, and return the updated store (the
/// caller persists it after the vault write succeeds) plus the decision.
///
/// Legacy data is claimed only when the profile has no bound user yet, or
/// the same user re-binds (an interrupted earlier claim): a DIFFERENT user
/// never receives it. A claim that fails refuses the login
/// ([`BindError::Claim`]) instead of binding the user to an empty realm.
pub fn bind_login_in(
    root: &Path,
    profile_id: &str,
    identity: &Identity,
) -> Result<(ProfileStore, LoginBinding), BindError> {
    let mut store = profile::load_or_seed(root)?;
    let user = BoundUser::new(profile_id, &identity.id, identity.email.clone());
    if !profile::is_known_profile_id(profile_id) || !user.is_valid_for(profile_id) {
        return Err(BindError::Local("invalid identity".to_string()));
    }
    let previous = store.binding(profile_id).cloned();
    let dir = realm_dir(root, &user.realm);
    let existed = dir.exists();
    let may_claim = previous.as_ref().is_none_or(|prev| prev.id == user.id);
    let claimed = may_claim && claim_legacy(root, profile_id, &dir).map_err(BindError::Claim)?;
    create_private_dir(&dir)?;
    let realm_key = user.realm_key(profile_id);
    store.bind(profile_id, user)?;
    store.set_active_profile(profile_id)?;
    Ok((
        store,
        LoginBinding {
            realm_key,
            replaced: previous.filter(|prev| prev.id != identity.id),
            fresh: !existed && !claimed,
        },
    ))
}

/// Create `dir` (and parents) with mode `0700` on unix.
fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Move whatever pre-realm data of `profile_id` still exists under `root`
/// into the realm folder `dir`. Idempotent: every step MOVES (nothing is
/// duplicated), a step that fails leaves its legacy data where it was
/// (unreachable by any command) for the same user's next login.
///
/// The chat history and the folder grants are the user's content: their
/// failure is returned (the caller refuses the login) instead of being
/// swallowed, so the user never lands in a silently empty realm. The
/// skills/cache moves and the settings copy stay best-effort (a failed
/// rename deletes nothing). Returns whether any user data was moved.
pub fn claim_legacy(root: &Path, profile_id: &str, dir: &Path) -> Result<bool, String> {
    create_private_dir(dir)?;
    let mut claimed = false;
    // Conversations, messages and memory tombstones of this profile. First,
    // so a failure here moves nothing else.
    claimed |= chat_store::claim_profile(root, dir, profile_id)?;
    // Local skills had no owner at all: they go to the first claim.
    claimed |= move_if_absent(
        &root.join(crate::skills::SKILLS_DIR),
        &dir.join(crate::skills::SKILLS_DIR),
    );
    // The org skills offline cache of this profile.
    claimed |= move_if_absent(
        &root.join(crate::skills_team::CACHE_DIR).join(profile_id),
        &dir.join(crate::skills_team::CACHE_DIR).join(profile_id),
    );
    // This profile's folder grants (+ the run_command switch).
    claimed |= crate::tools::grants::claim_profile(root, dir, profile_id)?;
    // Memory settings are not user content (mode + a random device id):
    // copied, so the other profile's first user keeps the same settings.
    let memory = crate::memory::SETTINGS_FILE;
    if root.join(memory).is_file() && !dir.join(memory).exists() {
        let _ = std::fs::copy(root.join(memory), dir.join(memory));
    }
    Ok(claimed)
}

/// Rename `from` to `to` when `from` exists and `to` does not.
fn move_if_absent(from: &Path, to: &Path) -> bool {
    if !from.exists() || to.exists() {
        return false;
    }
    if let Some(parent) = to.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return false;
    }
    std::fs::rename(from, to).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn identity(id: &str, email: &str) -> Identity {
        Identity {
            id: id.into(),
            email: Some(email.into()),
        }
    }

    /// Bind + persist, like `device_flow::store_credentials` does.
    fn login(root: &Path, profile_id: &str, id: &str) -> LoginBinding {
        let (store, binding) = bind_login_in(
            root,
            profile_id,
            &identity(id, &format!("{id}@example.com")),
        )
        .expect("bind");
        profile::save(root, &store).expect("save");
        binding
    }

    fn logout(root: &Path) {
        let mut store = profile::load_or_seed(root).expect("load");
        store.clear_active_profile();
        profile::save(root, &store).expect("save");
    }

    #[test]
    fn realm_key_and_hash_are_stable_and_collision_free() {
        assert_eq!(realm_key("nan", "u-1"), "nan:u-1");
        let hash = realm_hash("nan:u-1");
        assert_eq!(hash.len(), 32);
        assert!(is_realm_hash(&hash));
        assert_eq!(hash, realm_hash("nan:u-1"), "deterministic");
        // Same user id on the other tenant, and another user on the same
        // tenant, are different realms.
        assert_ne!(hash, realm_hash("helmcode:u-1"));
        assert_ne!(hash, realm_hash("nan:u-2"));
        // sha256("nan:u-1") prefix, pinned so the folder name never drifts.
        let full = Sha256::digest(b"nan:u-1");
        let expected: String = full[..16].iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hash, expected);
    }

    #[test]
    fn root_of_maps_a_realm_folder_back_to_the_app_data_root() {
        let root = Path::new("/data/app");
        let dir = realm_dir(root, &realm_hash("nan:u"));
        assert_eq!(root_of(&dir), root);
        assert_eq!(root_of(root), root, "the root is its own root");
        // Look-alikes are not realms.
        assert_eq!(
            root_of(Path::new("/data/app/realms/not-a-hash")),
            Path::new("/data/app/realms/not-a-hash")
        );
        let fake = Path::new("/x/other").join(realm_hash("nan:u"));
        assert_eq!(root_of(&fake), fake.as_path());
    }

    #[test]
    fn identity_parses_both_tenants_and_refuses_bodies_without_a_user_id() {
        assert_eq!(
            parse_identity(&json!({"id": "e-1", "email": "a@corp.com", "orgId": "o"})),
            Some(identity("e-1", "a@corp.com"))
        );
        assert_eq!(
            parse_identity(
                &json!({"userUUID": "c-1", "email": "b@nan.builders", "discordId": "9"})
            ),
            Some(identity("c-1", "b@nan.builders"))
        );
        assert_eq!(
            parse_identity(&json!({"user": {"id": "n-1", "email": "c@x.io"}})),
            Some(identity("n-1", "c@x.io"))
        );
        assert_eq!(
            parse_identity(&json!({"userUUID": "", "discordId": "42"})),
            Some(Identity {
                id: "discord-42".into(),
                email: None
            })
        );
        for bad in [
            json!({"email": "only@email.com"}),
            json!({"id": ""}),
            json!({"id": "has space"}),
            json!({"id": "x".repeat(129)}),
            json!("string"),
            json!(null),
        ] {
            assert_eq!(parse_identity(&bad), None, "{bad}");
        }
    }

    #[test]
    fn fetch_identity_uses_the_new_session_and_fails_closed() {
        use std::io::{Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for body in [
                r#"{"id":"u-9","email":"z@example.com"}"#,
                r#"{"email":"x"}"#,
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap();
                seen.push(String::from_utf8_lossy(&buf[..n]).to_string());
                let reply = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).unwrap();
            }
            seen
        });
        let fetch =
            |base: &str| tauri::async_runtime::block_on(fetch_identity(base, "new-session"));
        assert_eq!(fetch(&base), Ok(identity("u-9", "z@example.com")));
        assert_eq!(fetch(&base), Err(()));
        let seen = server.join().unwrap();
        assert!(seen[0].starts_with("GET /api/auth/me "));
        assert!(
            seen[0]
                .to_ascii_lowercase()
                .contains("authorization: bearer new-session")
        );
        // Offline: refused, never a fallback identity.
        assert_eq!(fetch("http://127.0.0.1:9"), Err(()));
    }

    #[test]
    fn signed_out_or_unbound_resolves_no_realm() {
        let root = TempDir::new().unwrap();
        assert_eq!(active_dir_in(root.path()), Err(RealmError::SignedOut));
        assert_eq!(dir_for_in(root.path(), "nan"), Err(RealmError::SignedOut));
        // A v2 upgrade: active profile, no binding -> still signed out.
        let mut store = profile::load_or_seed(root.path()).unwrap();
        store.set_active_profile("nan").unwrap();
        profile::save(root.path(), &store).unwrap();
        assert_eq!(active_dir_in(root.path()), Err(RealmError::SignedOut));
        assert_eq!(accounts_in(root.path(), "nan"), None);
    }

    #[test]
    fn only_the_active_bound_profile_resolves_a_realm() {
        let root = TempDir::new().unwrap();
        login(root.path(), "nan", "user-a");
        let dir = active_dir_in(root.path()).expect("active realm");
        assert_eq!(dir, realm_dir(root.path(), &realm_hash("nan:user-a")));
        assert_eq!(dir_for_in(root.path(), "nan"), Ok(dir.clone()));
        assert_eq!(
            dir_for_in(root.path(), "helmcode"),
            Err(RealmError::ProfileNotActive)
        );
        // Sign-out: binding kept, but nothing resolves until a login.
        logout(root.path());
        assert_eq!(active_dir_in(root.path()), Err(RealmError::SignedOut));
        assert_eq!(dir_for_in(root.path(), "nan"), Err(RealmError::SignedOut));
        assert!(dir.is_dir(), "realm data is kept on sign-out");
    }

    #[test]
    fn vault_accounts_follow_the_bound_user() {
        let root = TempDir::new().unwrap();
        login(root.path(), "nan", "user-a");
        assert_eq!(
            accounts_in(root.path(), "nan"),
            Some(("nan:user-a".into(), "nan:user-a.session".into()))
        );
        let b = login(root.path(), "nan", "user-b");
        assert_eq!(b.replaced.map(|u| u.id), Some("user-a".into()));
        assert_eq!(
            accounts_in(root.path(), "nan"),
            Some(("nan:user-b".into(), "nan:user-b.session".into()))
        );
        assert_eq!(accounts_in(root.path(), "helmcode"), None);
    }

    #[test]
    fn first_login_of_a_new_user_is_fresh_and_a_relogin_is_not() {
        let root = TempDir::new().unwrap();
        let first = login(root.path(), "nan", "user-a");
        assert!(first.fresh, "nothing legacy, never seen: fresh");
        assert_eq!(first.replaced, None);
        logout(root.path());
        let again = login(root.path(), "nan", "user-a");
        assert!(!again.fresh, "the same user gets their realm back");
        assert_eq!(again.replaced, None, "same user is not a replacement");
    }

    #[test]
    fn a_failed_chat_claim_refuses_the_bind_and_keeps_the_legacy_history() {
        let root = TempDir::new().unwrap();
        let conn = chat_store::open_db(root.path()).unwrap();
        chat_store::insert_conversation(&conn, "nan", "old chat").unwrap();
        drop(conn);
        let dir = realm_dir(root.path(), &realm_hash(&realm_key("nan", "u-1")));
        let blocker = dir.join(format!("{}.claim.tmp", chat_store::DB_FILE));
        std::fs::create_dir_all(&blocker).unwrap();

        let err = bind_login_in(root.path(), "nan", &identity("u-1", "u@x.io")).unwrap_err();
        assert!(matches!(err, BindError::Claim(_)), "{err:?}");
        assert!(claim_legacy(root.path(), "nan", &dir).is_err());
        let legacy = chat_store::open_db(root.path()).unwrap();
        assert_eq!(
            chat_store::list_conversations(&legacy, "nan")
                .unwrap()
                .len(),
            1
        );
        drop(legacy);

        std::fs::remove_dir(&blocker).unwrap();
        let binding = login(root.path(), "nan", "u-1");
        assert!(!binding.fresh, "the retry claims the history");
        let mine = chat_store::open_db(&dir).unwrap();
        assert_eq!(
            chat_store::list_conversations(&mine, "nan").unwrap()[0].title,
            "old chat"
        );
    }

    #[test]
    fn invalid_identities_bind_nothing() {
        let root = TempDir::new().unwrap();
        let bad = Identity {
            id: "two words".into(),
            email: None,
        };
        assert!(bind_login_in(root.path(), "nan", &bad).is_err());
        assert!(bind_login_in(root.path(), "root", &identity("u", "u@x.io")).is_err());
        assert!(!root.path().join(REALMS_DIR).exists());
    }

    #[test]
    fn legacy_skills_and_team_cache_move_to_the_first_claim_only() {
        let root = TempDir::new().unwrap();
        let skills = root.path().join(crate::skills::SKILLS_DIR);
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("s.json"), "{}").unwrap();
        let cache = root.path().join(crate::skills_team::CACHE_DIR).join("nan");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join("index.json"), "{}").unwrap();

        let a = login(root.path(), "nan", "user-a");
        assert!(!a.fresh, "legacy data was claimed");
        let a_dir = realm_dir(root.path(), &realm_hash("nan:user-a"));
        assert!(a_dir.join("skills/s.json").is_file());
        assert!(a_dir.join("skills-cache/nan/index.json").is_file());
        assert!(!skills.exists() && !cache.exists(), "moved, not copied");

        // A second user of the same tenant: fresh, gets none of it.
        let b = login(root.path(), "nan", "user-b");
        assert!(b.fresh);
        let b_dir = realm_dir(root.path(), &realm_hash("nan:user-b"));
        assert!(!b_dir.join("skills").exists());
        assert!(!b_dir.join("skills-cache").exists());
    }

    #[test]
    fn a_different_user_never_claims_legacy_data_left_behind() {
        // An interrupted claim leaves legacy skills on disk while user A is
        // already bound: user B must not receive them, A's re-login does.
        let root = TempDir::new().unwrap();
        login(root.path(), "nan", "user-a");
        let skills = root.path().join(crate::skills::SKILLS_DIR);
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(skills.join("late.json"), "{}").unwrap();

        login(root.path(), "nan", "user-b");
        let b_dir = realm_dir(root.path(), &realm_hash("nan:user-b"));
        assert!(!b_dir.join("skills").exists(), "B gets nothing legacy");
        assert!(skills.join("late.json").is_file());
    }

    #[test]
    fn memory_settings_are_copied_not_moved() {
        let root = TempDir::new().unwrap();
        std::fs::write(root.path().join(crate::memory::SETTINGS_FILE), "{}").unwrap();
        login(root.path(), "nan", "user-a");
        let a_dir = realm_dir(root.path(), &realm_hash("nan:user-a"));
        assert!(a_dir.join(crate::memory::SETTINGS_FILE).is_file());
        assert!(root.path().join(crate::memory::SETTINGS_FILE).is_file());
    }

    #[cfg(unix)]
    #[test]
    fn realm_folders_are_private() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = TempDir::new().unwrap();
        login(root.path(), "nan", "user-a");
        let dir = realm_dir(root.path(), &realm_hash("nan:user-a"));
        let mode = std::fs::metadata(dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }
}
