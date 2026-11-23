//! The simple editor's core side (R-V1): what the Videos editor reads and
//! the few changes it can make, all through the library's
//! validate-then-write path.
//!
//! - [`view`]: the project for the editor (metadata, assets, exports) plus
//!   the sources the renderer lints with `@hyperframes/lint`.
//! - [`apply_patch`]: title, aspect, variable values, scene order and
//!   durations (dropping a scene removes it), voice/music volume or
//!   removal. Never HTML: changing what a scene shows is the assistant's job
//!   ("Ask for a change in this scene").
//! - [`import_picked`]: a file the user picked in the NATIVE dialog (the
//!   renderer never names a path) becomes a project asset: the logo or an
//!   image variable, the music or the voice-over. The same refusals as chat
//!   attachments apply (the app's own data, credential stores and key
//!   files), plus the asset type check (extension and magic bytes) and the
//!   size caps.

use std::collections::BTreeMap;
use std::io::Read as _;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::library::{self, Change};
use super::project::{self, AssetKind, AudioTrack, VariableKind, VideoMeta};
use crate::tools::Rejection;

fn invalid(message: impl Into<String>) -> Rejection {
    Rejection::new("invalid", message)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssetView {
    pub path: String,
    pub kind: &'static str,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ExportView {
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SceneSource {
    pub id: String,
    pub html: String,
}

/// The sources `@hyperframes/lint` checks in the renderer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Sources {
    pub index: String,
    pub scenes: Vec<SceneSource>,
}

/// Everything the editor shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ProjectView {
    pub id: String,
    pub meta: VideoMeta,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub assets: Vec<AssetView>,
    pub exports: Vec<ExportView>,
    /// Bytes the render bundle will hold (everything but the exports).
    pub size: u64,
    pub sources: Sources,
}

fn kind_name(kind: AssetKind) -> &'static str {
    match kind {
        AssetKind::Image => "image",
        AssetKind::Audio => "audio",
        AssetKind::Video => "video",
        AssetKind::Font => "font",
    }
}

pub fn view(dir: &Path, id: &str) -> Result<ProjectView, Rejection> {
    let meta = library::read_meta(dir)?;
    let index = library::read_text(dir, "index.html", 4 * 1024 * 1024)?.unwrap_or_default();
    let mut scenes = Vec::new();
    for scene in &meta.scenes {
        let html = library::read_text(
            dir,
            &format!("compositions/{}.html", scene.id),
            project::MAX_SCENE_BYTES as u64,
        )?
        .unwrap_or_default();
        scenes.push(SceneSource {
            id: scene.id.clone(),
            html,
        });
    }
    let assets = library::list_assets(dir)
        .into_iter()
        .filter_map(|(path, size)| {
            let (_, kind) = project::asset_type(&path)?;
            Some(AssetView {
                path,
                kind: kind_name(kind),
                size,
            })
        })
        .collect();
    let exports = library::list_exports(dir)
        .into_iter()
        .map(|(name, size)| ExportView { name, size })
        .collect();
    let (width, height) = meta.aspect.size();
    Ok(ProjectView {
        id: id.to_string(),
        duration: meta.duration(),
        width,
        height,
        assets,
        exports,
        size: library::project_size(dir),
        sources: Sources { index, scenes },
        meta,
    })
}

/// One scene in the editor's new order.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScenePatch {
    pub id: String,
    pub duration: f64,
}

/// What the editor can change.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditorPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub aspect: Option<String>,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    /// The full scene list in its new order (a scene left out is removed).
    #[serde(default)]
    pub scenes: Option<Vec<ScenePatch>>,
    #[serde(default)]
    pub voice_volume: Option<f64>,
    #[serde(default)]
    pub music_volume: Option<f64>,
    #[serde(default)]
    pub remove_voice: bool,
    #[serde(default)]
    pub remove_music: bool,
}

/// Apply an editor patch to a project (validated as a whole).
pub fn apply_patch(dir: &Path, patch: &EditorPatch) -> Result<VideoMeta, Rejection> {
    let mut meta = library::read_meta(dir)?;
    if let Some(title) = &patch.title {
        meta.title = project::clean_title(title).ok_or_else(|| invalid("the title is empty"))?;
    }
    if let Some(aspect) = &patch.aspect {
        meta.aspect = project::Aspect::parse(aspect).ok_or_else(|| invalid("unknown aspect"))?;
    }
    for (id, value) in &patch.values {
        let variable = meta
            .variables
            .iter_mut()
            .find(|v| &v.id == id)
            .ok_or_else(|| invalid(format!("no variable {id}")))?;
        variable.value = match variable.kind {
            VariableKind::Color => value.trim().to_ascii_lowercase(),
            VariableKind::Image => value.trim().to_string(),
            VariableKind::Text => value.clone(),
            VariableKind::Number => value.trim().replace(',', "."),
        };
    }
    if let Some(scenes) = &patch.scenes {
        let mut next = Vec::with_capacity(scenes.len());
        for wanted in scenes {
            let scene = meta
                .scenes
                .iter()
                .find(|s| s.id == wanted.id)
                .ok_or_else(|| invalid(format!("no scene {}", wanted.id)))?;
            if next.iter().any(|s: &project::Scene| s.id == wanted.id) {
                return Err(invalid("a scene is listed twice"));
            }
            let mut scene = scene.clone();
            scene.duration = project::round_ms(wanted.duration);
            next.push(scene);
        }
        meta.scenes = next;
    }
    for (volume, track) in [
        (patch.voice_volume, &mut meta.audio.voice),
        (patch.music_volume, &mut meta.audio.music),
    ] {
        if let (Some(volume), Some(track)) = (volume, track.as_mut()) {
            track.volume = project::round_ms(volume.clamp(0.0, 1.0));
        }
    }
    if patch.remove_voice {
        meta.audio.voice = None;
    }
    if patch.remove_music {
        meta.audio.music = None;
    }
    library::apply(
        dir,
        Change {
            meta: Some(meta),
            ..Change::default()
        },
    )
}

/// Where a picked file goes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Slot {
    /// An image variable (logo, photo...).
    Image {
        variable: String,
    },
    Music,
    Voice,
}

impl Slot {
    /// The native dialog's filter.
    pub fn filter(&self) -> (&'static str, &'static [&'static str]) {
        match self {
            Slot::Image { .. } => ("Images", &["png", "jpg", "jpeg", "webp", "svg", "gif"]),
            Slot::Music | Slot::Voice => ("Audio", &["mp3", "wav", "m4a", "ogg"]),
        }
    }
}

/// Read a picked file with the attachment refusals (app data, credential
/// stores, key files), no symlink, a regular file, at most `cap` bytes.
pub fn read_picked(
    app_data: &Path,
    home: Option<&Path>,
    path: &Path,
    cap: u64,
) -> Result<Vec<u8>, Rejection> {
    let refused = || Rejection::new("not_allowed", "this file cannot be used");
    let canonical =
        std::fs::canonicalize(path).map_err(|_| Rejection::new("io", "cannot read the file"))?;
    let app_root = std::fs::canonicalize(crate::realm::root_of(app_data))
        .unwrap_or_else(|_| crate::realm::root_of(app_data).to_path_buf());
    if crate::tools::grants::is_protected(&app_root, &canonical)
        || crate::tools::grants::is_sensitive_write_target(home, &canonical)
        || crate::attachments::is_read_secret(home, &canonical)
    {
        return Err(refused());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(&canonical)
        .map_err(|_| Rejection::new("io", "cannot read the file"))?;
    let meta = file
        .metadata()
        .map_err(|_| Rejection::new("io", "cannot read the file"))?;
    if !meta.is_file() {
        return Err(refused());
    }
    if meta.len() > cap {
        return Err(Rejection::new("too_large", "the file is too large"));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(cap + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Rejection::new("io", "cannot read the file"))?;
    if bytes.len() as u64 > cap {
        return Err(Rejection::new("too_large", "the file is too large"));
    }
    Ok(bytes)
}

/// A free `assets/` name for a picked file: its slug, `-2`, `-3`...
fn free_asset_name(dir: &Path, original: &Path, ext: &str) -> String {
    let stem = original
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut slug = crate::tools::website::slug(&stem);
    if slug == "site" {
        slug = "file".into();
    }
    slug.truncate(48);
    let slug = slug.trim_end_matches('-').to_string();
    let existing = library::list_assets(dir);
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("assets/{slug}.{ext}")
        } else {
            format!("assets/{slug}-{n}.{ext}")
        };
        if !existing.contains_key(&name) {
            return name;
        }
        n += 1;
    }
}

/// Put a picked file's bytes into the project for `slot`.
pub fn import_picked(
    dir: &Path,
    slot: &Slot,
    original: &Path,
    bytes: Vec<u8>,
) -> Result<VideoMeta, Rejection> {
    let ext = original
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .map(|e| if e == "jpeg" { "jpg".to_string() } else { e })
        .ok_or_else(|| invalid("the file has no type"))?;
    let (_, allowed) = slot.filter();
    if !allowed.contains(&ext.as_str()) {
        return Err(invalid("this kind of file cannot be used here"));
    }
    let rel = free_asset_name(dir, original, &ext);
    if !library::sniff_asset(&rel, &bytes) {
        return Err(invalid("the file content does not match its type"));
    }
    let mut meta = library::read_meta(dir)?;
    match slot {
        Slot::Image { variable } => {
            let target = meta
                .variables
                .iter_mut()
                .find(|v| &v.id == variable && v.kind == VariableKind::Image)
                .ok_or_else(|| invalid("no image field with that name"))?;
            target.value = rel.clone();
        }
        Slot::Music => {
            let volume = meta.audio.music.as_ref().map_or(0.6, |m| m.volume);
            meta.audio.music = Some(AudioTrack {
                file: rel.clone(),
                volume,
                duration: None,
            });
        }
        Slot::Voice => {
            let volume = meta.audio.voice.as_ref().map_or(1.0, |v| v.volume);
            meta.audio.voice = Some(AudioTrack {
                file: rel.clone(),
                volume,
                duration: super::tool::wav_seconds(&bytes),
            });
        }
    }
    library::apply(
        dir,
        Change {
            meta: Some(meta),
            assets: vec![(rel, bytes)],
            ..Change::default()
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::library::tests::{PNG, fresh_project};
    use crate::video::project::Variable;

    fn with_logo(dir: &Path) {
        let mut meta = library::read_meta(dir).unwrap();
        meta.variables.push(Variable {
            id: "logo".into(),
            kind: VariableKind::Image,
            label: "Logo".into(),
            value: String::new(),
        });
        library::apply(
            dir,
            Change {
                meta: Some(meta),
                ..Change::default()
            },
        )
        .unwrap();
    }

    #[test]
    fn the_view_carries_meta_assets_and_lint_sources() {
        let (_tmp, _realm, id, dir) = fresh_project();
        let v = view(&dir, &id).unwrap();
        assert_eq!(v.id, id);
        assert_eq!(v.duration, 5.0);
        assert_eq!((v.width, v.height), (1920, 1080));
        assert!(v.sources.index.contains("data-composition-id=\"main\""));
        assert_eq!(v.sources.scenes.len(), 2);
        assert!(v.sources.scenes[0].html.contains("intro-template"));
        assert!(v.exports.is_empty());
        assert!(v.size > 0);
    }

    #[test]
    fn patches_reorder_retime_drop_and_reshape() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        let patch = EditorPatch {
            title: Some("  Nuevo   título ".into()),
            aspect: Some("9:16".into()),
            values: BTreeMap::from([("headline".to_string(), "Adiós".to_string())]),
            scenes: Some(vec![ScenePatch {
                id: "outro".into(),
                duration: 6.25,
            }]),
            ..EditorPatch::default()
        };
        let meta = apply_patch(&dir, &patch).unwrap();
        assert_eq!(meta.title, "Nuevo título");
        assert_eq!(meta.scenes.len(), 1);
        assert_eq!(meta.duration(), 6.25);
        assert_eq!(meta.variables[0].value, "Adiós");
        assert!(
            library::read_text(&dir, "compositions/intro.html", 1 << 20)
                .unwrap()
                .is_none()
        );
        let outro = library::read_text(&dir, "compositions/outro.html", 1 << 20)
            .unwrap()
            .unwrap();
        assert!(
            outro.contains("data-width=\"1080\" data-height=\"1920\""),
            "{outro}"
        );
        for bad in [
            EditorPatch {
                values: BTreeMap::from([("nope".to_string(), "x".to_string())]),
                ..EditorPatch::default()
            },
            EditorPatch {
                scenes: Some(vec![ScenePatch {
                    id: "ghost".into(),
                    duration: 2.0,
                }]),
                ..EditorPatch::default()
            },
            EditorPatch {
                scenes: Some(vec![]),
                ..EditorPatch::default()
            },
            EditorPatch {
                scenes: Some(vec![ScenePatch {
                    id: "outro".into(),
                    duration: 500.0,
                }]),
                ..EditorPatch::default()
            },
            EditorPatch {
                aspect: Some("4:3".into()),
                ..EditorPatch::default()
            },
            EditorPatch {
                title: Some("   ".into()),
                ..EditorPatch::default()
            },
        ] {
            assert!(apply_patch(&dir, &bad).is_err(), "{bad:?}");
        }
        assert_eq!(library::read_meta(&dir).unwrap().title, "Nuevo título");
    }

    #[test]
    fn picked_files_become_assets_for_their_slot() {
        let (tmp, _realm, _id, dir) = fresh_project();
        with_logo(&dir);
        let meta = import_picked(
            &dir,
            &Slot::Image {
                variable: "logo".into(),
            },
            Path::new("/x/Mi Logo.PNG"),
            PNG.to_vec(),
        )
        .unwrap();
        assert_eq!(meta.variables[1].value, "assets/mi-logo.png");
        // The same name again gets a fresh one; the old file stays.
        let meta = import_picked(
            &dir,
            &Slot::Image {
                variable: "logo".into(),
            },
            Path::new("/x/mi logo.png"),
            PNG.to_vec(),
        )
        .unwrap();
        assert_eq!(meta.variables[1].value, "assets/mi-logo-2.png");
        let wav = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        let meta = import_picked(&dir, &Slot::Music, Path::new("/x/song.wav"), wav).unwrap();
        assert_eq!(meta.audio.music.as_ref().unwrap().file, "assets/song.wav");
        let meta = apply_patch(
            &dir,
            &EditorPatch {
                music_volume: Some(1.7),
                ..EditorPatch::default()
            },
        )
        .unwrap();
        assert_eq!(meta.audio.music.as_ref().unwrap().volume, 1.0);
        let meta = apply_patch(
            &dir,
            &EditorPatch {
                remove_music: true,
                ..EditorPatch::default()
            },
        )
        .unwrap();
        assert!(meta.audio.music.is_none());
        // Wrong types and fake content are refused.
        assert!(import_picked(&dir, &Slot::Music, Path::new("/x/a.png"), PNG.to_vec()).is_err());
        assert!(
            import_picked(
                &dir,
                &Slot::Image {
                    variable: "logo".into()
                },
                Path::new("/x/a.png"),
                b"MZ".to_vec()
            )
            .is_err()
        );
        assert!(
            import_picked(
                &dir,
                &Slot::Image {
                    variable: "headline".into()
                },
                Path::new("/x/a.png"),
                PNG.to_vec()
            )
            .is_err()
        );
        // Reading a picked file refuses the app's own data folder.
        let app_data = tmp.path();
        let inside = dir.join("video.json");
        assert_eq!(
            read_picked(app_data, None, &inside, 1 << 20)
                .unwrap_err()
                .kind,
            "not_allowed"
        );
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), PNG).unwrap();
        assert_eq!(
            read_picked(app_data, None, outside.path(), 1 << 20).unwrap(),
            PNG
        );
        assert_eq!(
            read_picked(app_data, None, outside.path(), 4)
                .unwrap_err()
                .kind,
            "too_large"
        );
    }

    #[test]
    fn slots_parse_from_the_renderer_strictly() {
        let slot: Slot = serde_json::from_str(r#"{"kind":"image","variable":"logo"}"#).unwrap();
        assert_eq!(
            slot,
            Slot::Image {
                variable: "logo".into()
            }
        );
        assert!(
            serde_json::from_str::<Slot>(r#"{"kind":"image","variable":"logo","path":"/etc"}"#)
                .is_err()
        );
        assert!(serde_json::from_str::<Slot>(r#"{"kind":"file"}"#).is_err());
    }
}
