//! Profile store (T3, S2): which inference API the app talks to.
//!
//! `profiles.json` in the app data dir holds the profile list
//! (`{id, name, base_url}`) plus the active profile id. The API key is NEVER
//! stored in this file: it lives in the OS keychain (S4) under the service
//! [`KEYRING_SERVICE`] with account = profile id.
//!
//! Everything here is pure logic (seed / parse / validate / mutate) or
//! path-injected file I/O, free of Tauri types, so it can be unit-tested
//! against a temp dir. Tauri glue (resolving the app data dir, keyring
//! access) lives in `lib.rs`.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Keychain service all profile API keys are stored under (S4). The account
/// is the profile id. Must stay in sync with `KEYRING_SERVICE` in `src/App.tsx`.
pub const KEYRING_SERVICE: &str = "com.helmcode.nan.desktop";

/// Config file name inside the app data dir.
pub const STORE_FILE: &str = "profiles.json";

/// One inference API profile. `base_url` is the OpenAI-compatible root the
/// app appends `/models`, `/chat/completions`, … to (e.g.
/// `https://api.nan.builders/v1`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub base_url: String,
}

/// The on-disk store (`profiles.json` document).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProfileStore {
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub active_profile: Option<String>,
}

/// The store seeded on first run: exactly the two shipped profiles (S2).
pub fn default_store() -> ProfileStore {
    ProfileStore {
        profiles: vec![
            Profile {
                id: "nan".to_string(),
                name: "NaN community".to_string(),
                base_url: "https://api.nan.builders/v1".to_string(),
            },
            Profile {
                id: "helmcode".to_string(),
                name: "Helmcode enterprise".to_string(),
                base_url: "https://api.helmcode.com/v1".to_string(),
            },
        ],
        active_profile: None,
    }
}

/// Validate a user-supplied base URL.
///
/// Rules: it must parse as an absolute URL without query or fragment; the
/// scheme must be `https`, except that plain `http` is accepted only for
/// `127.0.0.1` / `localhost` hosts (needed for local dev mocks).
pub fn validate_base_url(base_url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(base_url).map_err(|_| format!("invalid base_url: {base_url:?}"))?;
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("base_url must not include a query or fragment".to_string());
    }
    match parsed.scheme() {
        "https" => {}
        "http" if matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost")) => {}
        _ => {
            return Err(
                "base_url must use https (plain http is only allowed for 127.0.0.1/localhost)"
                    .to_string(),
            );
        }
    }
    if parsed.host_str().is_none_or(str::is_empty) {
        return Err("base_url must include a host".to_string());
    }
    Ok(())
}

/// Load the store from `dir`, creating or recovering `profiles.json` as
/// needed: a missing file is seeded with [`default_store`]; a corrupted or
/// invalid file falls back to the seeded defaults and is rewritten so it
/// stays readable on the next run. Only real I/O failures are returned as
/// `Err`.
pub fn load_or_seed(dir: &Path) -> Result<ProfileStore, String> {
    let path = dir.join(STORE_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            if let Some(store) = parse_store(&raw) {
                return Ok(store);
            }
            // Corrupted or invalid content: recover to the seeded defaults
            // and rewrite the file so it stays readable on the next run.
            let store = default_store();
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

/// Parse + validate a stored document. `None` means "treat as corrupt" (the
/// caller recovers to the seeded defaults): bad JSON, an empty profile list,
/// a profile with an invalid base URL, or an active id pointing nowhere.
pub fn parse_store(raw: &str) -> Option<ProfileStore> {
    let store: ProfileStore = serde_json::from_str(raw).ok()?;
    let valid = !store.profiles.is_empty()
        && store
            .profiles
            .iter()
            .all(|p| validate_base_url(&p.base_url).is_ok())
        && store
            .active_profile
            .as_ref()
            .is_none_or(|id| store.profiles.iter().any(|p| &p.id == id));
    valid.then_some(store)
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
    /// Look up a profile by id.
    pub fn get(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// Add a custom profile (any OpenAI-compatible base URL, validated by
    /// [`validate_base_url`]). The id is a unique slug derived from the name.
    /// Returns the added profile.
    pub fn add_profile(&mut self, name: &str, base_url: &str) -> Result<Profile, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("profile name must not be empty".to_string());
        }
        validate_base_url(base_url)?;
        let id = unique_slug(&self.profiles, name);
        let profile = Profile {
            id,
            name: name.to_string(),
            base_url: base_url.to_string(),
        };
        self.profiles.push(profile.clone());
        Ok(profile)
    }

    /// Mark the profile `id` active. Fails for unknown ids without touching
    /// the current value.
    pub fn set_active_profile(&mut self, id: &str) -> Result<(), String> {
        if !self.profiles.iter().any(|p| p.id == id) {
            return Err(format!("unknown profile id: {id:?}"));
        }
        self.active_profile = Some(id.to_string());
        Ok(())
    }
}

/// Derive a profile id slug from a display name (lowercase ASCII
/// alphanumeric plus dashes, collapsed and trimmed), guaranteed unique
/// within `existing` by appending `-2`, `-3`, … when needed.
fn unique_slug(existing: &[Profile], name: &str) -> String {
    let mut raw: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    // Collapse runs of dashes, then trim them at both ends.
    while raw.contains("--") {
        raw = raw.replace("--", "-");
    }
    let trimmed = raw.trim_matches('-');
    let base = if trimmed.is_empty() {
        "profile"
    } else {
        trimmed
    };

    if !existing.iter().any(|p| p.id == base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !existing.iter().any(|p| p.id == candidate) {
            return candidate;
        }
        n += 1;
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
    fn seeds_two_profiles_on_first_run() {
        let dir = TempDir::new().expect("temp dir");

        let store = load_or_seed(dir.path()).expect("seed");

        assert_eq!(store.profiles.len(), 2);
        assert_eq!(store.profiles[0].id, "nan");
        assert_eq!(store.profiles[0].name, "NaN community");
        assert_eq!(store.profiles[0].base_url, "https://api.nan.builders/v1");
        assert_eq!(store.profiles[1].id, "helmcode");
        assert_eq!(store.profiles[1].name, "Helmcode enterprise");
        assert_eq!(store.profiles[1].base_url, "https://api.helmcode.com/v1");
        assert_eq!(store.active_profile, None);

        // The seeded file must be on disk and re-readable to the same store.
        let reread = parse_store(&read_store(&dir)).expect("seeded file parses");
        assert_eq!(reread, store);
    }

    #[test]
    fn custom_profile_rejects_plain_http_non_localhost() {
        let mut store = default_store();

        let err = validate_base_url("http://api.example.com/v1").expect_err("http rejected");
        assert!(err.contains("https"), "error should mention https: {err}");

        let before = store.clone();
        assert!(
            store
                .add_profile("Example", "http://api.example.com/v1")
                .is_err()
        );
        assert_eq!(store, before, "failed add must not mutate the store");
    }

    #[test]
    fn custom_profile_allows_https_and_localhost_http() {
        assert!(validate_base_url("https://api.nan.builders/v1").is_ok());
        assert!(validate_base_url("https://proxy.internal:8443/v1").is_ok());
        // Plain http only for local dev mocks.
        assert!(validate_base_url("http://127.0.0.1:14322/v1").is_ok());
        assert!(validate_base_url("http://localhost:1234").is_ok());

        // Everything else is rejected.
        assert!(validate_base_url("").is_err());
        assert!(validate_base_url("not a url").is_err());
        assert!(validate_base_url("ftp://host/files").is_err());
        assert!(validate_base_url("https://host/v1?query=1").is_err());
        assert!(validate_base_url("https://host/v1#frag").is_err());
    }

    #[test]
    fn active_profile_switch_persists_and_rejects_unknown() {
        let dir = TempDir::new().expect("temp dir");

        let mut store = load_or_seed(dir.path()).expect("seed");
        store.set_active_profile("nan").expect("switch");
        save(dir.path(), &store).expect("save");

        let reloaded = load_or_seed(dir.path()).expect("reload");
        assert_eq!(reloaded.active_profile.as_deref(), Some("nan"));

        // Unknown id: error, and the active profile stays untouched.
        let mut again = reloaded.clone();
        assert!(again.set_active_profile("does-not-exist").is_err());
        assert_eq!(again.active_profile.as_deref(), Some("nan"));
    }

    #[test]
    fn corrupted_json_recovers_to_seed_and_rewrites_file() {
        let dir = TempDir::new().expect("temp dir");
        std::fs::create_dir_all(dir.path()).expect("dir");
        std::fs::write(dir.path().join(STORE_FILE), "{{{ not json at all").expect("write");

        let store = load_or_seed(dir.path()).expect("recover");
        assert_eq!(store, default_store(), "must fall back to seeded defaults");
        // The file must have been rewritten with the defaults (readable again).
        let reread = parse_store(&read_store(&dir)).expect("file readable after recovery");
        assert_eq!(reread, default_store());
    }

    #[test]
    fn invalid_content_in_file_recovers_to_seed() {
        let dir = TempDir::new().expect("temp dir");
        std::fs::create_dir_all(dir.path()).expect("dir");
        // Valid JSON, but a plain-http non-localhost base_url is invalid.
        let bad = r#"{"profiles":[{"id":"evil","name":"Evil","base_url":"http://evil.example.com/v1"}],"active_profile":"evil"}"#;
        std::fs::write(dir.path().join(STORE_FILE), bad).expect("write");

        let store = load_or_seed(dir.path()).expect("recover");
        assert_eq!(store, default_store());
    }

    #[test]
    fn add_profile_slugifies_and_keeps_ids_unique() {
        let mut store = default_store();

        let first = store
            .add_profile("My Lab", "https://lab.example.com/v1")
            .expect("add");
        assert_eq!(first.id, "my-lab");
        let second = store
            .add_profile("My Lab!", "https://lab2.example.com/v1")
            .expect("add");
        assert_eq!(second.id, "my-lab-2");

        let ids: Vec<&str> = store.profiles.iter().map(|p| p.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ids.len(), sorted.len(), "ids must be unique");
    }

    #[test]
    fn custom_profile_roundtrips_through_the_file() {
        let dir = TempDir::new().expect("temp dir");

        let mut store = load_or_seed(dir.path()).expect("seed");
        store
            .add_profile("Local mock", "http://127.0.0.1:14322/v1")
            .expect("add");
        store.set_active_profile("local-mock").expect("activate");
        save(dir.path(), &store).expect("save");

        let reloaded = load_or_seed(dir.path()).expect("reload");
        let custom = reloaded.get("local-mock").expect("custom profile kept");
        assert_eq!(custom.name, "Local mock");
        assert_eq!(custom.base_url, "http://127.0.0.1:14322/v1");
        assert_eq!(reloaded.active_profile.as_deref(), Some("local-mock"));
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
