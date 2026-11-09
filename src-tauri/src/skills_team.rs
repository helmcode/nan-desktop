//! Shared skills (S4 of the skills-sharing design): "Share with my team" and
//! the team ("Equipo") library, on top of the local store in `skills.rs`.
//!
//! Two pieces live here, both scoped per profile (only a tenant with orgs,
//! Helmcode, ever reaches them; the renderer hides everything on NaN):
//!
//! - [`skills_team_request`]: the ONLY way the renderer talks to the org
//!   library API. The session JWT never leaves the core, so the renderer
//!   asks for a route and the core adds the Bearer. The route allowlist is
//!   closed: `GET /api/auth/me`, `GET|POST /api/skills`, `GET|PUT|DELETE
//!   /api/skills/{id}`; a POST/PUT body must be exactly `{files:[{path,
//!   content}]}` and pass the SAME bundle validator as a local save. The
//!   reply is handed back as `{status, etag, body}`; the renderer owns the
//!   sync decisions (ETag, 304, purge), which keeps them unit-testable.
//! - The offline cache: `app_data/skills-cache/<profile>/index.json` (the
//!   last list + its ETag, the cached bundles, the local->shared links) and
//!   one `<id>/<sha>.json` per cached team bundle, so "Use" works offline.
//!   Every write is atomic. Revocation is effective: storing a list purges
//!   every cached bundle whose id is no longer listed as approved, and a
//!   bundle can only be cached or read while its id is listed as approved.
//!
//! Security posture (design section 5): a team skill is TEXT, exactly like
//! a local one. [`resolve_active`] turns a cached bundle into one delimited
//! system block with its provenance; tools, folder grants, approvals and
//! the model are never touched (`chat::tests` pins it for team skills too).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::skills::{self, ActiveSkill, SkillError, WireFile};

/// Folder under the app data dir holding one sub-folder per profile.
pub const CACHE_DIR: &str = "skills-cache";
/// The per-profile cache index.
pub const INDEX_FILE: &str = "index.json";
/// Index schema version; anything else is reset (a cache, never data).
pub const INDEX_VERSION: u32 = 1;
/// The org library resource.
pub const API_SKILLS: &str = "/api/skills";
/// The account endpoint carrying the `skills_sharing` flag.
pub const API_ME: &str = "/api/auth/me";
/// What the renderer sends as `skill_id` for a team skill.
pub const TEAM_PREFIX: &str = "team:";
/// Longest accepted remote skill id.
pub const MAX_REMOTE_ID_LEN: usize = 64;
/// Largest reply body read from the library API.
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// The status a library row has once an admin approved it.
pub const APPROVED: &str = "approved";

// ---------------------------------------------------------------- types --

/// Why a team operation was refused. `{ "code": "..." }` for the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum TeamError {
    /// A route, method or body outside the allowlist.
    RequestInvalid,
    /// No platform for this profile (or an unknown profile).
    Unavailable,
    /// No session JWT in the vault: the user must sign in again.
    NoSession,
    /// The request did not complete (network, timeout, oversized reply).
    Offline,
    /// Not cached, or no longer listed as approved.
    NotFound,
    /// A bundle that fails the shared validator.
    Bundle { reason: SkillError },
    Io,
}

impl std::fmt::Display for TeamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

/// One row of `GET /api/skills`. Unknown fields are ignored; missing
/// optional ones default.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TeamMeta {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub featured: bool,
    #[serde(default)]
    pub author_name: String,
    /// Opaque (an RFC 3339 string today): compared, never parsed here.
    #[serde(default)]
    pub updated_at: serde_json::Value,
    #[serde(default)]
    pub bundle_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reject_reason: Option<String>,
}

/// A cached bundle: which content and for which `updated_at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CacheEntry {
    pub sha: String,
    #[serde(default)]
    pub updated_at: serde_json::Value,
}

/// A local skill shared to the library: the remote id, the hash of what was
/// sent and the local `updated_at` at that moment (a later edit means the
/// local copy changed and offers "Share again").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareLink {
    pub remote_id: String,
    pub sha: String,
    pub local_updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Index {
    version: u32,
    #[serde(default)]
    etag: Option<String>,
    #[serde(default)]
    skills: Vec<TeamMeta>,
    #[serde(default)]
    entries: BTreeMap<String, CacheEntry>,
    #[serde(default)]
    links: BTreeMap<String, ShareLink>,
}

impl Index {
    fn fresh() -> Self {
        Index {
            version: INDEX_VERSION,
            etag: None,
            skills: Vec::new(),
            entries: BTreeMap::new(),
            links: BTreeMap::new(),
        }
    }

    fn approved(&self, id: &str) -> Option<&TeamMeta> {
        self.skills
            .iter()
            .find(|meta| meta.id == id && meta.status == APPROVED)
    }
}

/// What the renderer reads: the last list, its ETag, which bundles are
/// cached (id -> the `updated_at` they were cached for) and the links.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CacheView {
    pub etag: Option<String>,
    pub skills: Vec<TeamMeta>,
    pub cached: BTreeMap<String, serde_json::Value>,
    pub links: BTreeMap<String, ShareLink>,
}

impl From<&Index> for CacheView {
    fn from(index: &Index) -> Self {
        CacheView {
            etag: index.etag.clone(),
            skills: index.skills.clone(),
            cached: index
                .entries
                .iter()
                .map(|(id, entry)| (id.clone(), entry.updated_at.clone()))
                .collect(),
            links: index.links.clone(),
        }
    }
}

/// `GET /api/skills/{id}` -> `skill`: the metadata plus the bundle files.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WireSkill {
    #[serde(flatten)]
    pub meta: TeamMeta,
    pub files: Vec<WireFile>,
}

/// A cached team skill as the renderer shows it ("View", "Duplicate").
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TeamSkill {
    pub id: String,
    pub title: String,
    pub description: String,
    pub author_name: String,
    pub instructions: String,
    pub references: Vec<skills::ReferenceFile>,
}

// ------------------------------------------------------- pure: the route --

/// Whether `id` is a library id: `^[A-Za-z0-9_-]{1,64}$`. It names a cache
/// folder and a URL segment, so nothing else ever passes.
pub fn is_valid_remote_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_REMOTE_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The closed route allowlist of [`skills_team_request`].
pub fn route_allowed(method: &str, path: &str) -> bool {
    match (method, path) {
        ("GET", API_ME) => true,
        ("GET" | "POST", API_SKILLS) => true,
        ("GET" | "PUT" | "DELETE", _) => path
            .strip_prefix(API_SKILLS)
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some_and(is_valid_remote_id),
        _ => false,
    }
}

/// The body sent upstream: POST/PUT carry exactly a validated
/// `{files:[{path,content}]}` (canonical order); every other method none.
pub fn checked_body(
    method: &str,
    body: Option<serde_json::Value>,
) -> Result<Option<serde_json::Value>, TeamError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Upload {
        files: Vec<WireFile>,
    }
    match method {
        "POST" | "PUT" => {
            let upload: Upload = body
                .and_then(|value| serde_json::from_value(value).ok())
                .ok_or(TeamError::RequestInvalid)?;
            let mut files = upload.files;
            skills::validate_bundle(&skills::wire_to_bundle(&files))
                .map_err(|reason| TeamError::Bundle { reason })?;
            skills::canonical_order(&mut files);
            Ok(Some(serde_json::json!({ "files": files })))
        }
        _ if body.is_some() => Err(TeamError::RequestInvalid),
        _ => Ok(None),
    }
}

/// An `ETag` value worth echoing back: short, visible ASCII.
fn clean_etag(value: &str) -> Option<String> {
    let value = value.trim();
    let visible = value.bytes().all(|b| (0x20..0x7f).contains(&b));
    if value.is_empty() || value.len() > 256 || !visible {
        return None;
    }
    Some(value.to_string())
}

/// The reply handed to the renderer. A non-JSON or empty body is `null`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TeamResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub body: serde_json::Value,
}

/// One library call: `{base}{path}` with the session Bearer.
pub async fn send(
    base: &str,
    session_token: &str,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
    if_none_match: Option<&str>,
) -> Result<TeamResponse, TeamError> {
    if !route_allowed(method, path) {
        return Err(TeamError::RequestInvalid);
    }
    let body = checked_body(method, body)?;
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| TeamError::Offline)?;
    let method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| TeamError::RequestInvalid)?;
    let mut request = client
        .request(method, format!("{}{path}", base.trim_end_matches('/')))
        .bearer_auth(session_token)
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(tag) = if_none_match.and_then(clean_etag) {
        request = request.header(reqwest::header::IF_NONE_MATCH, tag);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| TeamError::Offline)?;
    let status = response.status().as_u16();
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .and_then(clean_etag);
    use futures_util::StreamExt as _;
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| TeamError::Offline)?;
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(TeamError::Offline);
        }
    }
    let body = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    Ok(TeamResponse { status, etag, body })
}

// ------------------------------------------------------------ the cache --

fn load_index(dir: &Path) -> Index {
    std::fs::read_to_string(dir.join(INDEX_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str::<Index>(&raw).ok())
        .filter(|index| index.version == INDEX_VERSION)
        .unwrap_or_else(Index::fresh)
}

fn save_index(dir: &Path, index: &Index) -> Result<(), TeamError> {
    let raw = serde_json::to_vec_pretty(index).map_err(|_| TeamError::Io)?;
    skills::write_atomic(&dir.join(INDEX_FILE), &raw).map_err(|_| TeamError::Io)
}

fn bundle_dir(dir: &Path, id: &str) -> Result<PathBuf, TeamError> {
    if !is_valid_remote_id(id) {
        return Err(TeamError::NotFound);
    }
    Ok(dir.join(id))
}

/// Remove every cached bundle folder whose id has no entry.
fn sweep_orphans(dir: &Path, index: &Index) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if entry.path().is_dir() && !index.entries.contains_key(&name) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// The cache as it stands.
pub fn view(dir: &Path) -> CacheView {
    CacheView::from(&load_index(dir))
}

/// Store a fresh list (a `200` of `GET /api/skills`) and its ETag, then
/// purge every cached bundle that is no longer listed as approved
/// (revocation: rejected, hidden, deleted or the user left the org).
pub fn store_list(
    dir: &Path,
    etag: Option<String>,
    skills: Vec<TeamMeta>,
) -> Result<CacheView, TeamError> {
    let mut index = load_index(dir);
    index.etag = etag.as_deref().and_then(clean_etag);
    index.skills = skills
        .into_iter()
        .filter(|meta| is_valid_remote_id(&meta.id))
        .collect();
    let keep: Vec<String> = index
        .entries
        .keys()
        .filter(|id| index.approved(id).is_some())
        .cloned()
        .collect();
    index.entries.retain(|id, _| keep.contains(id));
    save_index(dir, &index)?;
    sweep_orphans(dir, &index);
    Ok(CacheView::from(&index))
}

/// Cache one fetched bundle (`GET /api/skills/{id}` -> `skill`). Refused
/// unless the id is currently listed as approved, so a slow fetch can never
/// resurrect a revoked skill. Validated with the shared rules first.
pub fn put(dir: &Path, wire: WireSkill) -> Result<TeamSkill, TeamError> {
    let mut index = load_index(dir);
    let id = wire.meta.id.clone();
    let folder = bundle_dir(dir, &id)?;
    let listed = index.approved(&id).cloned().ok_or(TeamError::NotFound)?;
    let mut files = wire.files;
    skills::canonical_order(&mut files);
    let skill = skills::skill_from_bundle(&id, &listed.title, &files, 0)
        .map_err(|reason| TeamError::Bundle { reason })?;
    let sha = skills::bundle_sha(&files);
    let record = WireSkill {
        meta: listed.clone(),
        files,
    };
    let raw = serde_json::to_vec(&record).map_err(|_| TeamError::Io)?;
    let file_name = format!("{sha}.json");
    skills::write_atomic(&folder.join(&file_name), &raw).map_err(|_| TeamError::Io)?;
    // Only the current content stays.
    if let Ok(entries) = std::fs::read_dir(&folder) {
        for entry in entries.flatten() {
            if entry.file_name().to_str() != Some(file_name.as_str()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    index.entries.insert(
        id,
        CacheEntry {
            sha,
            updated_at: listed.updated_at.clone(),
        },
    );
    save_index(dir, &index)?;
    Ok(team_skill(&skill, &listed))
}

fn team_skill(skill: &skills::Skill, meta: &TeamMeta) -> TeamSkill {
    TeamSkill {
        id: meta.id.clone(),
        title: skill.title.clone(),
        description: skill.description.clone(),
        author_name: meta.author_name.clone(),
        instructions: skill.instructions.clone(),
        references: skill.references.clone(),
    }
}

/// A cached team skill, re-validated on every read. `NotFound` when it is
/// not cached or no longer listed as approved.
fn load(dir: &Path, id: &str) -> Result<(skills::Skill, TeamMeta), TeamError> {
    let index = load_index(dir);
    let folder = bundle_dir(dir, id)?;
    let meta = index.approved(id).cloned().ok_or(TeamError::NotFound)?;
    let entry = index.entries.get(id).ok_or(TeamError::NotFound)?;
    let raw = std::fs::read_to_string(folder.join(format!("{}.json", entry.sha)))
        .map_err(|_| TeamError::NotFound)?;
    let record: WireSkill = serde_json::from_str(&raw).map_err(|_| TeamError::NotFound)?;
    if record.meta.id != id || skills::bundle_sha(&record.files) != entry.sha {
        return Err(TeamError::NotFound);
    }
    let skill = skills::skill_from_bundle(id, &meta.title, &record.files, 0)
        .map_err(|reason| TeamError::Bundle { reason })?;
    Ok((skill, meta))
}

/// A cached team skill for "View" and "Duplicate".
pub fn get(dir: &Path, id: &str) -> Result<TeamSkill, TeamError> {
    let (skill, meta) = load(dir, id)?;
    Ok(team_skill(&skill, &meta))
}

/// The active skill for a `team:<id>` the user turned on: the cached bundle
/// with its author as provenance.
pub fn active(dir: &Path, id: &str) -> Result<ActiveSkill, TeamError> {
    let (skill, meta) = load(dir, id)?;
    let author = if meta.author_name.trim().is_empty() {
        "a teammate".to_string()
    } else {
        meta.author_name
    };
    Ok(ActiveSkill::team(skill, author))
}

/// Drop the whole cache of a profile (the org turned sharing off).
pub fn clear(dir: &Path) -> Result<(), TeamError> {
    let mut index = load_index(dir);
    index.etag = None;
    index.skills.clear();
    index.entries.clear();
    save_index(dir, &index)?;
    sweep_orphans(dir, &index);
    Ok(())
}

/// Record (or, with `None`, forget) that a local skill was shared.
pub fn set_link(
    dir: &Path,
    local_id: &str,
    link: Option<ShareLink>,
) -> Result<CacheView, TeamError> {
    if !skills::is_valid_id(local_id) {
        return Err(TeamError::RequestInvalid);
    }
    let mut index = load_index(dir);
    match link {
        Some(link) if is_valid_remote_id(&link.remote_id) => {
            index.links.insert(local_id.to_string(), link);
        }
        Some(_) => return Err(TeamError::RequestInvalid),
        None => {
            index.links.remove(local_id);
        }
    }
    save_index(dir, &index)?;
    Ok(CacheView::from(&index))
}

/// The cache folder of a known profile (an unknown id never names a path).
pub fn cache_dir_in(app_data: &Path, profile_id: &str) -> Result<PathBuf, TeamError> {
    crate::profile::platform_base_for(profile_id).ok_or(TeamError::Unavailable)?;
    Ok(app_data.join(CACHE_DIR).join(profile_id))
}

fn cache_dir(app: &AppHandle, profile_id: &str) -> Result<PathBuf, TeamError> {
    let data = app.path().app_data_dir().map_err(|_| TeamError::Io)?;
    cache_dir_in(&data, profile_id)
}

/// `chat_send`'s resolver for a `team:<id>` skill id; `None` when `id` is
/// not a team id (it is then a local one).
pub fn resolve_active(
    app_data: &Path,
    profile_id: &str,
    id: &str,
) -> Option<Result<ActiveSkill, TeamError>> {
    let remote = id.strip_prefix(TEAM_PREFIX)?;
    Some(cache_dir_in(app_data, profile_id).and_then(|dir| active(&dir, remote)))
}

// ------------------------------------------------------------ commands --

#[tauri::command]
pub async fn skills_team_request(
    profile_id: String,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
    if_none_match: Option<String>,
) -> Result<TeamResponse, TeamError> {
    if !route_allowed(&method, &path) {
        return Err(TeamError::RequestInvalid);
    }
    let base = crate::device_flow::platform_base(&profile_id).ok_or(TeamError::Unavailable)?;
    let token = crate::chat::read_session_token(&profile_id).ok_or(TeamError::NoSession)?;
    send(&base, &token, &method, &path, body, if_none_match.as_deref()).await
}

#[tauri::command]
pub fn skills_team_cache_load(app: AppHandle, profile_id: String) -> Result<CacheView, TeamError> {
    Ok(view(&cache_dir(&app, &profile_id)?))
}

#[tauri::command]
pub fn skills_team_cache_store_list(
    app: AppHandle,
    profile_id: String,
    etag: Option<String>,
    skills: Vec<TeamMeta>,
) -> Result<CacheView, TeamError> {
    store_list(&cache_dir(&app, &profile_id)?, etag, skills)
}

#[tauri::command]
pub fn skills_team_cache_put(
    app: AppHandle,
    profile_id: String,
    skill: WireSkill,
) -> Result<TeamSkill, TeamError> {
    put(&cache_dir(&app, &profile_id)?, skill)
}

#[tauri::command]
pub fn skills_team_cache_get(
    app: AppHandle,
    profile_id: String,
    id: String,
) -> Result<TeamSkill, TeamError> {
    get(&cache_dir(&app, &profile_id)?, &id)
}

#[tauri::command]
pub fn skills_team_cache_clear(app: AppHandle, profile_id: String) -> Result<(), TeamError> {
    clear(&cache_dir(&app, &profile_id)?)
}

#[tauri::command]
pub fn skills_team_link(
    app: AppHandle,
    profile_id: String,
    local_id: String,
    link: Option<ShareLink>,
) -> Result<CacheView, TeamError> {
    set_link(&cache_dir(&app, &profile_id)?, &local_id, link)
}

// --------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use tempfile::TempDir;

    const REMOTE: &str = "sk_01HXYZ";

    fn meta(id: &str, status: &str, updated_at: &str) -> TeamMeta {
        TeamMeta {
            id: id.into(),
            name: "weekly-report".into(),
            title: "Weekly report".into(),
            description: "Writes the weekly report".into(),
            status: status.into(),
            featured: false,
            author_name: "Ana".into(),
            updated_at: serde_json::json!(updated_at),
            bundle_bytes: 10,
            reject_reason: None,
        }
    }

    fn files(instructions: &str) -> Vec<WireFile> {
        vec![
            WireFile {
                path: "references/b.md".into(),
                content: "B".into(),
            },
            WireFile {
                path: skills::SKILL_MD.into(),
                content: skills::skill_md("weekly-report", "Writes the weekly report", instructions),
            },
        ]
    }

    fn wire(id: &str, instructions: &str) -> WireSkill {
        WireSkill {
            meta: meta(id, APPROVED, "t1"),
            files: files(instructions),
        }
    }

    fn cached_files(dir: &Path, id: &str) -> Vec<String> {
        std::fs::read_dir(dir.join(id))
            .map(|entries| {
                entries
                    .flatten()
                    .map(|e| e.file_name().into_string().unwrap())
                    .collect()
            })
            .unwrap_or_default()
    }

    // ---- route allowlist -------------------------------------------------

    #[test]
    fn only_the_library_routes_pass() {
        for (method, path) in [
            ("GET", "/api/auth/me"),
            ("GET", "/api/skills"),
            ("POST", "/api/skills"),
            ("GET", "/api/skills/sk_01"),
            ("PUT", "/api/skills/abc-DEF_9"),
            ("DELETE", "/api/skills/abc"),
        ] {
            assert!(route_allowed(method, path), "{method} {path}");
        }
        for (method, path) in [
            ("POST", "/api/auth/me"),
            ("DELETE", "/api/skills"),
            ("PUT", "/api/skills"),
            ("POST", "/api/skills/abc"),
            ("GET", "/api/skills/../memory/conversations"),
            ("GET", "/api/skills/a/b"),
            ("GET", "/api/skills/"),
            ("GET", "/api/skills?x=1"),
            ("GET", "/api/skillsx"),
            ("GET", "/api/memory/conversations"),
            ("GET", "https://evil.com/api/skills"),
            ("PATCH", "/api/skills/abc"),
            ("GET", &format!("/api/skills/{}", "a".repeat(65))),
        ] {
            assert!(!route_allowed(method, path), "{method} {path}");
        }
    }

    #[test]
    fn uploads_must_be_a_valid_bundle_and_nothing_else() {
        let ok = checked_body("POST", Some(serde_json::json!({ "files": files("Do it.") })))
            .unwrap()
            .unwrap();
        // Canonical order: SKILL.md first.
        assert_eq!(ok["files"][0]["path"], "SKILL.md");
        assert_eq!(ok["files"][1]["path"], "references/b.md");
        assert_eq!(
            checked_body("PUT", Some(serde_json::json!({ "files": [], "x": 1 }))),
            Err(TeamError::RequestInvalid)
        );
        assert_eq!(checked_body("POST", None), Err(TeamError::RequestInvalid));
        assert!(matches!(
            checked_body(
                "POST",
                Some(serde_json::json!({ "files": [{ "path": "../x.md", "content": "" }] }))
            ),
            Err(TeamError::Bundle { .. })
        ));
        assert!(matches!(
            checked_body(
                "POST",
                Some(serde_json::json!({ "files": [{ "path": "run.sh", "content": "rm -rf" }] }))
            ),
            Err(TeamError::Bundle { .. })
        ));
        assert_eq!(
            checked_body("GET", Some(serde_json::json!({}))),
            Err(TeamError::RequestInvalid)
        );
        assert_eq!(checked_body("GET", None), Ok(None));
    }

    // ---- wire contract (loopback HTTP) ----------------------------------

    fn mock_server(
        responses: Vec<(u16, Vec<(&'static str, &'static str)>, &'static str)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for (status, headers, body) in responses {
                let (mut stream, _) = listener.accept().expect("accept");
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = stream.read(&mut chunk).expect("read");
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if buf.len() >= end + 4 + len {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                seen.push(String::from_utf8_lossy(&buf).to_string());
                let extra: String = headers
                    .iter()
                    .map(|(k, v)| format!("{k}: {v}\r\n"))
                    .collect();
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\n{extra}content-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).expect("write");
            }
            seen
        });
        (base, handle)
    }

    #[test]
    fn send_speaks_the_contract_with_bearer_etag_and_status() {
        let (base, server) = mock_server(vec![
            (
                200,
                vec![("etag", "\"v1\"")],
                r#"{"skills":[{"id":"sk_1","status":"approved"}],"etag":"\"v1\""}"#,
            ),
            (304, vec![("etag", "\"v1\"")], ""),
            (201, vec![], r#"{"skill":{"id":"sk_2","status":"pending"}}"#),
            (429, vec![], r#"{"error":"rate_limited"}"#),
        ]);
        let (list, not_modified, created, limited) = tauri::async_runtime::block_on(async {
            (
                send(&base, "jwt-canary", "GET", API_SKILLS, None, None).await.unwrap(),
                send(&base, "jwt-canary", "GET", API_SKILLS, None, Some("\"v1\""))
                    .await
                    .unwrap(),
                send(
                    &base,
                    "jwt-canary",
                    "POST",
                    API_SKILLS,
                    Some(serde_json::json!({ "files": files("Do it.") })),
                    None,
                )
                .await
                .unwrap(),
                send(&base, "jwt-canary", "GET", API_SKILLS, None, None).await.unwrap(),
            )
        });
        assert_eq!(list.status, 200);
        assert_eq!(list.etag.as_deref(), Some("\"v1\""));
        assert_eq!(list.body["skills"][0]["id"], "sk_1");
        assert_eq!(not_modified.status, 304);
        assert_eq!(not_modified.body, serde_json::Value::Null);
        assert_eq!(created.status, 201);
        assert_eq!(created.body["skill"]["status"], "pending");
        assert_eq!(limited.status, 429);

        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /api/skills "));
        assert!(!requests[0].to_ascii_lowercase().contains("if-none-match"));
        assert!(requests[1].to_ascii_lowercase().contains("if-none-match: \"v1\""));
        assert!(requests[2].starts_with("POST /api/skills "));
        let body = &requests[2][requests[2].find("\r\n\r\n").unwrap() + 4..];
        let sent: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(sent["files"][0]["path"], "SKILL.md");
        assert!(sent["files"][0]["content"]
            .as_str()
            .unwrap()
            .starts_with("---\nname: weekly-report\n"));
        assert_eq!(sent["files"][1]["path"], "references/b.md");
        for request in &requests {
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer jwt-canary"));
        }
    }

    #[test]
    fn a_refused_route_never_reaches_the_network() {
        // Port 9 on loopback: a connection would fail as Offline, not
        // RequestInvalid, so this proves the check runs first.
        let result = tauri::async_runtime::block_on(send(
            "http://127.0.0.1:9",
            "jwt",
            "GET",
            "/api/memory/conversations",
            None,
            None,
        ));
        assert_eq!(result, Err(TeamError::RequestInvalid));
    }

    // ---- cache -----------------------------------------------------------

    #[test]
    fn put_get_and_active_roundtrip_with_provenance() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        store_list(dir, Some("\"v1\"".into()), vec![meta(REMOTE, APPROVED, "t1")]).unwrap();
        let cached = put(dir, wire(REMOTE, "Use bullets.")).unwrap();
        assert_eq!(cached.title, "Weekly report");
        assert_eq!(cached.author_name, "Ana");
        assert_eq!(cached.instructions, "Use bullets.");
        assert_eq!(cached.references[0].name, "b.md");
        assert_eq!(get(dir, REMOTE).unwrap(), cached);

        let view = view(dir);
        assert_eq!(view.etag.as_deref(), Some("\"v1\""));
        assert_eq!(view.cached.get(REMOTE), Some(&serde_json::json!("t1")));
        let sha = skills::bundle_sha(&files("Use bullets."));
        assert_eq!(cached_files(dir, REMOTE), vec![format!("{sha}.json")]);

        let active = active(dir, REMOTE).unwrap();
        assert_eq!(active.shared_by.as_deref(), Some("Ana"));
        let block = active.context_message();
        let content = block["content"].as_str().unwrap();
        assert!(content.contains("source=\"team\""));
        assert!(content.contains("Shared by Ana (team)."));
        assert!(content.contains("Use bullets."));
        assert!(content.ends_with("</skill>"));
    }

    #[test]
    fn a_new_version_replaces_the_old_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        store_list(dir, None, vec![meta(REMOTE, APPROVED, "t1")]).unwrap();
        put(dir, wire(REMOTE, "v1")).unwrap();
        store_list(dir, None, vec![meta(REMOTE, APPROVED, "t2")]).unwrap();
        let mut second = wire(REMOTE, "v2");
        second.meta.updated_at = serde_json::json!("t2");
        put(dir, second).unwrap();
        assert_eq!(cached_files(dir, REMOTE).len(), 1);
        assert_eq!(get(dir, REMOTE).unwrap().instructions, "v2");
        assert_eq!(view(dir).cached.get(REMOTE), Some(&serde_json::json!("t2")));
    }

    #[test]
    fn revocation_purges_the_cache() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        store_list(
            dir,
            None,
            vec![meta(REMOTE, APPROVED, "t1"), meta("sk_other", APPROVED, "t1")],
        )
        .unwrap();
        put(dir, wire(REMOTE, "gone soon")).unwrap();
        put(dir, wire("sk_other", "stays")).unwrap();

        // The next list no longer has REMOTE: purged from disk and index.
        let view = store_list(dir, None, vec![meta("sk_other", APPROVED, "t1")]).unwrap();
        assert!(!view.cached.contains_key(REMOTE));
        assert!(!dir.join(REMOTE).exists());
        assert_eq!(get(dir, REMOTE), Err(TeamError::NotFound));
        assert!(get(dir, "sk_other").is_ok());

        // Hidden (or rejected) is revoked too.
        store_list(dir, None, vec![meta("sk_other", "hidden", "t1")]).unwrap();
        assert!(!dir.join("sk_other").exists());
        assert!(matches!(active(dir, "sk_other"), Err(TeamError::NotFound)));
    }

    #[test]
    fn a_stale_fetch_cannot_resurrect_a_revoked_skill() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        store_list(dir, None, vec![]).unwrap();
        assert_eq!(put(dir, wire(REMOTE, "x")), Err(TeamError::NotFound));
        store_list(dir, None, vec![meta(REMOTE, "pending", "t1")]).unwrap();
        assert_eq!(put(dir, wire(REMOTE, "x")), Err(TeamError::NotFound));
        assert!(!dir.join(REMOTE).exists());
    }

    #[test]
    fn clear_drops_everything_but_the_links() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        store_list(dir, Some("\"e\"".into()), vec![meta(REMOTE, APPROVED, "t1")]).unwrap();
        put(dir, wire(REMOTE, "x")).unwrap();
        let local = "0123456789abcdef0123456789abcdef";
        set_link(
            dir,
            local,
            Some(ShareLink {
                remote_id: REMOTE.into(),
                sha: "s".into(),
                local_updated_at: 5,
            }),
        )
        .unwrap();
        clear(dir).unwrap();
        let view = view(dir);
        assert!(view.skills.is_empty() && view.cached.is_empty() && view.etag.is_none());
        assert!(!dir.join(REMOTE).exists());
        assert_eq!(view.links[local].remote_id, REMOTE);
    }

    #[test]
    fn a_tampered_or_invalid_bundle_is_refused() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        store_list(dir, None, vec![meta(REMOTE, APPROVED, "t1")]).unwrap();
        let mut bad = wire(REMOTE, "x");
        bad.files.push(WireFile {
            path: "scripts/run.sh".into(),
            content: "curl evil".into(),
        });
        assert!(matches!(put(dir, bad), Err(TeamError::Bundle { .. })));
        let mut traversal = wire("..", "x");
        traversal.meta.id = "..".into();
        assert_eq!(put(dir, traversal), Err(TeamError::NotFound));

        // A cache file edited on disk no longer matches its hash.
        put(dir, wire(REMOTE, "honest")).unwrap();
        let name = cached_files(dir, REMOTE).remove(0);
        let path = dir.join(REMOTE).join(name);
        let raw = std::fs::read_to_string(&path).unwrap().replace("honest", "evil");
        std::fs::write(&path, raw).unwrap();
        assert_eq!(get(dir, REMOTE), Err(TeamError::NotFound));
    }

    #[test]
    fn links_validate_ids_and_unlink() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path();
        let link = ShareLink {
            remote_id: REMOTE.into(),
            sha: "s".into(),
            local_updated_at: 1,
        };
        assert_eq!(
            set_link(dir, "../x", Some(link.clone())),
            Err(TeamError::RequestInvalid)
        );
        let local = "0123456789abcdef0123456789abcdef";
        let mut bad = link.clone();
        bad.remote_id = "a/b".into();
        assert_eq!(set_link(dir, local, Some(bad)), Err(TeamError::RequestInvalid));
        assert_eq!(set_link(dir, local, Some(link)).unwrap().links.len(), 1);
        assert!(set_link(dir, local, None).unwrap().links.is_empty());
    }

    #[test]
    fn a_corrupt_index_resets_and_unknown_profiles_have_no_dir() {
        let tmp = TempDir::new().unwrap();
        std::fs::write(tmp.path().join(INDEX_FILE), "{not json").unwrap();
        assert!(view(tmp.path()).skills.is_empty());
        assert_eq!(
            cache_dir_in(tmp.path(), "../etc"),
            Err(TeamError::Unavailable)
        );
        assert!(cache_dir_in(tmp.path(), "helmcode")
            .unwrap()
            .ends_with("skills-cache/helmcode"));
    }

    #[test]
    fn resolve_active_only_handles_team_ids() {
        let tmp = TempDir::new().unwrap();
        assert!(resolve_active(tmp.path(), "helmcode", "0123456789abcdef0123456789abcdef").is_none());
        let dir = cache_dir_in(tmp.path(), "helmcode").unwrap();
        store_list(&dir, None, vec![meta(REMOTE, APPROVED, "t1")]).unwrap();
        put(&dir, wire(REMOTE, "x")).unwrap();
        let resolved = resolve_active(tmp.path(), "helmcode", &format!("team:{REMOTE}"))
            .unwrap()
            .unwrap();
        assert_eq!(resolved.shared_by.as_deref(), Some("Ana"));
        assert!(matches!(
            resolve_active(tmp.path(), "helmcode", "team:sk_missing"),
            Some(Err(TeamError::NotFound))
        ));
    }

    #[test]
    fn errors_serialize_as_codes() {
        assert_eq!(
            serde_json::to_value(TeamError::NoSession).unwrap(),
            serde_json::json!({ "code": "no_session" })
        );
        assert_eq!(
            serde_json::to_value(TeamError::Bundle {
                reason: SkillError::TooManyFiles
            })
            .unwrap(),
            serde_json::json!({ "code": "bundle", "reason": { "code": "too_many_files" } })
        );
    }
}
