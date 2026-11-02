//! Credential storage (round 5): ONE encrypted vault, ONE master key.
//!
//! # Why
//!
//! Until round 5 every secret (per-profile inference key, per-profile login
//! session JWT) was its own OS keychain item, read on every chat send, every
//! profile listing and every platform call. On macOS each item carries its
//! own access-control list bound to the binary's code signature, so a user
//! could be asked for their keychain password twice per launch (session +
//! inference key), and in development every rebuild changed the signature so
//! "Always Allow" never stuck.
//!
//! # Design
//!
//! * **One master key.** A random 32-byte AES-256 key, created on first use
//!   from the OS CSPRNG and cached in process memory after the first read:
//!   - release builds: a single keychain item (service
//!     [`profile::KEYRING_SERVICE`], account [`MASTER_KEY_ACCOUNT`]). With a
//!     stable, signed binary "Always Allow" is asked at most once, ever;
//!   - debug builds (`debug_assertions`): a `0600` file
//!     (`app-data/vault.key`) — zero prompts while developing.
//! * **One vault file.** Every credential lives in `app-data/vault.bin`
//!   (`0600`), an AES-256-GCM sealed JSON map. Envelope (version 1):
//!   `MAGIC (8 bytes) | VERSION (1 byte) | NONCE (12 bytes) | CIPHERTEXT+TAG`,
//!   with `MAGIC | VERSION` bound as associated data so neither can be
//!   swapped. A fresh random nonce is drawn for every write. Writes are
//!   atomic (temp file in the same dir, `fsync`, `rename`) and serialized by
//!   a process-wide lock, so a crash or a concurrent write can never leave a
//!   torn file behind.
//! * **Fail closed, never panic.** A vault that cannot be decrypted (tampered,
//!   truncated, unknown version, master key replaced) reads as EMPTY: the
//!   user is simply logged out and the next sign-in rewrites a clean vault.
//! * **Swappable seam.** Callers only see [`CredentialStore`]. [`Vault`] is
//!   the production implementation; [`KeyringStore`] keeps the
//!   one-item-per-secret keychain story available (and is what the one-time
//!   migration reads from).
//! * **Migration.** On the first vault access of a process, if the vault has
//!   never been migrated, the pre-round-5 keychain items are read, written
//!   into the vault, and then deleted from the keychain (best-effort and
//!   silent: any failure just means "log in again"). A persisted flag inside
//!   the vault makes this a one-time probe.
//!
//! # Threat model (also in SECURITY.md)
//!
//! Protects against: other local users / processes running as another user
//! (file mode `0600` + the master key is not in the file), and leakage of the
//! app-data dir through backups, cloud sync or a copied home folder (the
//! vault is ciphertext; in release builds the key stays in the keychain,
//! which is not synced with the file).
//!
//! Does NOT protect against: root, or malware running as the same user —
//! such code can ask the keychain for the master key under the app's
//! identity or read process memory. This is the same tradeoff mainstream
//! desktop AI clients make; per-item keychain ACLs bought little extra here
//! at a large UX cost. In debug builds the master key sits next to the vault,
//! so the vault only adds the `0600` guarantee — acceptable for development.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::{Deserialize, Serialize};

use crate::profile;

/// Vault file name inside the app data dir.
pub const VAULT_FILE: &str = "vault.bin";
/// Debug-build master key file name inside the app data dir.
pub const DEV_MASTER_KEY_FILE: &str = "vault.key";
/// Keychain account holding the release-build master key (base64).
pub const MASTER_KEY_ACCOUNT: &str = "vault-master-key";

const MAGIC: &[u8; 8] = b"HCDVAULT";
const ENVELOPE_VERSION: u8 = 1;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = MAGIC.len() + 1;

/// A local credential-storage failure. Never carries secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredError {
    /// The store was never initialized (app data dir unresolvable).
    NotInitialized,
    /// The master key could not be read or created (e.g. keychain access
    /// denied). The vault is left untouched.
    MasterKey(String),
    /// A filesystem or platform-store failure.
    Io(String),
}

impl std::fmt::Display for CredError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CredError::NotInitialized => write!(f, "credential store not initialized"),
            CredError::MasterKey(msg) => write!(f, "credential master key unavailable: {msg}"),
            CredError::Io(msg) => write!(f, "credential store I/O error: {msg}"),
        }
    }
}

impl std::error::Error for CredError {}

/// The seam every caller goes through. `get` returns `Ok(None)` for "no such
/// credential" — including an unreadable vault (logged out), so callers only
/// need to handle real, actionable failures as `Err`.
pub trait CredentialStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, CredError>;
    fn set(&self, account: &str, secret: &str) -> Result<(), CredError>;
    /// Deleting a missing credential is a no-op.
    fn delete(&self, account: &str) -> Result<(), CredError>;

    /// Store several credentials. Implementations should make this atomic
    /// (all or nothing); the default is a best-effort loop that rolls back
    /// earlier writes on failure.
    fn set_many(&self, entries: &[(&str, &str)]) -> Result<(), CredError> {
        for (i, (account, secret)) in entries.iter().enumerate() {
            if let Err(err) = self.set(account, secret) {
                for (written, _) in &entries[..i] {
                    let _ = self.delete(written);
                }
                return Err(err);
            }
        }
        Ok(())
    }

    /// Delete several credentials (missing ones are a no-op).
    fn delete_many(&self, accounts: &[&str]) -> Result<(), CredError> {
        for account in accounts {
            self.delete(account)?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Master key providers
// ---------------------------------------------------------------------------

/// Where the vault's 32-byte master key comes from.
pub trait MasterKeyProvider: Send + Sync {
    /// Return the master key, creating and persisting a fresh random one
    /// when none exists yet. Must NEVER silently replace a key it merely
    /// failed to read (that would orphan a valid vault).
    fn load_or_create(&self) -> Result<[u8; KEY_LEN], CredError>;
}

fn random_bytes<const N: usize>() -> Result<[u8; N], CredError> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|err| CredError::Io(format!("os rng: {err}")))?;
    Ok(buf)
}

/// Debug builds: the master key in a `0600` file (no keychain, no prompts).
pub struct FileMasterKey {
    path: PathBuf,
}

impl FileMasterKey {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl MasterKeyProvider for FileMasterKey {
    fn load_or_create(&self) -> Result<[u8; KEY_LEN], CredError> {
        match std::fs::read(&self.path) {
            Ok(bytes) if bytes.len() == KEY_LEN => {
                let mut key = [0u8; KEY_LEN];
                key.copy_from_slice(&bytes);
                return Ok(key);
            }
            // A malformed key file cannot decrypt anything: replace it (the
            // vault then reads as empty → clean re-login).
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(CredError::MasterKey(err.to_string())),
        }
        let key = random_bytes::<KEY_LEN>()?;
        write_atomic(&self.path, &key).map_err(|err| CredError::MasterKey(err.to_string()))?;
        Ok(key)
    }
}

/// Release builds: the master key as ONE keychain item (base64).
pub struct KeychainMasterKey {
    service: String,
    account: String,
}

impl KeychainMasterKey {
    pub fn new(service: &str, account: &str) -> Self {
        Self {
            service: service.to_string(),
            account: account.to_string(),
        }
    }
}

impl MasterKeyProvider for KeychainMasterKey {
    fn load_or_create(&self) -> Result<[u8; KEY_LEN], CredError> {
        let entry = keyring::Entry::new(&self.service, &self.account)
            .map_err(|err| CredError::MasterKey(err.to_string()))?;
        match entry.get_password() {
            Ok(encoded) => {
                if let Ok(bytes) = BASE64_STANDARD.decode(encoded.trim())
                    && bytes.len() == KEY_LEN
                {
                    let mut key = [0u8; KEY_LEN];
                    key.copy_from_slice(&bytes);
                    return Ok(key);
                }
                // Malformed item: unusable for decryption, replace below.
            }
            Err(keyring::Error::NoEntry) => {}
            // Denied / locked / platform failure: do NOT create a new key.
            Err(err) => return Err(CredError::MasterKey(err.to_string())),
        }
        let key = random_bytes::<KEY_LEN>()?;
        entry
            .set_password(&BASE64_STANDARD.encode(key))
            .map_err(|err| CredError::MasterKey(err.to_string()))?;
        Ok(key)
    }
}

// ---------------------------------------------------------------------------
// Keychain store (one item per secret) — the legacy / swappable backend
// ---------------------------------------------------------------------------

/// One OS keychain item per credential. Pre-round-5 storage; kept behind the
/// same seam so the platform story stays swappable and so the migration can
/// read (and then delete) the old items.
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, CredError> {
        keyring::Entry::new(&self.service, account).map_err(|err| CredError::Io(err.to_string()))
    }
}

impl CredentialStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, CredError> {
        match self.entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(CredError::Io(err.to_string())),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), CredError> {
        self.entry(account)?
            .set_password(secret)
            .map_err(|err| CredError::Io(err.to_string()))
    }

    fn delete(&self, account: &str) -> Result<(), CredError> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(CredError::Io(err.to_string())),
        }
    }
}

// ---------------------------------------------------------------------------
// The vault
// ---------------------------------------------------------------------------

/// Decrypted vault contents.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct VaultData {
    #[serde(default)]
    entries: BTreeMap<String, String>,
    /// Set once the pre-round-5 keychain items were probed (and migrated),
    /// so the keychain is never queried for them again.
    #[serde(default)]
    legacy_migrated: bool,
}

/// Serializes every vault read-modify-write in the process (across `Vault`
/// instances too), so concurrent writers can never lose each other's
/// updates or interleave a rename.
static VAULT_IO: Mutex<()> = Mutex::new(());

/// Legacy keychain source for the one-time migration.
struct Legacy {
    store: Box<dyn CredentialStore>,
    accounts: Vec<String>,
}

/// The single-encryptor credential vault (see the module docs).
pub struct Vault {
    path: PathBuf,
    master: Box<dyn MasterKeyProvider>,
    /// Cached after the first successful load: one keychain access per
    /// process at most.
    key: Mutex<Option<[u8; KEY_LEN]>>,
    legacy: Option<Legacy>,
    /// The migration probe already ran in this process.
    migration_checked: Mutex<bool>,
}

impl Vault {
    pub fn new(path: PathBuf, master: Box<dyn MasterKeyProvider>) -> Self {
        Self {
            path,
            master,
            key: Mutex::new(None),
            legacy: None,
            migration_checked: Mutex::new(false),
        }
    }

    /// Attach the pre-round-5 store to migrate `accounts` from on first use.
    pub fn with_legacy(mut self, store: Box<dyn CredentialStore>, accounts: Vec<String>) -> Self {
        self.legacy = Some(Legacy { store, accounts });
        self
    }

    fn master_key(&self) -> Result<[u8; KEY_LEN], CredError> {
        let mut cached = self.key.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(key) = *cached {
            return Ok(key);
        }
        let key = self.master.load_or_create()?;
        *cached = Some(key);
        Ok(key)
    }

    /// Read + decrypt. Missing, unreadable or undecryptable → empty
    /// (logged out); never an error, never a panic.
    fn load(&self, key: &[u8; KEY_LEN]) -> VaultData {
        let Ok(bytes) = std::fs::read(&self.path) else {
            return VaultData::default();
        };
        open_envelope(key, &bytes)
            .and_then(|plain| serde_json::from_slice(&plain).ok())
            .unwrap_or_default()
    }

    fn store(&self, key: &[u8; KEY_LEN], data: &VaultData) -> Result<(), CredError> {
        let plain = serde_json::to_vec(data).map_err(|err| CredError::Io(err.to_string()))?;
        let sealed = seal_envelope(key, &plain)?;
        write_atomic(&self.path, &sealed).map_err(|err| CredError::Io(err.to_string()))
    }

    /// One-time, best-effort, silent migration of the legacy keychain items.
    /// Called with `VAULT_IO` held.
    fn ensure_migrated(&self, key: &[u8; KEY_LEN]) {
        let Some(legacy) = &self.legacy else { return };
        let mut checked = self
            .migration_checked
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        if *checked {
            return;
        }
        *checked = true;

        let mut data = self.load(key);
        if data.legacy_migrated {
            return;
        }
        let mut found = Vec::new();
        for account in &legacy.accounts {
            if data.entries.contains_key(account) {
                continue;
            }
            // Any read failure (denied prompt, locked keychain) is treated as
            // "nothing to migrate": the user can simply sign in again.
            if let Ok(Some(secret)) = legacy.store.get(account)
                && !secret.is_empty()
            {
                data.entries.insert(account.clone(), secret);
                found.push(account.clone());
            }
        }
        data.legacy_migrated = true;
        // Delete the old items only once their copies are safely persisted.
        if self.store(key, &data).is_ok() {
            for account in &found {
                let _ = legacy.store.delete(account);
            }
        }
    }

    /// Run `f` on the decrypted data with the process-wide lock held; when
    /// `f` returns `true` the data is re-sealed and written atomically.
    fn with_data<T>(&self, f: impl FnOnce(&mut VaultData) -> (T, bool)) -> Result<T, CredError> {
        let _guard = VAULT_IO.lock().unwrap_or_else(|p| p.into_inner());
        let key = self.master_key()?;
        self.ensure_migrated(&key);
        let mut data = self.load(&key);
        let (out, dirty) = f(&mut data);
        if dirty {
            self.store(&key, &data)?;
        }
        Ok(out)
    }
}

impl CredentialStore for Vault {
    fn get(&self, account: &str) -> Result<Option<String>, CredError> {
        self.with_data(|data| (data.entries.get(account).cloned(), false))
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), CredError> {
        self.set_many(&[(account, secret)])
    }

    fn delete(&self, account: &str) -> Result<(), CredError> {
        self.delete_many(&[account])
    }

    /// Atomic: all entries land in one sealed write, or none do.
    fn set_many(&self, entries: &[(&str, &str)]) -> Result<(), CredError> {
        self.with_data(|data| {
            for (account, secret) in entries {
                data.entries
                    .insert((*account).to_string(), (*secret).to_string());
            }
            ((), true)
        })
    }

    fn delete_many(&self, accounts: &[&str]) -> Result<(), CredError> {
        self.with_data(|data| {
            let mut dirty = false;
            for account in accounts {
                dirty |= data.entries.remove(*account).is_some();
            }
            ((), dirty)
        })
    }
}

fn header() -> [u8; HEADER_LEN] {
    let mut h = [0u8; HEADER_LEN];
    h[..MAGIC.len()].copy_from_slice(MAGIC);
    h[MAGIC.len()] = ENVELOPE_VERSION;
    h
}

fn cipher(key: &[u8; KEY_LEN]) -> Aes256Gcm {
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
}

/// `MAGIC | VERSION | NONCE | AES-256-GCM(plain, aad = MAGIC | VERSION)`.
fn seal_envelope(key: &[u8; KEY_LEN], plain: &[u8]) -> Result<Vec<u8>, CredError> {
    let nonce = random_bytes::<NONCE_LEN>()?;
    let head = header();
    let ciphertext = cipher(key)
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: &head,
            },
        )
        .map_err(|_| CredError::Io("vault encryption failed".to_string()))?;
    let mut out = Vec::with_capacity(HEADER_LEN + NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&head);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Inverse of [`seal_envelope`]; `None` for anything not authentic.
fn open_envelope(key: &[u8; KEY_LEN], bytes: &[u8]) -> Option<Vec<u8>> {
    let head = header();
    if bytes.len() < HEADER_LEN + NONCE_LEN || bytes[..HEADER_LEN] != head {
        return None;
    }
    let (nonce, ciphertext) = bytes[HEADER_LEN..].split_at(NONCE_LEN);
    cipher(key)
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: &head,
            },
        )
        .ok()
}

/// Write `bytes` to `path` atomically with mode `0600`: unique temp file in
/// the same directory, `fsync`, then `rename` over the target.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("vault path has no parent dir"))?;
    std::fs::create_dir_all(dir)?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("vault");
    let tmp = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let result = write_private(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Create `path` (must not exist) with mode `0600`, write and `fsync` it.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

// ---------------------------------------------------------------------------
// Process-wide store
// ---------------------------------------------------------------------------

static GLOBAL: OnceLock<Vault> = OnceLock::new();

/// Every legacy keychain account the pre-round-5 app may have written.
fn legacy_accounts() -> Vec<String> {
    profile::canonical_profiles()
        .iter()
        .flat_map(|p| [profile::key_account(&p.id), profile::session_account(&p.id)])
        .collect()
}

/// The production vault for `app_data_dir`: dev builds keep the master key
/// in a file, release builds in one keychain item.
pub fn production_vault(app_data_dir: &Path) -> Vault {
    let master: Box<dyn MasterKeyProvider> = if cfg!(debug_assertions) {
        Box::new(FileMasterKey::new(app_data_dir.join(DEV_MASTER_KEY_FILE)))
    } else {
        Box::new(KeychainMasterKey::new(
            profile::KEYRING_SERVICE,
            MASTER_KEY_ACCOUNT,
        ))
    };
    Vault::new(app_data_dir.join(VAULT_FILE), master).with_legacy(
        Box::new(KeyringStore::new(profile::KEYRING_SERVICE)),
        legacy_accounts(),
    )
}

/// Install the process-wide vault (called once from the Tauri `setup`).
/// Nothing touches the keychain or disk until the first credential access.
pub fn init(app_data_dir: &Path) {
    let _ = GLOBAL.set(production_vault(app_data_dir));
}

/// The process-wide credential store.
pub fn store() -> Result<&'static dyn CredentialStore, CredError> {
    GLOBAL
        .get()
        .map(|vault| vault as &dyn CredentialStore)
        .ok_or(CredError::NotInitialized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn vault_in(dir: &TempDir) -> Vault {
        Vault::new(
            dir.path().join(VAULT_FILE),
            Box::new(FileMasterKey::new(dir.path().join(DEV_MASTER_KEY_FILE))),
        )
    }

    /// In-memory stand-in for the legacy keychain.
    #[derive(Default, Clone)]
    struct FakeKeychain {
        items: Arc<Mutex<BTreeMap<String, String>>>,
        reads: Arc<Mutex<u32>>,
        fail_reads: bool,
    }

    impl CredentialStore for FakeKeychain {
        fn get(&self, account: &str) -> Result<Option<String>, CredError> {
            *self.reads.lock().unwrap() += 1;
            if self.fail_reads {
                return Err(CredError::Io("denied".into()));
            }
            Ok(self.items.lock().unwrap().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), CredError> {
            self.items
                .lock()
                .unwrap()
                .insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), CredError> {
            self.items.lock().unwrap().remove(account);
            Ok(())
        }
    }

    /// A master key provider that always fails (denied keychain).
    struct DeniedKey;
    impl MasterKeyProvider for DeniedKey {
        fn load_or_create(&self) -> Result<[u8; KEY_LEN], CredError> {
            Err(CredError::MasterKey("denied".into()))
        }
    }

    #[test]
    fn roundtrip_set_get_delete() {
        let dir = TempDir::new().unwrap();
        let vault = vault_in(&dir);

        assert_eq!(vault.get("nan").unwrap(), None);
        vault.set("nan", "sk-secret-1234").unwrap();
        vault.set("nan.session", "jwt.token").unwrap();
        assert_eq!(vault.get("nan").unwrap().as_deref(), Some("sk-secret-1234"));

        // A fresh instance (new process) reads the same values from disk.
        let reopened = vault_in(&dir);
        assert_eq!(
            reopened.get("nan.session").unwrap().as_deref(),
            Some("jwt.token")
        );

        reopened.delete("nan").unwrap();
        reopened.delete("never-existed").unwrap();
        assert_eq!(vault.get("nan").unwrap(), None);
        assert_eq!(
            vault.get("nan.session").unwrap().as_deref(),
            Some("jwt.token")
        );
    }

    #[test]
    fn vault_file_is_ciphertext_with_versioned_envelope() {
        let dir = TempDir::new().unwrap();
        let vault = vault_in(&dir);
        vault.set("nan", "sk-plaintext-must-not-leak").unwrap();

        let bytes = std::fs::read(dir.path().join(VAULT_FILE)).unwrap();
        assert_eq!(&bytes[..8], MAGIC);
        assert_eq!(bytes[8], ENVELOPE_VERSION);
        let needle = b"sk-plaintext-must-not-leak";
        assert!(!bytes.windows(needle.len()).any(|w| w == needle));
    }

    #[test]
    fn every_write_uses_a_fresh_nonce() {
        let dir = TempDir::new().unwrap();
        let vault = vault_in(&dir);
        vault.set("a", "same").unwrap();
        let first = std::fs::read(dir.path().join(VAULT_FILE)).unwrap();
        vault.set("a", "same").unwrap();
        let second = std::fs::read(dir.path().join(VAULT_FILE)).unwrap();
        assert_ne!(
            first[HEADER_LEN..HEADER_LEN + NONCE_LEN],
            second[HEADER_LEN..HEADER_LEN + NONCE_LEN]
        );
        assert_ne!(first, second);
    }

    #[cfg(unix)]
    #[test]
    fn vault_and_dev_key_files_are_0600() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = TempDir::new().unwrap();
        vault_in(&dir).set("a", "b").unwrap();
        for file in [VAULT_FILE, DEV_MASTER_KEY_FILE] {
            let mode = std::fs::metadata(dir.path().join(file))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{file}");
        }
    }

    #[test]
    fn tampered_vault_reads_as_logged_out_and_recovers_on_next_login() {
        let dir = TempDir::new().unwrap();
        let vault = vault_in(&dir);
        vault.set("nan", "sk-1").unwrap();

        let path = dir.path().join(VAULT_FILE);
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01; // flip one ciphertext/tag bit
        std::fs::write(path, bytes).unwrap();

        let reopened = vault_in(&dir);
        assert_eq!(reopened.get("nan").unwrap(), None, "tamper → logged out");
        // Clean re-login: the next write produces a valid vault again.
        reopened.set("nan", "sk-2").unwrap();
        assert_eq!(vault_in(&dir).get("nan").unwrap().as_deref(), Some("sk-2"));
    }

    #[test]
    fn malformed_files_never_panic_and_read_as_empty() {
        let head = header();
        let mut wrong_version = head.to_vec();
        wrong_version[MAGIC.len()] = 99;
        wrong_version.extend_from_slice(&[0u8; 40]);
        let cases: Vec<Vec<u8>> = vec![
            vec![],
            b"garbage".to_vec(),
            // Header only, no nonce.
            head.to_vec(),
            // Nonce but no tag.
            [&head[..], &[0u8; NONCE_LEN][..]].concat(),
            wrong_version,
            vec![0xff; 4096],
        ];
        for bytes in cases {
            let dir = TempDir::new().unwrap();
            std::fs::write(dir.path().join(VAULT_FILE), bytes).unwrap();
            let vault = vault_in(&dir);
            assert_eq!(vault.get("nan").unwrap(), None);
            vault.set("nan", "fresh").unwrap();
            assert_eq!(vault.get("nan").unwrap().as_deref(), Some("fresh"));
        }
    }

    #[test]
    fn version_byte_is_authenticated() {
        let key = [7u8; KEY_LEN];
        let mut sealed = seal_envelope(&key, b"{}").unwrap();
        assert!(open_envelope(&key, &sealed).is_some());
        sealed[MAGIC.len()] = 2;
        assert!(open_envelope(&key, &sealed).is_none());
    }

    #[test]
    fn replaced_master_key_reads_as_logged_out() {
        let dir = TempDir::new().unwrap();
        vault_in(&dir).set("nan", "sk-1").unwrap();
        // The master key is gone (keychain item deleted / new machine).
        std::fs::remove_file(dir.path().join(DEV_MASTER_KEY_FILE)).unwrap();
        let vault = vault_in(&dir);
        assert_eq!(vault.get("nan").unwrap(), None);
        vault.set("nan", "sk-2").unwrap();
        assert_eq!(vault_in(&dir).get("nan").unwrap().as_deref(), Some("sk-2"));
    }

    #[test]
    fn malformed_dev_key_file_is_replaced() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(DEV_MASTER_KEY_FILE), b"short").unwrap();
        let vault = vault_in(&dir);
        vault.set("a", "b").unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(DEV_MASTER_KEY_FILE))
                .unwrap()
                .len(),
            KEY_LEN
        );
        assert_eq!(vault_in(&dir).get("a").unwrap().as_deref(), Some("b"));
    }

    #[test]
    fn denied_master_key_is_an_error_and_leaves_the_vault_untouched() {
        let dir = TempDir::new().unwrap();
        vault_in(&dir).set("nan", "sk-1").unwrap();
        let before = std::fs::read(dir.path().join(VAULT_FILE)).unwrap();

        let denied = Vault::new(dir.path().join(VAULT_FILE), Box::new(DeniedKey));
        assert!(matches!(denied.get("nan"), Err(CredError::MasterKey(_))));
        assert!(denied.set("nan", "x").is_err());

        assert_eq!(std::fs::read(dir.path().join(VAULT_FILE)).unwrap(), before);
        assert_eq!(vault_in(&dir).get("nan").unwrap().as_deref(), Some("sk-1"));
    }

    #[test]
    fn set_many_is_a_single_atomic_write() {
        let dir = TempDir::new().unwrap();
        let vault = vault_in(&dir);
        vault
            .set_many(&[("nan", "sk-1"), ("nan.session", "jwt")])
            .unwrap();
        assert_eq!(vault.get("nan").unwrap().as_deref(), Some("sk-1"));
        assert_eq!(vault.get("nan.session").unwrap().as_deref(), Some("jwt"));
        vault.delete_many(&["nan", "nan.session"]).unwrap();
        assert_eq!(vault.get("nan").unwrap(), None);
        assert_eq!(vault.get("nan.session").unwrap(), None);
    }

    #[test]
    fn migration_moves_legacy_items_into_the_vault_and_deletes_them() {
        let dir = TempDir::new().unwrap();
        let legacy = FakeKeychain::default();
        legacy.set("nan", "sk-legacy").unwrap();
        legacy.set("nan.session", "jwt-legacy").unwrap();
        legacy.set("unrelated", "keep-me").unwrap();

        let accounts: Vec<String> = vec!["nan".into(), "nan.session".into(), "helmcode".into()];
        let vault = vault_in(&dir).with_legacy(Box::new(legacy.clone()), accounts.clone());

        assert_eq!(vault.get("nan").unwrap().as_deref(), Some("sk-legacy"));
        assert_eq!(
            vault.get("nan.session").unwrap().as_deref(),
            Some("jwt-legacy")
        );
        assert_eq!(vault.get("helmcode").unwrap(), None);
        {
            let items = legacy.items.lock().unwrap();
            assert!(!items.contains_key("nan"), "migrated item deleted");
            assert!(!items.contains_key("nan.session"));
            assert_eq!(items.get("unrelated").map(String::as_str), Some("keep-me"));
        }

        // Probed once per process: later accesses never touch the keychain.
        let reads_after_first = *legacy.reads.lock().unwrap();
        vault.get("nan").unwrap();
        vault.set("x", "y").unwrap();
        assert_eq!(*legacy.reads.lock().unwrap(), reads_after_first);

        // And once ever: a new process sees the persisted flag.
        legacy.set("helmcode", "sk-late").unwrap();
        let reads_before = *legacy.reads.lock().unwrap();
        let next_launch = vault_in(&dir).with_legacy(Box::new(legacy.clone()), accounts);
        assert_eq!(next_launch.get("helmcode").unwrap(), None);
        assert_eq!(*legacy.reads.lock().unwrap(), reads_before);
    }

    #[test]
    fn migration_never_overwrites_newer_vault_values() {
        let dir = TempDir::new().unwrap();
        // Vault already has a value but was never migrated (flag unset):
        // simulate by writing through a vault without legacy attached.
        vault_in(&dir).set("nan", "sk-new").unwrap();
        let legacy = FakeKeychain::default();
        legacy.set("nan", "sk-old").unwrap();
        let vault = vault_in(&dir).with_legacy(Box::new(legacy), vec!["nan".into()]);
        assert_eq!(vault.get("nan").unwrap().as_deref(), Some("sk-new"));
    }

    #[test]
    fn failed_legacy_reads_are_silent_and_not_retried() {
        let dir = TempDir::new().unwrap();
        let legacy = FakeKeychain {
            fail_reads: true,
            ..FakeKeychain::default()
        };
        let vault = vault_in(&dir).with_legacy(Box::new(legacy.clone()), vec!["nan".into()]);
        assert_eq!(vault.get("nan").unwrap(), None);
        let reads = *legacy.reads.lock().unwrap();
        let next_launch = vault_in(&dir).with_legacy(Box::new(legacy.clone()), vec!["nan".into()]);
        assert_eq!(next_launch.get("nan").unwrap(), None);
        assert_eq!(*legacy.reads.lock().unwrap(), reads, "no repeated prompts");
    }

    #[test]
    fn concurrent_writers_never_lose_updates_or_tear_the_file() {
        let dir = TempDir::new().unwrap();
        // Two independent instances on the same file (worst case) plus a
        // raw reader that must always find a complete, authentic envelope.
        let a = Arc::new(vault_in(&dir));
        let b = Arc::new(vault_in(&dir));
        a.set("seed", "0").unwrap();
        let key: [u8; KEY_LEN] = std::fs::read(dir.path().join(DEV_MASTER_KEY_FILE))
            .unwrap()
            .try_into()
            .unwrap();

        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = {
            let path = dir.path().join(VAULT_FILE);
            let stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let mut reads = 0u32;
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let bytes = std::fs::read(&path).unwrap();
                    assert!(open_envelope(&key, &bytes).is_some(), "torn vault file");
                    reads += 1;
                }
                reads
            })
        };

        let writers: Vec<_> = (0..8)
            .map(|t| {
                let vault = if t % 2 == 0 {
                    Arc::clone(&a)
                } else {
                    Arc::clone(&b)
                };
                std::thread::spawn(move || {
                    for i in 0..20 {
                        vault.set(&format!("t{t}-{i}"), &format!("v{i}")).unwrap();
                    }
                })
            })
            .collect();
        for w in writers {
            w.join().unwrap();
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(reader.join().unwrap() > 0);

        let check = vault_in(&dir);
        for t in 0..8 {
            for i in 0..20 {
                assert_eq!(
                    check.get(&format!("t{t}-{i}")).unwrap(),
                    Some(format!("v{i}"))
                );
            }
        }
        // No temp files left behind.
        let leftovers = std::fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp")
            })
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn uninitialized_global_store_is_an_error_not_a_panic() {
        // GLOBAL is never initialized in unit tests.
        assert!(matches!(store(), Err(CredError::NotInitialized)));
    }

    #[test]
    fn legacy_accounts_cover_both_profiles_key_and_session() {
        assert_eq!(
            legacy_accounts(),
            vec!["nan", "nan.session", "helmcode", "helmcode.session"]
        );
    }
}
