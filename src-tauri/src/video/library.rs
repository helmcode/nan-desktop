//! The video library: every project lives in the signed-in user's realm,
//! `<realm>/videos/<project id>/`, owned by the core.
//!
//! The renderer and the model name a project by its id (32 lowercase hex
//! characters) and a file by a project-relative path from a closed set
//! (`video.json`, `index.html`, `theme.css`, `compositions/<scene>.html`,
//! `assets/<name>`, `assets/fonts/<name>`, `exports/<name>.mp4`). Nothing
//! resolves outside the project: ids and paths are validated before they
//! touch the disk, no symlink is ever followed (every component is checked
//! with `symlink_metadata`, reads use `O_NOFOLLOW` where available), and
//! every write is atomic (temp file + rename in the same folder).
//!
//! A change is applied as one [`Change`]: everything is validated first
//! (scenes, theme, metadata, assets, limits), then written; `index.html` is
//! regenerated from the result. A change that fails validation writes
//! nothing.

use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::project::{self, VideoMeta};
use crate::tools::Rejection;

/// The library folder inside a realm.
pub const LIBRARY_DIR: &str = "videos";
/// Largest single asset.
pub const MAX_ASSET_BYTES: u64 = 80 * 1024 * 1024;
/// Largest project (everything but `exports/`): the render bundle cap
/// (contract amendment: 90 MiB, the upload body limit). The zip stores
/// files uncompressed, so the bundle is this size plus a few headers; the
/// export re-checks the zipped size before uploading.
pub const MAX_PROJECT_BYTES: u64 = 88 * 1024 * 1024;
/// Largest `video.json`.
const MAX_META_BYTES: u64 = 256 * 1024;
/// Most assets in one project.
pub const MAX_ASSETS: usize = 200;
/// Most projects listed.
pub const MAX_PROJECTS: usize = 500;

/// `<realm>/videos`.
pub fn library_dir(realm: &Path) -> PathBuf {
    realm.join(LIBRARY_DIR)
}

/// A project id: a v4 uuid without dashes (32 lowercase hex).
pub fn valid_project_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn new_project_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn io(message: impl Into<String>) -> Rejection {
    Rejection::new("io", message)
}

fn invalid(message: impl Into<String>) -> Rejection {
    Rejection::new("invalid", message)
}

/// Whether `path` exists as a real directory (not a symlink).
fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_dir())
}

/// Create `dir` and its missing parents under `base`, refusing any
/// existing component that is not a real directory (a symlink planted in
/// the library can never redirect a write).
fn ensure_dir(base: &Path, rel: &[&str]) -> Result<PathBuf, Rejection> {
    let mut dir = base.to_path_buf();
    if !is_real_dir(&dir) {
        return Err(io("the project folder is missing"));
    }
    for part in rel {
        dir.push(part);
        match std::fs::symlink_metadata(&dir) {
            Ok(meta) if meta.file_type().is_dir() => {}
            Ok(_) => return Err(io("a project folder is not a directory")),
            Err(_) => {
                std::fs::create_dir(&dir).map_err(|_| io("cannot create a project folder"))?
            }
        }
    }
    Ok(dir)
}

/// The folder of an existing project.
pub fn project_dir(realm: &Path, id: &str) -> Result<PathBuf, Rejection> {
    if !valid_project_id(id) {
        return Err(invalid("unknown video project"));
    }
    let library = library_dir(realm);
    let dir = library.join(id);
    if !is_real_dir(&library) || !is_real_dir(&dir) {
        return Err(Rejection::new(
            "not_found",
            "this video project no longer exists",
        ));
    }
    Ok(dir)
}

/// Create an empty project folder (with its subfolders) and return it.
pub fn create_project_dir(realm: &Path, id: &str) -> Result<PathBuf, Rejection> {
    if !valid_project_id(id) {
        return Err(invalid("bad project id"));
    }
    if !is_real_dir(realm) {
        return Err(io("the account folder is missing"));
    }
    let library = ensure_dir(realm, &[LIBRARY_DIR])?;
    let dir = library.join(id);
    std::fs::create_dir(&dir).map_err(|_| io("cannot create the project folder"))?;
    for sub in [
        &["compositions"][..],
        &["assets"],
        &["assets", "fonts"],
        &["exports"],
    ] {
        ensure_dir(&dir, sub)?;
    }
    Ok(dir)
}

/// A file the project may hold, by project-relative path.
pub fn valid_project_file(rel: &str) -> bool {
    match rel {
        "video.json" | "index.html" | "theme.css" => true,
        _ => {
            if let Some(name) = rel.strip_prefix("compositions/") {
                return name.strip_suffix(".html").is_some_and(project::valid_id);
            }
            if let Some(name) = rel.strip_prefix("exports/") {
                return valid_export_name(name);
            }
            project::valid_asset_path(rel)
        }
    }
}

/// An exported MP4's file name: `<slug>[-<n>].mp4`.
pub fn valid_export_name(name: &str) -> bool {
    name.strip_suffix(".mp4").is_some_and(|stem| {
        !stem.is_empty()
            && stem.len() <= 80
            && stem
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && !stem.starts_with('-')
    })
}

fn rel_parts(rel: &str) -> Vec<&str> {
    rel.split('/').collect()
}

/// The absolute path of a validated project file (parents not created).
fn file_path(dir: &Path, rel: &str) -> Result<PathBuf, Rejection> {
    if !valid_project_file(rel) {
        return Err(invalid(format!("not a project file: {rel}")));
    }
    let mut path = dir.to_path_buf();
    for part in rel_parts(rel) {
        path.push(part);
    }
    Ok(path)
}

/// Read a project file: a regular file reached without symlinks, at most
/// `cap` bytes. `Ok(None)` when it does not exist.
pub fn read_file(dir: &Path, rel: &str, cap: u64) -> Result<Option<Vec<u8>>, Rejection> {
    let path = file_path(dir, rel)?;
    // Every component below the project folder must be a real directory.
    let parts = rel_parts(rel);
    let mut parent = dir.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        parent.push(part);
        if !is_real_dir(&parent) {
            return Ok(None);
        }
    }
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(_) => return Ok(None),
    };
    if !meta.file_type().is_file() {
        return Err(io("a project file is not a regular file"));
    }
    if meta.len() > cap {
        return Err(Rejection::new("too_large", "a project file is too large"));
    }
    let mut file = open_no_follow(&path)?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    std::io::Read::by_ref(&mut file)
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| io("cannot read a project file"))?;
    if bytes.len() as u64 > cap {
        return Err(Rejection::new("too_large", "a project file is too large"));
    }
    Ok(Some(bytes))
}

fn open_no_follow(path: &Path) -> Result<std::fs::File, Rejection> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|_| io("cannot open a project file"))
}

/// A UTF-8 project file (`None` when missing).
pub fn read_text(dir: &Path, rel: &str, cap: u64) -> Result<Option<String>, Rejection> {
    match read_file(dir, rel, cap)? {
        Some(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| invalid(format!("{rel} is not UTF-8 text"))),
        None => Ok(None),
    }
}

/// Write a project file atomically (temp + rename in the same folder),
/// creating its parent folders. Never follows a symlink: an existing
/// non-regular file at the target is refused.
pub fn write_file(dir: &Path, rel: &str, bytes: &[u8]) -> Result<(), Rejection> {
    let path = file_path(dir, rel)?;
    let parts = rel_parts(rel);
    let parent = ensure_dir(dir, &parts[..parts.len() - 1])?;
    if let Ok(meta) = std::fs::symlink_metadata(&path)
        && !meta.file_type().is_file()
    {
        return Err(io("a project file is not a regular file"));
    }
    let tmp = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
        return Err(io("cannot write a project file"));
    }
    Ok(())
}

/// Remove a project file if it exists (regular files only).
pub fn remove_file(dir: &Path, rel: &str) -> Result<(), Rejection> {
    let path = file_path(dir, rel)?;
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_file() || meta.file_type().is_symlink() => {
            std::fs::remove_file(&path).map_err(|_| io("cannot remove a project file"))
        }
        Ok(_) => Err(io("a project file is not a regular file")),
        Err(_) => Ok(()),
    }
}

/// Read and parse `video.json`.
pub fn read_meta(dir: &Path) -> Result<VideoMeta, Rejection> {
    let text = read_text(dir, "video.json", MAX_META_BYTES)?
        .ok_or_else(|| Rejection::new("not_found", "the project has no video.json"))?;
    serde_json::from_str(&text).map_err(|_| invalid("video.json is not valid"))
}

/// The real (non-symlink) regular files of one project folder level, by
/// name, with their sizes.
fn list_level(dir: &Path) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.path().symlink_metadata() else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        if let Some(name) = entry.file_name().to_str() {
            out.insert(name.to_string(), meta.len());
        }
    }
    out
}

/// Every asset of a project (`assets/...` path -> size).
pub fn list_assets(dir: &Path) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    for (name, size) in list_level(&dir.join("assets")) {
        let rel = format!("assets/{name}");
        if project::valid_asset_path(&rel) {
            out.insert(rel, size);
        }
    }
    for (name, size) in list_level(&dir.join("assets").join("fonts")) {
        let rel = format!("assets/fonts/{name}");
        if project::valid_asset_path(&rel) {
            out.insert(rel, size);
        }
    }
    out
}

/// The exported MP4s (name -> size), newest name order.
pub fn list_exports(dir: &Path) -> BTreeMap<String, u64> {
    list_level(&dir.join("exports"))
        .into_iter()
        .filter(|(name, _)| valid_export_name(name))
        .collect()
}

/// What the render bundle and the size caps count: every project file but
/// the exports.
pub fn project_size(dir: &Path) -> u64 {
    let assets: u64 = list_assets(dir).values().sum();
    let scenes: u64 = list_level(&dir.join("compositions")).values().sum();
    let top: u64 = ["video.json", "index.html", "theme.css"]
        .iter()
        .filter_map(|name| std::fs::symlink_metadata(dir.join(name)).ok())
        .filter(|meta| meta.file_type().is_file())
        .map(|meta| meta.len())
        .sum();
    assets + scenes + top
}

/// One change to a project, validated as a whole before anything is
/// written.
#[derive(Debug, Default)]
pub struct Change {
    /// The new metadata (scenes in order, variables, audio...).
    pub meta: Option<VideoMeta>,
    /// New `theme.css` (validated).
    pub theme: Option<String>,
    /// Scene files to (re)write: `(id, html)` (validated).
    pub scenes: Vec<(String, String)>,
    /// New asset files: `(assets/... path, bytes)`.
    pub assets: Vec<(String, Vec<u8>)>,
}

/// Magic-byte check of an asset against its extension (a renamed
/// executable never becomes an "image").
pub fn sniff_asset(rel: &str, bytes: &[u8]) -> bool {
    let Some(ext) = project::extension(rel) else {
        return false;
    };
    let starts = |magic: &[u8]| bytes.starts_with(magic);
    match ext.as_str() {
        "png" => starts(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => starts(&[0xFF, 0xD8, 0xFF]),
        "gif" => starts(b"GIF87a") || starts(b"GIF89a"),
        "webp" => bytes.len() > 12 && starts(b"RIFF") && &bytes[8..12] == b"WEBP",
        "svg" => {
            let head =
                String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
            std::str::from_utf8(bytes).is_ok() && head.contains("<svg")
        }
        "wav" => bytes.len() > 12 && starts(b"RIFF") && &bytes[8..12] == b"WAVE",
        "mp3" => starts(b"ID3") || (bytes.len() > 1 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0),
        "ogg" => starts(b"OggS"),
        "m4a" | "mp4" => bytes.len() > 12 && &bytes[4..8] == b"ftyp",
        "webm" => starts(&[0x1A, 0x45, 0xDF, 0xA3]),
        "woff2" => starts(b"wOF2"),
        "woff" => starts(b"wOFF"),
        "ttf" => starts(&[0x00, 0x01, 0x00, 0x00]) || starts(b"true"),
        "otf" => starts(b"OTTO"),
        _ => false,
    }
}

/// Validate a change against the project as it is on disk; returns the
/// metadata that will be written.
pub fn validate_change(dir: &Path, change: &Change) -> Result<(VideoMeta, String), Rejection> {
    let existing_assets = list_assets(dir);
    if existing_assets.len() + change.assets.len() > MAX_ASSETS {
        return Err(invalid(format!("a video holds at most {MAX_ASSETS} files")));
    }
    let mut added: u64 = 0;
    for (rel, bytes) in &change.assets {
        if !project::valid_asset_path(rel) {
            return Err(invalid(format!("not an asset path: {rel}")));
        }
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(Rejection::new(
                "too_large",
                format!("{rel} is larger than 80 MB"),
            ));
        }
        if !sniff_asset(rel, bytes) {
            return Err(invalid(format!(
                "{rel}: the content does not match its file type"
            )));
        }
        added += bytes.len() as u64;
    }
    let replaced: u64 = change
        .assets
        .iter()
        .filter_map(|(rel, _)| existing_assets.get(rel))
        .sum();
    if project_size(dir).saturating_sub(replaced) + added > MAX_PROJECT_BYTES {
        return Err(Rejection::new(
            "too_large",
            "the video would be larger than 88 MB (the export limit): use smaller or compressed files",
        ));
    }
    let meta = match &change.meta {
        Some(meta) => meta.clone(),
        None => read_meta(dir)?,
    };
    let has_asset = |rel: &str| {
        existing_assets.contains_key(rel) || change.assets.iter().any(|(new, _)| new == rel)
    };
    project::validate_meta(&meta, &has_asset).map_err(invalid)?;
    for (id, _) in &change.scenes {
        if !meta.scenes.iter().any(|scene| &scene.id == id) {
            return Err(invalid(format!("scene \"{id}\" is not in the scene list")));
        }
    }
    for scene in &meta.scenes {
        let rel = format!("compositions/{}.html", scene.id);
        let written = change.scenes.iter().any(|(id, _)| id == &scene.id);
        if !written && read_file(dir, &rel, project::MAX_SCENE_BYTES as u64)?.is_none() {
            return Err(invalid(format!(
                "scene \"{}\" has no content yet: send its html",
                scene.id
            )));
        }
    }
    let theme = match &change.theme {
        Some(theme) => theme.clone(),
        None => read_text(dir, "theme.css", project::MAX_THEME_BYTES as u64)?.unwrap_or_default(),
    };
    Ok((meta, theme))
}

/// Apply a change: validate everything, then write the assets, the scenes,
/// the theme, `video.json` and the regenerated `index.html`, and remove the
/// files of scenes that are gone.
pub fn apply(dir: &Path, change: Change) -> Result<VideoMeta, Rejection> {
    let (meta, theme) = validate_change(dir, &change)?;
    for (rel, bytes) in &change.assets {
        write_file(dir, rel, bytes)?;
    }
    // Every scene root follows the canvas (new scenes, and all of them
    // when the aspect changed).
    let (width, height) = meta.aspect.size();
    for scene in &meta.scenes {
        let rel = format!("compositions/{}.html", scene.id);
        let html = match change.scenes.iter().find(|(id, _)| id == &scene.id) {
            Some((_, html)) => html.clone(),
            None => read_text(dir, &rel, project::MAX_SCENE_BYTES as u64)?.unwrap_or_default(),
        };
        let fitted = project::with_root_canvas(&html, &scene.id, width, height);
        let written = change.scenes.iter().any(|(id, _)| id == &scene.id);
        if written || fitted != html {
            write_file(dir, &rel, fitted.as_bytes())?;
        }
    }
    if change.theme.is_some() {
        if theme.trim().is_empty() {
            remove_file(dir, "theme.css")?;
        } else {
            write_file(dir, "theme.css", theme.as_bytes())?;
        }
    }
    let json = serde_json::to_vec_pretty(&meta).map_err(|_| io("cannot encode video.json"))?;
    write_file(dir, "video.json", &json)?;
    write_file(
        dir,
        "index.html",
        project::generate_index(&meta, &theme).as_bytes(),
    )?;
    // Scene files no scene uses any more.
    for name in list_level(&dir.join("compositions")).keys() {
        let Some(id) = name.strip_suffix(".html") else {
            continue;
        };
        if project::valid_id(id) && !meta.scenes.iter().any(|scene| scene.id == id) {
            remove_file(dir, &format!("compositions/{name}"))?;
        }
    }
    Ok(meta)
}

/// A project in the library list.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectSummary {
    pub id: String,
    pub title: String,
    pub aspect: String,
    pub width: u32,
    pub height: u32,
    pub duration: f64,
    pub scenes: usize,
    pub template: Option<String>,
    /// Milliseconds since the epoch of the last change (`video.json`).
    pub updated_ms: u64,
    pub exports: usize,
}

pub fn summary(dir: &Path, id: &str) -> Result<ProjectSummary, Rejection> {
    let meta = read_meta(dir)?;
    let (width, height) = meta.aspect.size();
    let updated_ms = std::fs::symlink_metadata(dir.join("video.json"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Ok(ProjectSummary {
        id: id.to_string(),
        title: meta.title.clone(),
        aspect: meta.aspect.label().to_string(),
        width,
        height,
        duration: meta.duration(),
        scenes: meta.scenes.len(),
        template: meta.template.clone(),
        updated_ms,
        exports: list_exports(dir).len(),
    })
}

/// Every project of the realm, most recently changed first. Folders that
/// are not projects (or are broken) are skipped.
pub fn list_projects(realm: &Path) -> Vec<ProjectSummary> {
    let library = library_dir(realm);
    if !is_real_dir(&library) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&library) else {
        return Vec::new();
    };
    let mut out: Vec<ProjectSummary> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            if !valid_project_id(&name) || !is_real_dir(&entry.path()) {
                return None;
            }
            summary(&entry.path(), &name).ok()
        })
        .take(MAX_PROJECTS)
        .collect();
    out.sort_by(|a, b| b.updated_ms.cmp(&a.updated_ms).then(a.id.cmp(&b.id)));
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::video::project::{Aspect, AudioTrack, Scene, Variable, VariableKind};

    pub const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    pub fn scene_html(id: &str) -> String {
        format!(
            "<template id=\"{id}-template\"><style>#root{{position:absolute;inset:0}}</style>\
             <div id=\"root\" data-composition-id=\"{id}\" data-width=\"1920\" data-height=\"1080\" data-no-timeline>\
             <h1 id=\"{id}-title\" class=\"clip\" data-start=\"0\" data-duration=\"2\" data-var-text=\"headline\">Hola</h1>\
             </div></template>"
        )
    }

    pub fn sample_meta() -> VideoMeta {
        let mut meta = VideoMeta::new("Demo", Aspect::Landscape, 30);
        meta.scenes = vec![
            Scene {
                id: "intro".into(),
                title: "Intro".into(),
                duration: 2.0,
            },
            Scene {
                id: "outro".into(),
                title: "Cierre".into(),
                duration: 3.0,
            },
        ];
        meta.variables = vec![Variable {
            id: "headline".into(),
            kind: VariableKind::Text,
            label: "Titular".into(),
            value: "Hola".into(),
        }];
        meta
    }

    /// A realm folder with one fresh project; returns (tempdir, realm, id, dir).
    pub fn fresh_project() -> (tempfile::TempDir, PathBuf, String, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let realm = tmp.path().join("realm");
        std::fs::create_dir(&realm).unwrap();
        let id = new_project_id();
        let dir = create_project_dir(&realm, &id).unwrap();
        apply(
            &dir,
            Change {
                meta: Some(sample_meta()),
                theme: None,
                scenes: vec![
                    ("intro".into(), scene_html("intro")),
                    ("outro".into(), scene_html("outro")),
                ],
                assets: vec![],
            },
        )
        .unwrap();
        (tmp, realm, id, dir)
    }

    #[test]
    fn project_ids_and_files_are_a_closed_set() {
        assert!(valid_project_id(&new_project_id()));
        for bad in [
            "",
            "../x",
            "ABCDEF0123456789ABCDEF0123456789",
            &"a".repeat(31),
            &"g".repeat(32),
        ] {
            assert!(!valid_project_id(bad), "{bad}");
        }
        for ok in [
            "video.json",
            "index.html",
            "theme.css",
            "compositions/intro.html",
            "assets/a.png",
            "assets/fonts/x.woff2",
            "exports/mi-video-2.mp4",
        ] {
            assert!(valid_project_file(ok), "{ok}");
        }
        for bad in [
            "../video.json",
            "compositions/../x.html",
            "compositions/Intro.html",
            "exports/a.mov",
            "exports/../../x.mp4",
            "assets/x.js",
            "/etc/passwd",
            "x/video.json",
        ] {
            assert!(!valid_project_file(bad), "{bad}");
        }
    }

    #[test]
    fn a_change_writes_scenes_meta_and_a_generated_index() {
        let (_tmp, realm, id, dir) = fresh_project();
        let index = read_text(&dir, "index.html", 1 << 20).unwrap().unwrap();
        assert!(
            index.contains("data-composition-src=\"compositions/outro.html\" data-start=\"2\"")
        );
        assert!(
            read_text(&dir, "compositions/intro.html", 1 << 20)
                .unwrap()
                .is_some()
        );
        let listed = list_projects(&realm);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].duration, 5.0);
        assert_eq!(listed[0].aspect, "16:9");
        // Reorder + drop a scene: its file goes, the index follows.
        let mut meta = read_meta(&dir).unwrap();
        meta.scenes.reverse();
        meta.scenes.pop();
        apply(
            &dir,
            Change {
                meta: Some(meta),
                ..Change::default()
            },
        )
        .unwrap();
        assert!(
            read_text(&dir, "compositions/intro.html", 1 << 20)
                .unwrap()
                .is_none()
        );
        let index = read_text(&dir, "index.html", 1 << 20).unwrap().unwrap();
        assert!(index.contains("data-composition-id=\"outro\" data-composition-src=\"compositions/outro.html\" data-start=\"0\" data-duration=\"3\""));
        assert!(!index.contains("compositions/intro.html"));
    }

    #[test]
    fn an_invalid_change_writes_nothing() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        let before = read_text(&dir, "video.json", 1 << 20).unwrap();
        let mut meta = read_meta(&dir).unwrap();
        meta.variables[0].kind = VariableKind::Image;
        meta.variables[0].value = "assets/missing.png".into();
        let err = apply(
            &dir,
            Change {
                meta: Some(meta),
                assets: vec![("assets/new.png".into(), PNG.to_vec())],
                ..Change::default()
            },
        )
        .unwrap_err();
        assert_eq!(err.kind, "invalid");
        assert_eq!(read_text(&dir, "video.json", 1 << 20).unwrap(), before);
        assert!(!dir.join("assets/new.png").exists());
        // A scene in the list without any content is refused too.
        let mut meta = read_meta(&dir).unwrap();
        meta.scenes.push(Scene {
            id: "extra".into(),
            title: String::new(),
            duration: 1.0,
        });
        assert!(
            apply(
                &dir,
                Change {
                    meta: Some(meta),
                    ..Change::default()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn assets_must_match_their_type_and_caps() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        let err = apply(
            &dir,
            Change {
                assets: vec![("assets/a.png".into(), b"MZ\x90\0".to_vec())],
                ..Change::default()
            },
        )
        .unwrap_err();
        assert!(err.message.contains("does not match"), "{}", err.message);
        let mut meta = read_meta(&dir).unwrap();
        meta.audio.music = Some(AudioTrack {
            file: "assets/m.wav".into(),
            volume: 0.5,
            duration: None,
        });
        let wav = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        apply(
            &dir,
            Change {
                meta: Some(meta),
                assets: vec![("assets/m.wav".into(), wav)],
                ..Change::default()
            },
        )
        .unwrap();
        assert!(list_assets(&dir).contains_key("assets/m.wav"));
        assert!(
            read_text(&dir, "index.html", 1 << 20)
                .unwrap()
                .unwrap()
                .contains("<audio id=\"music\"")
        );
        assert!(sniff_asset(
            "assets/x.svg",
            b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"
        ));
        assert!(!sniff_asset("assets/x.svg", b"<html></html>"));
        assert!(sniff_asset("assets/fonts/x.woff2", b"wOF2\0\x01"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_inside_a_project_are_never_followed() {
        let (tmp, realm, id, dir) = fresh_project();
        let outside = tmp.path().join("outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        std::fs::remove_file(dir.join("theme.css")).ok();
        std::os::unix::fs::symlink(&outside, dir.join("theme.css")).unwrap();
        assert!(read_text(&dir, "theme.css", 1 << 20).is_err());
        assert!(write_file(&dir, "theme.css", b"x").is_err());
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");
        // A symlinked assets folder is refused for writes.
        std::fs::remove_dir_all(dir.join("assets")).unwrap();
        std::os::unix::fs::symlink(tmp.path(), dir.join("assets")).unwrap();
        assert!(write_file(&dir, "assets/a.png", PNG).is_err());
        assert!(list_assets(&dir).is_empty());
        // A symlinked project folder does not resolve.
        let fake = new_project_id();
        std::os::unix::fs::symlink(&dir, library_dir(&realm).join(&fake)).unwrap();
        assert!(project_dir(&realm, &fake).is_err());
        assert!(project_dir(&realm, &id).is_ok());
    }
}
