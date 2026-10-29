//! Profile store (T3b, S2/S12): the app talks to exactly two owned tenants.
//!
//! `profiles.json` (schema v2) in the app data dir persists the canonical
//! profile list next to the active profile id. The profile definitions are
//! compiled-in constants: there is deliberately no API to add, edit or
//! remove profiles and no user-configurable endpoint anywhere, so the binary
//! cannot be pointed at anything but the two owned tenants (S2/S12).
//!
//! Any pre-existing v1 document (custom profiles, `base_url` fields) is
//! migrated on load: rewritten to v2 with custom profiles dropped and the
//! active id kept only when it is one of the two known ids.
//!
//! Secrets never live in this file (S4): the inference API key is stored in
//! the OS keychain under [`KEYRING_SERVICE`] with account = profile id, and
//! the login session JWT under account = `<profile-id>.session`.
//!
//! Everything here is pure logic (seed / parse / migrate / validate / mutate)
//! or path-injected file I/O, free of Tauri types, so it can be unit-tested
//! against a temp dir. Tauri glue (resolving the app data dir, keyring
//! access) lives in `lib.rs` / `device_flow.rs`.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Keychain service all profile credentials are stored under (S4). The
/// account is the profile id for the inference key (see [`key_account`]) and
/// `<profile-id>.session` for the login session JWT (see [`session_account`]).
pub const KEYRING_SERVICE: &str = "com.helmcode.nan.desktop";

/// Config file name inside the app data dir.
pub const STORE_FILE: &str = "profiles.json";

/// Current on-disk schema version. A file without this exact version is
/// migrated (rewritten) on load.
pub const STORE_VERSION: u32 = 2;

// ---------------------------------------------------------------------------
// The two locked profiles (S2). Constants on purpose: no code path can widen
// this set, and no base URL ever crosses the IPC boundary to the renderer.
// ---------------------------------------------------------------------------

pub const NAN_ID: &str = "nan";
pub const NAN_NAME: &str = "NaN community";
/// Device-flow + account platform for the NaN community (hosts
/// `/api/auth/device/*`).
pub const NAN_PLATFORM_BASE: &str = "https://cloud-api.nan.builders";
/// OpenAI-compatible inference root for the NaN community (hosts
/// `/v1/chat/completions`, …).
pub const NAN_INFERENCE_BASE: &str = "https://api.nan.builders/v1";

pub const HELMCODE_ID: &str = "helmcode";
pub const HELMCODE_NAME: &str = "Helmcode enterprise";
/// Device-flow + account platform for Helmcode enterprise (hosts
/// `/api/auth/device/*`).
pub const HELMCODE_PLATFORM_BASE: &str = "https://cloud-api.helmcode.com";
/// OpenAI-compatible inference root for Helmcode enterprise.
pub const HELMCODE_INFERENCE_BASE: &str = "https://api.helmcode.com/v1";

/// One inference tenant: where sign-in happens and where inference calls go.
/// Both URLs are compiled-in; the renderer never receives them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub platform_base: String,
    pub inference_base: String,
}

/// The exactly-two locked profiles, in display order (S2).
pub fn canonical_profiles() -> Vec<Profile> {
    vec![
        Profile {
            id: NAN_ID.to_string(),
            name: NAN_NAME.to_string(),
            platform_base: NAN_PLATFORM_BASE.to_string(),
            inference_base: NAN_INFERENCE_BASE.to_string(),
        },
        Profile {
            id: HELMCODE_ID.to_string(),
            name: HELMCODE_NAME.to_string(),
            platform_base: HELMCODE_PLATFORM_BASE.to_string(),
            inference_base: HELMCODE_INFERENCE_BASE.to_string(),
        },
    ]
}

/// Look up a locked profile by id.
pub fn profile_by_id(id: &str) -> Option<Profile> {
    canonical_profiles().into_iter().find(|p| p.id == id)
}

/// The platform base (device-flow endpoints) of a locked profile.
pub fn platform_base_for(id: &str) -> Option<&'static str> {
    match id {
        NAN_ID => Some(NAN_PLATFORM_BASE),
        HELMCODE_ID => Some(HELMCODE_PLATFORM_BASE),
        _ => None,
    }
}

/// The inference base (chat/images/audio) of a locked profile.
pub fn inference_base_for(id: &str) -> Option<&'static str> {
    match id {
        NAN_ID => Some(NAN_INFERENCE_BASE),
        HELMCODE_ID => Some(HELMCODE_INFERENCE_BASE),
        _ => None,
    }
}

/// Whether `id` is one of the two locked profile ids.
pub fn is_known_profile_id(id: &str) -> bool {
    id == NAN_ID || id == HELMCODE_ID
}

// ---------------------------------------------------------------------------
// Store document
// ---------------------------------------------------------------------------

/// The on-disk store (`profiles.json` document, schema v2). The profile list
/// is always the canonical one; only `active_profile` is real user state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileStore {
    pub version: u32,
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub active_profile: Option<String>,
}

/// The store seeded on first run: the locked profiles, nothing active (S2).
pub fn default_store() -> ProfileStore {
    ProfileStore {
        version: STORE_VERSION,
        profiles: canonical_profiles(),
        active_profile: None,
    }
}

/// Parse a stored document. `None` means "treat as stale/corrupt": not valid
/// JSON, not schema v2, a profile list that is not exactly the canonical one,
/// or an active id that is not one of the two known ids.
pub fn parse_store(raw: &str) -> Option<ProfileStore> {
    let store: ProfileStore = serde_json::from_str(raw).ok()?;
    let locked = store.version == STORE_VERSION
        && store.profiles == canonical_profiles()
        && store
            .active_profile
            .as_ref()
            .is_none_or(|id| is_known_profile_id(id));
    locked.then_some(store)
}

/// Migrate any previously stored document (v1 with custom profiles, a
/// hand-tampered v2, or corrupt JSON) to the locked v2 store. The active id
/// survives only when it is one of the two known ids; everything else —
/// custom profiles, user-configured URLs — is dropped (S2/S12).
pub fn migrate_store(raw: &str) -> ProfileStore {
    let value: serde_json::Value = serde_json::from_str(raw).unwrap_or(serde_json::Value::Null);
    let active = value
        .get("active_profile")
        .and_then(|v| v.as_str())
        .filter(|id| is_known_profile_id(id))
        .map(str::to_string);
    ProfileStore {
        active_profile: active,
        ..default_store()
    }
}

/// Load the store from `dir`, creating or migrating `profiles.json` as
/// needed: a missing file is seeded with [`default_store`]; a file that is
/// not a valid locked v2 document is migrated (rewritten) on load. Only real
/// I/O failures are returned as `Err`.
pub fn load_or_seed(dir: &Path) -> Result<ProfileStore, String> {
    let path = dir.join(STORE_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            if let Some(store) = parse_store(&raw) {
                return Ok(store);
            }
            // Missing version (v1), tampered fields, custom profiles, an
            // unknown active id or corrupt JSON: rewrite the locked v2
            // document, keeping a valid active id when present.
            let store = migrate_store(&raw);
            save(dir, &store)?;
            Ok(store)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let store = default_store();
            save(dir, &store)?;
            Ok(store)
        }
        Err(err) => Err(err.to_string()),
    }
}

/// Persist `store` as pretty JSON under `dir`/`profiles.json`.
pub fn save(dir: &Path, store: &ProfileStore) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| err.to_string())?;
    let json = serde_json::to_string_pretty(store).map_err(|err| err.to_string())?;
    std::fs::write(dir.join(STORE_FILE), json).map_err(|err| err.to_string())
}

/// Keychain account for a profile's stored inference API key.
pub fn key_account(profile_id: &str) -> String {
    profile_id.to_string()
}

/// Keychain account for a profile's stored login session JWT.
pub fn session_account(profile_id: &str) -> String {
    format!("{profile_id}.session")
}

/// Mask a key for display: at most its last 4 characters. Keys of 4
/// characters or fewer are masked entirely so the mask never reveals the
/// whole secret.
pub fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() > 4 {
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("••••{tail}")
    } else {
        "••••".to_string()
    }
}

impl ProfileStore {
    /// Mark the profile `id` active. Fails for unknown ids without touching
    /// the current value (only the two locked ids are ever valid, S2).
    pub fn set_active_profile(&mut self, id: &str) -> Result<(), String> {
        if !self.profiles.iter().any(|p| p.id == id) {
            return Err(format!("unknown profile id: {id:?}"));
        }
        self.active_profile = Some(id.to_string());
        Ok(())
    }

    /// Clear the active profile (sign-out).
    pub fn clear_active_profile(&mut self) {
        self.active_profile = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn read_store(dir: &TempDir) -> String {
        std::fs::read_to_string(dir.path().join(STORE_FILE)).expect("store file readable")
    }

    #[test]
    fn constants_match_the_locked_spec() {
        // S2: the two tenants and their exact base URLs, platform without
        // /v1, inference with /v1. Nothing else may ever appear.
        assert_eq!(
            platform_base_for("nan"),
            Some("https://cloud-api.nan.builders")
        );
        assert_eq!(
            inference_base_for("nan"),
            Some("https://api.nan.builders/v1")
        );
        assert_eq!(
            platform_base_for("helmcode"),
            Some("https://cloud-api.helmcode.com")
        );
        assert_eq!(
            inference_base_for("helmcode"),
            Some("https://api.helmcode.com/v1")
        );
        assert_eq!(platform_base_for("anything-else"), None);
        assert_eq!(inference_base_for("anything-else"), None);
        let profiles = canonical_profiles();
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].id, "nan");
        assert_eq!(profiles[0].name, "NaN community");
        assert_eq!(profiles[1].id, "helmcode");
        assert_eq!(profiles[1].name, "Helmcode enterprise");
    }

    #[test]
    fn seeds_locked_v2_store_on_first_run() {
        let dir = TempDir::new().expect("temp dir");

        let store = load_or_seed(dir.path()).expect("seed");

        assert_eq!(store.version, STORE_VERSION);
        assert_eq!(store.profiles, canonical_profiles());
        assert_eq!(store.active_profile, None);

        // The seeded file must be on disk and re-parse to the same store.
        let reread = parse_store(&read_store(&dir)).expect("seeded file parses");
        assert_eq!(reread, store);
    }

    #[test]
    fn v1_store_with_custom_profiles_migrates_and_drops_them() {
        let dir = TempDir::new().expect("temp dir");
        // A T3-era v1 document: custom profile with a user-supplied URL, and
        // that custom profile active.
        let v1 = r#"{"profiles":[{"id":"nan","name":"NaN community","base_url":"https://api.nan.builders/v1"},{"id":"helmcode","name":"Helmcode enterprise","base_url":"https://api.helmcode.com/v1"},{"id":"my-lab","name":"My Lab","base_url":"http://127.0.0.1:9999/v1"}],"active_profile":"my-lab"}"#;
        std::fs::create_dir_all(dir.path()).expect("dir");
        std::fs::write(dir.path().join(STORE_FILE), v1).expect("write");

        let store = load_or_seed(dir.path()).expect("migrate");

        assert_eq!(store.version, STORE_VERSION);
        assert_eq!(
            store.profiles,
            canonical_profiles(),
            "custom profile dropped"
        );
        assert_eq!(store.active_profile, None, "custom active id is not known");
        // The file must have been rewritten to the locked v2 document.
        let reread = parse_store(&read_store(&dir)).expect("migrated file parses");
        assert_eq!(reread, store);
    }

    #[test]
    fn v1_active_id_is_kept_only_when_known() {
        let dir = TempDir::new().expect("temp dir");
        let v1 = r#"{"profiles":[{"id":"nan","name":"NaN community","base_url":"https://api.nan.builders/v1"}],"active_profile":"helmcode"}"#;
        std::fs::create_dir_all(dir.path()).expect("dir");
        std::fs::write(dir.path().join(STORE_FILE), v1).expect("write");

        let store = load_or_seed(dir.path()).expect("migrate");
        assert_eq!(store.active_profile.as_deref(), Some("helmcode"));
    }

    #[test]
    fn tampered_v2_base_urls_are_rewritten_canonical() {
        let dir = TempDir::new().expect("temp dir");
        // A hand-edited v2 document pointing the nan profile somewhere else:
        // exactly what S12 must refuse.
        let tampered = format!(
            r#"{{"version":2,"profiles":[{{"id":"nan","name":"NaN community","platform_base":"https://evil.example.com","inference_base":"https://evil.example.com/v1"}},{},{}],"active_profile":"nan"}}"#,
            r#"{"id":"helmcode","name":"Helmcode enterprise","platform_base":"https://cloud-api.helmcode.com","inference_base":"https://api.helmcode.com/v1"}"#,
            r#"{"id":"nan","name":"NaN community","platform_base":"https://cloud-api.nan.builders","inference_base":"https://api.nan.builders/v1"}"#,
        );
        std::fs::create_dir_all(dir.path()).expect("dir");
        std::fs::write(dir.path().join(STORE_FILE), tampered).expect("write");

        let store = load_or_seed(dir.path()).expect("migrate");

        assert_eq!(store.profiles, canonical_profiles());
        assert_eq!(store.active_profile.as_deref(), Some("nan"));
        let reread = parse_store(&read_store(&dir)).expect("rewritten file parses");
        assert_eq!(reread, store, "tampered URLs must not survive on disk");
    }

    #[test]
    fn unknown_active_profile_id_is_rejected_and_rewritten() {
        let dir = TempDir::new().expect("temp dir");
        let bad = format!(
            r#"{{"version":2,"profiles":[{},{}],"active_profile":"root"}}"#,
            r#"{"id":"helmcode","name":"Helmcode enterprise","platform_base":"https://cloud-api.helmcode.com","inference_base":"https://api.helmcode.com/v1"}"#,
            r#"{"id":"nan","name":"NaN community","platform_base":"https://cloud-api.nan.builders","inference_base":"https://api.nan.builders/v1"}"#,
        );
        std::fs::create_dir_all(dir.path()).expect("dir");
        std::fs::write(dir.path().join(STORE_FILE), bad).expect("write");

        let store = load_or_seed(dir.path()).expect("migrate");
        assert_eq!(store.active_profile, None);
        assert_eq!(parse_store(&read_store(&dir)).expect("rewritten"), store);
    }

    #[test]
    fn corrupted_json_recovers_to_seed_and_rewrites_file() {
        let dir = TempDir::new().expect("temp dir");
        std::fs::create_dir_all(dir.path()).expect("dir");
        std::fs::write(dir.path().join(STORE_FILE), "{{{ not json at all").expect("write");

        let store = load_or_seed(dir.path()).expect("recover");
        assert_eq!(store, default_store());
        let reread = parse_store(&read_store(&dir)).expect("file readable after recovery");
        assert_eq!(reread, default_store());
    }

    #[test]
    fn set_and_clear_active_profile_roundtrip_through_the_file() {
        let dir = TempDir::new().expect("temp dir");

        let mut store = load_or_seed(dir.path()).expect("seed");
        store.set_active_profile("nan").expect("switch");
        save(dir.path(), &store).expect("save");

        let reloaded = load_or_seed(dir.path()).expect("reload");
        assert_eq!(reloaded.active_profile.as_deref(), Some("nan"));
    }

    #[test]
    fn set_active_profile_rejects_unknown_ids() {
        let mut store = default_store();

        assert!(store.set_active_profile("does-not-exist").is_err());
        assert_eq!(store.active_profile, None, "failed switch must not mutate");

        store.set_active_profile("helmcode").expect("valid id");
        assert_eq!(store.active_profile.as_deref(), Some("helmcode"));
        store.clear_active_profile();
        assert_eq!(store.active_profile, None);
    }

    #[test]
    fn keychain_accounts_split_key_and_session() {
        // The inference key lives under the bare profile id; the login
        // session JWT lives under "<profile-id>.session" (T13). One service.
        assert_eq!(KEYRING_SERVICE, "com.helmcode.nan.desktop");
        assert_eq!(key_account("nan"), "nan");
        assert_eq!(session_account("nan"), "nan.session");
        assert_eq!(key_account("helmcode"), "helmcode");
        assert_eq!(session_account("helmcode"), "helmcode.session");
    }

    #[test]
    fn mask_key_shows_at_most_last_four_chars() {
        assert_eq!(mask_key("sk-abcdef123456"), "••••3456");
        // Short keys are masked entirely: the mask must never reveal the key.
        assert_eq!(mask_key("abc"), "••••");
        assert_eq!(mask_key("abcd"), "••••");
        let masked = mask_key("ab");
        assert!(!masked.contains('a') && !masked.contains('b'));
    }
}
