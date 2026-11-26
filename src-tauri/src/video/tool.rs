//! `create_video` / `edit_video` (R-V1): the model authors HyperFrames
//! videos into the user's video library.
//!
//! Two tools, like `write_website` one validated write each:
//! - `create_video` makes a new project from a title, an aspect, its scenes
//!   (each a `<template>`-wrapped HyperFrames composition), fill-in
//!   variables, an optional shared `theme_css`, an optional voice-over
//!   (kokoro text-to-speech, saved as `assets/voiceover.wav`) and images the
//!   model generated in this chat (`generate_image`, imported by path from
//!   the app's own images folder only).
//! - `edit_video` changes one: replace/add/remove/reorder scenes, set
//!   durations, upsert variables or just their values, replace the theme or
//!   the voice-over, import images. Called with ONLY `project_id` it returns
//!   the project as it is now (the user may have edited it in the Videos
//!   editor), so the model always edits the current version.
//!
//! Everything is validated before anything is written (`library::apply`):
//! errors go back to the model as the tool result so it can fix and retry.
//! Writes land in the app's own library (like generated images), never in
//! the user's folders, so no approval card is involved; nothing the model
//! sends is ever a filesystem path except an image path that must resolve
//! directly inside `app_data/images`.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use super::library::{self, Change};
use super::motion;
use super::project::{self, Aspect, AudioTrack, Scene, Variable, VariableKind, VideoMeta};
use crate::tools::Rejection;

pub const CREATE: &str = "create_video";
pub const EDIT: &str = "edit_video";

/// Longest voice-over text (characters): about 4 minutes of speech.
pub const MAX_VOICE_CHARS: usize = 4000;
/// Most images imported in one call.
pub const MAX_IMAGES_PER_CALL: usize = 8;

/// What the model is told about making videos (appended to the system
/// prompt with the other always-on guidance).
pub const GUIDANCE: &str = "Making videos:\n\
- When the user asks for a video, an animation, a reel, a promo, an intro or an \
explainer, call create_video. To change one, call edit_video with its project_id; \
call edit_video with ONLY project_id first to read the current version (the user may \
have edited it). The video opens in the preview; the user exports the MP4 from there \
(rendered on our servers, never by you).\n\
- A video is a list of scenes played back to back. Each scene's html is ONE \
<template id=\"<scene-id>-template\"> holding a <style>, a root <div id=\"root\" \
data-composition-id=\"<scene-id>\" data-width=\"W\" data-height=\"H\"> and its \
content. Size the root with position:absolute; inset:0. Canvas: 1920x1080 for 16:9, \
1080x1920 for 9:16, 1080x1080 for 1:1. Prefix every id and class with the scene id \
(#intro-title) so ids stay unique across scenes.\n\
- Timing: a scene lasts its duration (set in the scenes list). Put its content in \
ONE stage, <div id=\"<scene>-stage\" class=\"clip <scene>-stage\" data-start=\"0\" \
data-duration=\"<the scene's duration>\"> with position:absolute; inset:0, which holds \
the layout. A .clip shows over [data-start, data-start+data-duration), seconds local \
to the scene, and outside that window a .clip in the page flow takes NO space: a \
.clip per line that appears or ends mid-scene makes everything around it jump. \
Never wrap the lines of a layout in their own .clip; stagger them with \
animation-delay on the stage's children (they keep their place while invisible). \
Use more .clip elements only for position:absolute overlays.\n\
- Motion: animate with CSS @keyframes (or the Web Animations API with fill:\"both\" \
then pause()). Put each animation on the element that moves (a child of the \
stage), never on the .clip itself; one entrance per element. animation-delay \
counts from the clip's data-start; always animation-fill-mode: both (without it a \
delayed element shows before its entrance, or vanishes after it) and a finite \
iteration count. Animate only transform and opacity, never width, height, margin, \
padding or font-size (that re-lays out the scene on every frame: text re-wraps, \
neighbours move). Entrances 0.4 to 0.8 s, ease-out, 0.1 to 0.3 s apart, all \
finished at least 0.5 s before the scene ends (data-start + delay + duration). \
Never use GSAP, \
Date.now, Math.random (use a seeded generator), timers, requestAnimationFrame, \
fetch or anything that depends on the wall clock: the film must look the same \
every time it is rendered.\n\
- Nothing loads from the network: images, audio and fonts are files in assets/ \
referenced with relative paths (assets/logo.png, assets/fonts/x.woff2) or data: URIs. \
Fonts: system-ui or a font file in assets/fonts with @font-face (put shared \
@font-face and palette rules in theme_css). Media: <video muted playsinline> (or \
data-has-audio=\"true\"), every <audio> has an id; never call play(), pause() or set \
currentTime, never autoplay, loop or crossorigin.\n\
- Make the video easy to customize: declare variables for the texts, colors and \
images the user will want to change (type text, color or image) and bind them \
with data-var-text=\"id\" (keep the text as the fallback content), \
data-var-src=\"id\" on <img>, and var(--id) in CSS for colors. Chart data: a \
number variable is var(--id) in CSS (width: calc(var(--bar-1) / 50 * 100%)), so \
edited values move the bars.\n\
- Voice-over: pass voiceover {text, voice} (voices ef_dora or em_alex in Spanish, \
af_heart in English); the result tells you its length, so size the scenes to it. \
Images: call generate_image first, then pass its returned path in images \
[{from, name}] and use assets/<name> in the scenes.\n\
- Every video must work in ALL THREE formats: the user can export the same \
project as 16:9, 9:16 and 1:1 at once, which only changes the canvas size. Lay \
each scene out to fit any canvas: center content with flexbox or grid inside \
the stage and a padding of at least 6% (the safe area); size type and spacing \
with vmin or clamp() (font-size: clamp(32px, 7vmin, 120px)), never fixed \
pixel positions or widths that assume one shape; max-width: 100% on text \
boxes and images (object-fit: contain), overflow-wrap: anywhere on long \
words; no text wider than the narrowest canvas (1080 px). For a different \
arrangement per shape use @media (max-aspect-ratio: 3/4) for vertical and \
(min-aspect-ratio: 3/4) and (max-aspect-ratio: 5/4) for square. When a turn \
creates or changes a video, the app checks it in its own format; when the \
user exports another format, the app checks that one too. If something is \
cut off, it sends you the findings to fix: change only the layout it names.\n\
- Keep it readable and bold: big type, high contrast, generous margins (safe \
area), one idea per scene, 2 to 8 seconds per scene, a clear final scene.\n\
- If the tool answers ok:false, fix exactly what it says and call it again. If it \
answers ok:true with warnings, fix them with edit_video before you finish.";

// ------------------------------------------------------------- args --

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SceneArg {
    id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    duration: Option<f64>,
    #[serde(default)]
    html: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VariableArg {
    id: String,
    #[serde(rename = "type")]
    kind: VariableKind,
    #[serde(default)]
    label: Option<String>,
    #[serde(default, alias = "default")]
    value: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VoiceArg {
    pub text: String,
    #[serde(default)]
    pub voice: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ImageArg {
    pub from: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateArgs {
    title: String,
    aspect: String,
    #[serde(default)]
    fps: Option<u32>,
    #[serde(default)]
    scenes: Vec<SceneArg>,
    #[serde(default)]
    variables: Vec<VariableArg>,
    #[serde(default)]
    theme_css: Option<String>,
    #[serde(default)]
    voiceover: Option<VoiceArg>,
    #[serde(default)]
    images: Vec<ImageArg>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EditArgs {
    project_id: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    scenes: Vec<SceneArg>,
    #[serde(default)]
    order: Option<Vec<String>>,
    #[serde(default)]
    remove_scenes: Vec<String>,
    #[serde(default)]
    variables: Vec<VariableArg>,
    #[serde(default)]
    values: BTreeMap<String, String>,
    #[serde(default)]
    remove_variables: Vec<String>,
    #[serde(default)]
    theme_css: Option<String>,
    #[serde(default)]
    voiceover: Option<VoiceArg>,
    #[serde(default)]
    remove_voiceover: bool,
    #[serde(default)]
    images: Vec<ImageArg>,
}

/// A parsed, purely validated request (no disk, no network yet).
#[derive(Debug)]
pub struct Plan {
    /// `None`: a new project.
    pub project_id: Option<String>,
    /// Applied to the project's current metadata (or a fresh one).
    edit: MetaEdit,
    pub scenes: Vec<(String, String)>,
    pub theme: Option<String>,
    pub voiceover: Option<VoiceArg>,
    pub remove_voiceover: bool,
    pub images: Vec<ImageArg>,
    /// Only reading (`edit_video` with only `project_id`).
    pub read_only: bool,
}

/// `(id, kind, label, value)` of a variable to add or change.
type VariableEdit = (String, VariableKind, Option<String>, Option<String>);

/// `(id, title, duration)` of a scene to add or change.
type SceneEdit = (String, Option<String>, Option<f64>);

#[derive(Debug, Default)]
struct MetaEdit {
    title: Option<String>,
    aspect: Option<Aspect>,
    fps: Option<u32>,
    scenes: Vec<SceneEdit>,
    order: Option<Vec<String>>,
    remove_scenes: Vec<String>,
    variables: Vec<VariableEdit>,
    values: BTreeMap<String, String>,
    remove_variables: Vec<String>,
}

/// Scene edits plus the validated scene files `(id, html)`.
type SceneParts = (Vec<SceneEdit>, Vec<(String, String)>);

fn scene_parts(scenes: Vec<SceneArg>) -> Result<SceneParts, String> {
    let mut meta = Vec::new();
    let mut html = Vec::new();
    for scene in scenes {
        if !project::valid_id(&scene.id) {
            return Err(format!(
                "scene id \"{}\" is invalid: lowercase letters, digits and dashes, starting with a letter",
                scene.id
            ));
        }
        if let Some(body) = scene.html {
            html.push((scene.id.clone(), project::validate_scene(&scene.id, &body)?));
        }
        meta.push((scene.id, scene.title, scene.duration));
    }
    Ok((meta, html))
}

fn variable_parts(vars: Vec<VariableArg>) -> Vec<VariableEdit> {
    vars.into_iter()
        .map(|v| (v.id, v.kind, v.label, v.value))
        .collect()
}

fn check_voice(voice: &Option<VoiceArg>) -> Result<(), String> {
    if let Some(voice) = voice {
        let chars = voice.text.trim().chars().count();
        if chars == 0 {
            return Err("voiceover.text is empty".into());
        }
        if chars > MAX_VOICE_CHARS {
            return Err(format!(
                "voiceover.text is {chars} characters; the limit is {MAX_VOICE_CHARS}"
            ));
        }
        if let Some(name) = &voice.voice
            && !crate::tts::VOICES.contains(&name.as_str())
        {
            return Err(format!(
                "voice \"{name}\" is not available: use ef_dora, em_alex or af_heart"
            ));
        }
    }
    Ok(())
}

fn check_images(images: &[ImageArg]) -> Result<(), String> {
    if images.len() > MAX_IMAGES_PER_CALL {
        return Err(format!("at most {MAX_IMAGES_PER_CALL} images per call"));
    }
    for image in images {
        let rel = format!("assets/{}", image.name);
        let is_image = project::valid_asset_path(&rel)
            && matches!(
                project::asset_type(&rel),
                Some((_, project::AssetKind::Image))
            );
        if !is_image {
            return Err(format!(
                "image name \"{}\" is invalid: lowercase file name like hero.png or hero.jpg",
                image.name
            ));
        }
    }
    Ok(())
}

/// Parse `create_video`.
pub fn parse_create(arguments: &str) -> Result<Plan, String> {
    let args: CreateArgs = serde_json::from_str(arguments)
        .map_err(|err| format!("create_video arguments are invalid: {err}"))?;
    let title = project::clean_title(&args.title).ok_or("title is empty")?;
    let aspect =
        Aspect::parse(&args.aspect).ok_or("aspect must be \"16:9\", \"9:16\" or \"1:1\"")?;
    if args.scenes.is_empty() {
        return Err("scenes is empty: a video needs at least one scene with its html".into());
    }
    let (scenes, html) = scene_parts(args.scenes)?;
    if let Some((id, _, _)) = scenes
        .iter()
        .find(|(id, _, _)| !html.iter().any(|(h, _)| h == id))
    {
        return Err(format!("scene \"{id}\" needs its html"));
    }
    let theme = args
        .theme_css
        .map(|css| project::validate_theme(&css))
        .transpose()?;
    check_voice(&args.voiceover)?;
    check_images(&args.images)?;
    Ok(Plan {
        project_id: None,
        edit: MetaEdit {
            title: Some(title),
            aspect: Some(aspect),
            fps: Some(args.fps.unwrap_or(30)),
            scenes,
            variables: variable_parts(args.variables),
            ..MetaEdit::default()
        },
        scenes: html,
        theme,
        voiceover: args.voiceover,
        remove_voiceover: false,
        images: args.images,
        read_only: false,
    })
}

/// Parse `edit_video`.
pub fn parse_edit(arguments: &str) -> Result<Plan, String> {
    let args: EditArgs = serde_json::from_str(arguments)
        .map_err(|err| format!("edit_video arguments are invalid: {err}"))?;
    if !library::valid_project_id(&args.project_id) {
        return Err(
            "project_id is not a video of this app (use the id create_video returned)".into(),
        );
    }
    let read_only = args.title.is_none()
        && args.scenes.is_empty()
        && args.order.is_none()
        && args.remove_scenes.is_empty()
        && args.variables.is_empty()
        && args.values.is_empty()
        && args.remove_variables.is_empty()
        && args.theme_css.is_none()
        && args.voiceover.is_none()
        && !args.remove_voiceover
        && args.images.is_empty();
    let title = match args.title {
        Some(raw) => Some(project::clean_title(&raw).ok_or("title is empty")?),
        None => None,
    };
    let (scenes, html) = scene_parts(args.scenes)?;
    let theme = args
        .theme_css
        .map(|css| project::validate_theme(&css))
        .transpose()?;
    check_voice(&args.voiceover)?;
    check_images(&args.images)?;
    Ok(Plan {
        project_id: Some(args.project_id),
        edit: MetaEdit {
            title,
            scenes,
            order: args.order,
            remove_scenes: args.remove_scenes,
            variables: variable_parts(args.variables),
            values: args.values,
            remove_variables: args.remove_variables,
            ..MetaEdit::default()
        },
        scenes: html,
        theme,
        voiceover: args.voiceover,
        remove_voiceover: args.remove_voiceover,
        images: args.images,
        read_only,
    })
}

/// Apply the metadata part of a plan to `base` (a fresh project's or the
/// current one). `has_asset` checks image values against the project.
fn edit_meta(base: VideoMeta, edit: &MetaEdit) -> Result<VideoMeta, String> {
    let mut meta = base;
    if let Some(title) = &edit.title {
        meta.title = title.clone();
    }
    if let Some(aspect) = edit.aspect {
        meta.aspect = aspect;
    }
    if let Some(fps) = edit.fps {
        meta.fps = fps;
    }
    for id in &edit.remove_scenes {
        if !meta.scenes.iter().any(|s| &s.id == id) {
            return Err(format!("remove_scenes: no scene \"{id}\""));
        }
        meta.scenes.retain(|s| &s.id != id);
    }
    for (id, title, duration) in &edit.scenes {
        match meta.scenes.iter_mut().find(|s| &s.id == id) {
            Some(scene) => {
                if let Some(title) = title {
                    scene.title = title
                        .trim()
                        .chars()
                        .take(project::MAX_LABEL_CHARS)
                        .collect();
                }
                if let Some(duration) = duration {
                    scene.duration = project::round_ms(*duration);
                }
            }
            None => meta.scenes.push(Scene {
                id: id.clone(),
                title: title
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .chars()
                    .take(project::MAX_LABEL_CHARS)
                    .collect(),
                duration: project::round_ms(
                    duration.ok_or_else(|| format!("new scene \"{id}\" needs a duration"))?,
                ),
            }),
        }
    }
    if let Some(order) = &edit.order {
        let mut ids: Vec<&String> = meta.scenes.iter().map(|s| &s.id).collect();
        let mut wanted: Vec<&String> = order.iter().collect();
        ids.sort();
        wanted.sort();
        if ids != wanted {
            return Err("order must list every scene id exactly once".into());
        }
        let mut sorted = Vec::with_capacity(meta.scenes.len());
        for id in order {
            if let Some(scene) = meta.scenes.iter().find(|s| &s.id == id) {
                sorted.push(scene.clone());
            }
        }
        meta.scenes = sorted;
    }
    for id in &edit.remove_variables {
        meta.variables.retain(|v| &v.id != id);
    }
    for (id, kind, label, value) in &edit.variables {
        match meta.variables.iter_mut().find(|v| &v.id == id) {
            Some(variable) => {
                variable.kind = *kind;
                if let Some(label) = label {
                    variable.label = label
                        .trim()
                        .chars()
                        .take(project::MAX_LABEL_CHARS)
                        .collect();
                }
                if let Some(value) = value {
                    variable.value = value.clone();
                }
            }
            None => meta.variables.push(Variable {
                id: id.clone(),
                kind: *kind,
                label: label
                    .as_deref()
                    .unwrap_or(id)
                    .trim()
                    .chars()
                    .take(project::MAX_LABEL_CHARS)
                    .collect(),
                value: value.clone().unwrap_or_default(),
            }),
        }
    }
    for (id, value) in &edit.values {
        let variable = meta
            .variables
            .iter_mut()
            .find(|v| &v.id == id)
            .ok_or_else(|| format!("values: no variable \"{id}\""))?;
        variable.value = value.clone();
    }
    for variable in &mut meta.variables {
        if variable.kind == VariableKind::Color {
            variable.value = variable.value.trim().to_ascii_lowercase();
        }
        if variable.kind == VariableKind::Number
            && let Some(number) = project::parse_number(&variable.value)
        {
            variable.value = number;
        }
        if variable.kind == VariableKind::Image {
            variable.value = variable.value.trim().to_string();
        }
    }
    Ok(meta)
}

/// The files of a project as the model reads them (`edit_video` with only
/// `project_id`).
pub fn read_for_model(dir: &Path, id: &str) -> Result<serde_json::Value, Rejection> {
    let meta = library::read_meta(dir)?;
    let mut scenes = Vec::new();
    for (scene, start) in meta.scenes.iter().zip(meta.starts()) {
        let html = library::read_text(
            dir,
            &format!("compositions/{}.html", scene.id),
            project::MAX_SCENE_BYTES as u64,
        )?
        .unwrap_or_default();
        scenes.push(serde_json::json!({
            "id": scene.id, "title": scene.title, "start": start,
            "duration": scene.duration, "html": html,
        }));
    }
    let theme =
        library::read_text(dir, "theme.css", project::MAX_THEME_BYTES as u64)?.unwrap_or_default();
    Ok(serde_json::json!({
        "ok": true,
        "project_id": id,
        "title": meta.title,
        "aspect": meta.aspect.label(),
        "fps": meta.fps,
        "duration_s": meta.duration(),
        "scenes": scenes,
        "variables": meta.variables,
        "theme_css": theme,
        "assets": library::list_assets(dir).keys().collect::<Vec<_>>(),
        "voiceover": meta.audio.voice.as_ref().map(|v| serde_json::json!({"file": v.file, "duration_s": v.duration})),
        "music": meta.audio.music.as_ref().map(|m| m.file.clone()),
    }))
}

/// The default kokoro voice for a voice-over.
pub const DEFAULT_VOICE: &str = "ef_dora";

/// Length in seconds of a WAV file (PCM header), when readable.
pub fn wav_seconds(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut at = 12;
    let mut byte_rate = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?) as usize;
        let body = at + 8;
        if id == b"fmt " && body + 12 <= bytes.len() {
            byte_rate = Some(u32::from_le_bytes(
                bytes[body + 8..body + 12].try_into().ok()?,
            ));
        }
        if id == b"data" {
            let rate = byte_rate.filter(|r| *r > 0)? as f64;
            let len = size.min(bytes.len().saturating_sub(body)) as f64;
            return Some(project::round_ms(len / rate));
        }
        at = body + size + (size & 1);
    }
    None
}

/// Run a plan against the library under `realm`: build the change (TTS,
/// image imports), apply it, and describe the result for the model. The
/// side effects are injected (testable without the network or the app's
/// images folder): `speak(text, voice)` returns kokoro WAV bytes,
/// `image(path)` the bytes of an image this app generated (or why not).
pub async fn run<S, F>(
    realm: &Path,
    plan: Plan,
    speak: S,
    load_image: impl Fn(&str) -> Result<Vec<u8>, String>,
) -> Result<(String, serde_json::Value), Rejection>
where
    S: Fn(String, String) -> F,
    F: std::future::Future<Output = Result<Vec<u8>, String>>,
{
    let invalid = |m: String| Rejection::new("invalid", m);
    if plan.read_only {
        let id = plan.project_id.clone().unwrap_or_default();
        let dir = library::project_dir(realm, &id)?;
        return Ok((id.clone(), read_for_model(&dir, &id)?));
    }
    let mut assets = Vec::new();
    for image in &plan.images {
        let bytes = load_image(&image.from).map_err(invalid)?;
        assets.push((format!("assets/{}", image.name), bytes));
    }
    let mut voice_track = None;
    if let Some(voice) = &plan.voiceover {
        let name = voice.voice.as_deref().unwrap_or(DEFAULT_VOICE);
        let wav = speak(voice.text.trim().to_string(), name.to_string())
            .await
            .map_err(|m| Rejection::new("voice", m))?;
        let duration = wav_seconds(&wav);
        assets.push(("assets/voiceover.wav".to_string(), wav));
        voice_track = Some(AudioTrack {
            file: "assets/voiceover.wav".into(),
            volume: 1.0,
            duration,
        });
    }
    let (id, dir, base, created) = match &plan.project_id {
        Some(id) => {
            let dir = library::project_dir(realm, id)?;
            let meta = library::read_meta(&dir)?;
            (id.clone(), dir, meta, false)
        }
        None => {
            let id = library::new_project_id();
            let dir = library::create_project_dir(realm, &id)?;
            let fresh = VideoMeta::new("Video", Aspect::Landscape, 30);
            (id, dir, fresh, true)
        }
    };
    let result = (|| {
        let mut meta = edit_meta(base, &plan.edit).map_err(invalid)?;
        if let Some(track) = voice_track.clone() {
            meta.audio.voice = Some(track);
        } else if plan.remove_voiceover {
            meta.audio.voice = None;
        }
        library::apply(
            &dir,
            Change {
                meta: Some(meta),
                theme: plan.theme.clone(),
                scenes: plan.scenes.clone(),
                assets,
            },
        )
    })();
    let meta = match result {
        Ok(meta) => meta,
        Err(err) => {
            if created {
                let _ = std::fs::remove_dir_all(&dir);
            }
            return Err(err);
        }
    };
    let mut warnings = Vec::new();
    if let Some(voice) = &meta.audio.voice
        && let Some(len) = voice.duration
        && len > meta.duration() + 0.05
    {
        warnings.push(format!(
            "the voice-over lasts {} s but the video lasts {} s: lengthen the scenes or it is cut",
            project::fmt_seconds(len),
            project::fmt_seconds(meta.duration())
        ));
    }
    warnings.extend(motion_warnings(&dir, &plan, &meta));
    let scenes: Vec<_> = meta
        .scenes
        .iter()
        .zip(meta.starts())
        .map(|(s, start)| serde_json::json!({"id": s.id, "start": start, "duration": s.duration}))
        .collect();
    Ok((
        id.clone(),
        serde_json::json!({
            "ok": true,
            "project_id": id,
            "title": meta.title,
            "aspect": meta.aspect.label(),
            "duration_s": meta.duration(),
            "scenes": scenes,
            "voiceover_s": meta.audio.voice.as_ref().and_then(|v| v.duration),
            "warnings": warnings,
            "note": "The video is open in the preview. The user exports the MP4 from there.",
        }),
    ))
}

/// The motion lint (`video::motion`) of every scene this call wrote or
/// retimed, against its duration now; untouched scenes are not repeated.
fn motion_warnings(dir: &Path, plan: &Plan, meta: &VideoMeta) -> Vec<String> {
    let retimed = |id: &str| {
        plan.edit
            .scenes
            .iter()
            .any(|(s, _, duration)| s == id && duration.is_some())
    };
    let mut out = Vec::new();
    for scene in &meta.scenes {
        let written = plan.scenes.iter().find(|(s, _)| *s == scene.id);
        let html = match written {
            Some((_, html)) => Some(html.clone()),
            None if retimed(&scene.id) => library::read_text(
                dir,
                &format!("compositions/{}.html", scene.id),
                project::MAX_SCENE_BYTES as u64,
            )
            .ok()
            .flatten(),
            None => None,
        };
        if let Some(html) = html {
            out.extend(motion::lint_scene(&scene.id, &html, scene.duration));
        }
    }
    out
}

/// The tool result for a failure, worded for the model.
pub fn failure_for_model(err: &Rejection) -> String {
    serde_json::json!({ "ok": false, "error": err.kind, "message": err.message }).to_string()
}

/// The two OpenAI function definitions, offered on every reply.
pub fn tool_definitions() -> Vec<serde_json::Value> {
    let scene = serde_json::json!({ "type": "object", "properties": {
        "id": { "type": "string", "description": "Scene id: lowercase letters, digits, dashes (intro, step-2)." },
        "title": { "type": "string", "description": "Short scene name the user sees in the editor, in the user's language." },
        "duration": { "type": "number", "description": "Seconds (0.5 to 120)." },
        "html": { "type": "string", "description": "The scene file: ONE <template id=\"<id>-template\"> with <style>, the root div data-composition-id=\"<id>\" and the content." }
    }, "required": ["id"] });
    let variable = serde_json::json!({ "type": "object", "properties": {
        "id": { "type": "string", "description": "Variable id: lowercase letters, digits, dashes." },
        "type": { "type": "string", "enum": ["text", "color", "image", "number"] },
        "label": { "type": "string", "description": "Field name the user sees, in the user's language." },
        "value": { "type": "string", "description": "text; #rrggbb color; assets/<image file>; or a number (42, 6.5)." }
    }, "required": ["id", "type"] });
    let voice = serde_json::json!({ "type": "object", "properties": {
        "text": { "type": "string", "description": "What the narrator says." },
        "voice": { "type": "string", "enum": crate::tts::VOICES }
    }, "required": ["text"] });
    let images = serde_json::json!({ "type": "array", "items": { "type": "object", "properties": {
        "from": { "type": "string", "description": "The image path generate_image returned in this chat." },
        "name": { "type": "string", "description": "File name to save it as in assets/ (hero.png)." }
    }, "required": ["from", "name"] } });
    vec![
        serde_json::json!({ "type": "function", "function": {
            "name": CREATE,
            "description": "Create a video (HyperFrames composition: HTML scenes animated with CSS) in the user's video library. It opens in the preview; the user exports the MP4 from there.",
            "parameters": { "type": "object", "properties": {
                "title": { "type": "string", "description": "Short title in the user's language." },
                "aspect": { "type": "string", "enum": ["16:9", "9:16", "1:1"] },
                "fps": { "type": "integer", "enum": [24, 25, 30, 60] },
                "scenes": { "type": "array", "items": scene, "description": "Scenes in playback order; each needs html and duration." },
                "variables": { "type": "array", "items": variable },
                "theme_css": { "type": "string", "description": "Shared CSS: @font-face rules, palette custom properties." },
                "voiceover": voice,
                "images": images
            }, "required": ["title", "aspect", "scenes"] }
        }}),
        serde_json::json!({ "type": "function", "function": {
            "name": EDIT,
            "description": "Change a video created with create_video. Send only what changes. With ONLY project_id it returns the current scenes, variables and theme (read before editing).",
            "parameters": { "type": "object", "properties": {
                "project_id": { "type": "string" },
                "title": { "type": "string" },
                "scenes": { "type": "array", "items": scene, "description": "Scenes to add or change (by id). A new scene is appended unless order says otherwise." },
                "order": { "type": "array", "items": { "type": "string" }, "description": "Every scene id in the new playback order." },
                "remove_scenes": { "type": "array", "items": { "type": "string" } },
                "variables": { "type": "array", "items": variable, "description": "Variables to add or change." },
                "values": { "type": "object", "additionalProperties": { "type": "string" }, "description": "New values by variable id." },
                "remove_variables": { "type": "array", "items": { "type": "string" } },
                "theme_css": { "type": "string" },
                "voiceover": voice,
                "remove_voiceover": { "type": "boolean" },
                "images": images
            }, "required": ["project_id"] }
        }}),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::library::tests::{PNG, scene_html};

    fn create_args(extra: serde_json::Value) -> String {
        let mut args = serde_json::json!({
            "title": "  Promo   de verano ",
            "aspect": "9:16",
            "scenes": [
                { "id": "intro", "title": "Inicio", "duration": 3, "html": scene_html("intro") },
                { "id": "outro", "duration": 2.5, "html": scene_html("outro") }
            ],
            "variables": [
                { "id": "headline", "type": "text", "label": "Titular", "value": "Hola" },
                { "id": "accent", "type": "color", "label": "Color", "value": "#FF5A1F" }
            ]
        });
        if let (Some(base), Some(more)) = (args.as_object_mut(), extra.as_object()) {
            for (k, v) in more {
                base.insert(k.clone(), v.clone());
            }
        }
        args.to_string()
    }

    fn wav(seconds: u32) -> Vec<u8> {
        let rate: u32 = 24_000 * 2;
        let data = vec![0u8; (rate * seconds) as usize];
        let mut out = b"RIFF".to_vec();
        out.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&24_000u32.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&2u16.to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&data);
        out
    }

    fn realm() -> (tempfile::TempDir, std::path::PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let realm = tmp.path().join("realm");
        std::fs::create_dir(&realm).unwrap();
        (tmp, realm)
    }

    fn image(from: &str) -> Result<Vec<u8>, String> {
        if from == "/app/images/a.png" {
            Ok(PNG.to_vec())
        } else {
            Err("only images generated by this app can be used".to_string())
        }
    }

    fn go(
        realm: &std::path::Path,
        plan: Plan,
        spoken: &std::sync::Mutex<Vec<String>>,
    ) -> Result<(String, serde_json::Value), Rejection> {
        let speak = |text: String, voice: String| {
            spoken.lock().unwrap().push(format!("{voice}:{text}"));
            async { Ok(wav(7)) }
        };
        tauri::async_runtime::block_on(run(realm, plan, speak, image))
    }

    #[test]
    fn create_writes_a_complete_project_and_reports_it() {
        let (_tmp, realm) = realm();
        let spoken = std::sync::Mutex::new(Vec::new());
        let plan = parse_create(&create_args(serde_json::json!({
            "voiceover": { "text": "Hola a todos", "voice": "em_alex" },
            "images": [{ "from": "/app/images/a.png", "name": "hero.png" }]
        })))
        .unwrap();
        let (id, result) = go(&realm, plan, &spoken).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["title"], "Promo de verano");
        assert_eq!(result["aspect"], "9:16");
        assert_eq!(result["duration_s"], 5.5);
        assert_eq!(result["voiceover_s"], 7.0);
        assert!(
            result["warnings"][0]
                .as_str()
                .unwrap()
                .contains("voice-over lasts 7")
        );
        assert_eq!(spoken.lock().unwrap().as_slice(), ["em_alex:Hola a todos"]);
        let dir = library::project_dir(&realm, &id).unwrap();
        let meta = library::read_meta(&dir).unwrap();
        assert_eq!(meta.variables[1].value, "#ff5a1f", "colors normalized");
        assert_eq!(meta.scenes[1].title, "");
        assert!(library::list_assets(&dir).contains_key("assets/hero.png"));
        assert!(library::list_assets(&dir).contains_key("assets/voiceover.wav"));
        let index = library::read_text(&dir, "index.html", 1 << 20)
            .unwrap()
            .unwrap();
        assert!(index.contains("data-width=\"1080\" data-height=\"1920\""));
        assert!(index.contains("<audio id=\"voiceover\""));
    }

    #[test]
    fn a_failed_create_leaves_no_project_behind() {
        let (_tmp, realm) = realm();
        let spoken = std::sync::Mutex::new(Vec::new());
        let plan = parse_create(&create_args(serde_json::json!({
            "images": [{ "from": "/Users/x/.ssh/id_rsa.png", "name": "hero.png" }]
        })))
        .unwrap();
        let err = go(&realm, plan, &spoken).unwrap_err();
        assert!(err.message.contains("generated by this app"));
        assert!(library::list_projects(&realm).is_empty());
        // An image variable pointing at a file that does not exist.
        let plan = parse_create(&create_args(serde_json::json!({
            "variables": [{ "id": "logo", "type": "image", "value": "assets/nope.png" }]
        })))
        .unwrap();
        assert!(go(&realm, plan, &spoken).is_err());
        assert!(library::list_projects(&realm).is_empty());
        assert!(
            !library::library_dir(&realm)
                .read_dir()
                .unwrap()
                .any(|_| true)
        );
    }

    #[test]
    fn edit_reads_reorders_retimes_and_sets_values() {
        let (_tmp, realm) = realm();
        let spoken = std::sync::Mutex::new(Vec::new());
        let (id, _) = go(
            &realm,
            parse_create(&create_args(serde_json::json!({}))).unwrap(),
            &spoken,
        )
        .unwrap();
        // Read.
        let read = parse_edit(&serde_json::json!({ "project_id": id }).to_string()).unwrap();
        assert!(read.read_only);
        let (_, current) = go(&realm, read, &spoken).unwrap();
        assert_eq!(current["scenes"][0]["id"], "intro");
        assert!(
            current["scenes"][0]["html"]
                .as_str()
                .unwrap()
                .contains("intro-template")
        );
        assert_eq!(current["variables"][0]["id"], "headline");
        // Edit.
        let edit = parse_edit(&serde_json::json!({
            "project_id": id,
            "scenes": [{ "id": "outro", "duration": 4 }, { "id": "middle", "duration": 2, "html": scene_html("middle") }],
            "order": ["middle", "intro", "outro"],
            "values": { "headline": "Adiós" }
        }).to_string()).unwrap();
        let (_, result) = go(&realm, edit, &spoken).unwrap();
        assert_eq!(result["duration_s"], 9.0);
        assert_eq!(result["scenes"][0]["id"], "middle");
        assert_eq!(result["scenes"][2]["start"], 5.0);
        let dir = library::project_dir(&realm, &id).unwrap();
        assert_eq!(
            library::read_meta(&dir).unwrap().variables[0].value,
            "Adiós"
        );
        // Bad edits are refused with a reason and change nothing.
        for bad in [
            serde_json::json!({ "project_id": id, "order": ["intro"] }),
            serde_json::json!({ "project_id": id, "values": { "nope": "x" } }),
            serde_json::json!({ "project_id": id, "remove_scenes": ["nope"] }),
            serde_json::json!({ "project_id": id, "scenes": [{ "id": "new" , "html": scene_html("new") }] }),
            serde_json::json!({ "project_id": id, "values": { "accent": "red" } }),
        ] {
            let plan = parse_edit(&bad.to_string()).unwrap();
            assert!(go(&realm, plan, &spoken).is_err(), "{bad}");
        }
        assert_eq!(library::read_meta(&dir).unwrap().duration(), 9.0);
    }

    #[test]
    fn arguments_are_validated_before_any_work() {
        for bad in [
            serde_json::json!({ "title": "x", "aspect": "4:3", "scenes": [] }),
            serde_json::json!({ "title": " ", "aspect": "16:9", "scenes": [] }),
            serde_json::json!({ "title": "x", "aspect": "16:9", "scenes": [] }),
            serde_json::json!({ "title": "x", "aspect": "16:9", "scenes": [{ "id": "a", "duration": 2 }] }),
            serde_json::json!({ "title": "x", "aspect": "16:9", "scenes": [{ "id": "Bad", "duration": 2, "html": "x" }] }),
            serde_json::json!({ "title": "x", "aspect": "16:9", "scenes": [{ "id": "a", "duration": 2, "html": "<template><div data-composition-id=\"a\"><script>gsap.to()</script></div></template>" }] }),
            serde_json::json!({ "title": "x", "aspect": "16:9", "evil": 1, "scenes": [] }),
        ] {
            assert!(parse_create(&bad.to_string()).is_err(), "{bad}");
        }
        let voice =
            create_args(serde_json::json!({ "voiceover": { "text": "hola", "voice": "robot" } }));
        assert!(parse_create(&voice).unwrap_err().contains("ef_dora"));
        let long = create_args(
            serde_json::json!({ "voiceover": { "text": "a".repeat(MAX_VOICE_CHARS + 1) } }),
        );
        assert!(parse_create(&long).is_err());
        let image = create_args(
            serde_json::json!({ "images": [{ "from": "/x.png", "name": "../evil.png" }] }),
        );
        assert!(parse_create(&image).is_err());
        assert!(parse_edit(&serde_json::json!({ "project_id": "../../x" }).to_string()).is_err());
    }

    #[test]
    fn motion_problems_come_back_as_warnings_not_errors() {
        let (_tmp, realm) = realm();
        let spoken = std::sync::Mutex::new(Vec::new());
        // One in-flow .clip per line (the tester's video): written, but the
        // model is told why it will jump.
        let jumpy = "<template id=\"a-template\"><style>#root{position:absolute;inset:0;display:flex;flex-direction:column}\
            .a-line{animation:a-in .6s ease-out both}@keyframes a-in{from{opacity:0}to{opacity:1}}</style>\
            <div id=\"root\" data-composition-id=\"a\" data-width=\"1920\" data-height=\"1080\">\
            <div class=\"clip\" data-start=\"0\" data-duration=\"3\"><p class=\"a-line\">one</p></div>\
            <div class=\"clip\" data-start=\"1\" data-duration=\"2\"><p class=\"a-line\">two</p></div>\
            </div></template>";
        let args = serde_json::json!({
            "title": "x", "aspect": "16:9",
            "scenes": [
                { "id": "a", "duration": 3, "html": jumpy },
                { "id": "b", "duration": 2, "html": scene_html("b") }
            ]
        });
        let (id, result) = go(&realm, parse_create(&args.to_string()).unwrap(), &spoken).unwrap();
        assert_eq!(result["ok"], true);
        let warnings = result["warnings"].as_array().unwrap();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].as_str().unwrap().starts_with("scene \"a\":"));
        assert!(warnings[0].as_str().unwrap().contains("jump"));
        // Retiming a scene re-checks it from disk: the entrance of .a-line
        // in the clip at 1 s now outlasts a 1.2 s scene.
        let edit =
            serde_json::json!({ "project_id": id, "scenes": [{ "id": "a", "duration": 1.2 }] });
        let (_, result) = go(&realm, parse_edit(&edit.to_string()).unwrap(), &spoken).unwrap();
        let text = result["warnings"].to_string();
        assert!(text.contains("lasts 1.2 s"), "{text}");
        // Untouched scenes are not reported again.
        let edit = serde_json::json!({ "project_id": id, "title": "y" });
        let (_, result) = go(&realm, parse_edit(&edit.to_string()).unwrap(), &spoken).unwrap();
        assert_eq!(result["warnings"], serde_json::json!([]));
    }

    #[test]
    fn wav_length_comes_from_the_header() {
        assert_eq!(wav_seconds(&wav(3)), Some(3.0));
        assert_eq!(wav_seconds(b"RIFF"), None);
        assert_eq!(wav_seconds(PNG), None);
    }

    #[test]
    fn the_definitions_and_guidance_encode_the_authoring_rules() {
        let defs = tool_definitions();
        assert_eq!(defs[0]["function"]["name"], CREATE);
        assert_eq!(defs[1]["function"]["name"], EDIT);
        assert_eq!(
            defs[0]["function"]["parameters"]["required"],
            serde_json::json!(["title", "aspect", "scenes"])
        );
        for needle in [
            "create_video",
            "edit_video",
            "<template id=",
            "data-composition-id",
            "ONE stage",
            "class=\"clip <scene>-stage\"",
            "data-start",
            "takes NO space",
            "Never wrap the lines of a layout in their own .clip",
            "animation-delay",
            "CSS @keyframes",
            "never on the .clip itself",
            "animation-fill-mode: both",
            "Animate only transform and opacity",
            "never width, height, margin",
            "before the scene ends",
            "warnings",
            "Never use GSAP",
            "Math.random",
            "assets/",
            "data-var-text",
            "var(--id)",
            "voiceover",
            "generate_image",
            "ok:false",
            "our servers",
            "ALL THREE formats",
            "vmin",
            "pixel positions",
        ] {
            assert!(GUIDANCE.contains(needle), "{needle}");
        }
    }
}
