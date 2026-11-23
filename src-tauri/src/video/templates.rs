//! The template gallery (R-V1): original, brand-free example videos the
//! user starts from. They ship inside the binary (`build.rs` embeds
//! `src-tauri/video-templates/`), so the gallery works offline and nothing
//! is downloaded.
//!
//! A template folder:
//!
//! ```text
//! <id>/template.json          titles, descriptions, scenes, variables
//!                             (labels and default texts in es + en),
//!                             fonts it uses, attribution
//! <id>/theme.css              shared CSS (@font-face for its fonts)
//! <id>/compositions/*.html    the scenes (same rules as any project)
//! <id>/assets/*               small assets (placeholder logo, ...)
//! _fonts/*.woff2              the shared OFL font set (+ licenses)
//! ```
//!
//! "Use this template" materializes it (in the user's language and the
//! chosen aspect) and writes it as a new project through the same
//! validate-then-write path as everything else.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::project::{self, Aspect, AudioTrack, Scene, Variable, VariableKind, VideoMeta};
use crate::tools::Rejection;

mod embedded {
    include!(concat!(env!("OUT_DIR"), "/video_templates.rs"));
}

fn file(rel: &str) -> Option<&'static [u8]> {
    embedded::FILES
        .binary_search_by(|(path, _)| (*path).cmp(rel))
        .ok()
        .map(|at| embedded::FILES[at].1)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Localized {
    es: String,
    en: String,
}

impl Localized {
    fn get(&self, locale: &str) -> &str {
        if locale == "en" { &self.en } else { &self.es }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateScene {
    id: String,
    title: Localized,
    duration: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateVariable {
    id: String,
    #[serde(rename = "type")]
    kind: VariableKind,
    label: Localized,
    value: Localized,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateMusic {
    file: String,
    volume: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct TemplateDef {
    id: String,
    title: Localized,
    description: Localized,
    category: String,
    aspect: Aspect,
    #[serde(default = "default_fps")]
    fps: u32,
    #[serde(default)]
    fonts: Vec<String>,
    scenes: Vec<TemplateScene>,
    #[serde(default)]
    variables: Vec<TemplateVariable>,
    #[serde(default)]
    music: Option<TemplateMusic>,
    /// Credit kept for templates derived from upstream examples.
    #[serde(default)]
    attribution: Option<String>,
}

fn default_fps() -> u32 {
    30
}

/// A gallery card.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TemplateSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    pub category: String,
    pub aspect: String,
    pub duration: f64,
    pub scenes: usize,
    pub attribution: Option<String>,
}

/// A template made concrete for one aspect and language.
pub struct Materialized {
    pub meta: VideoMeta,
    pub theme: String,
    pub scenes: BTreeMap<String, String>,
    /// `(assets/... path, bytes)`.
    pub assets: Vec<(String, Vec<u8>)>,
}

/// The template ids, in folder order.
fn ids() -> Vec<&'static str> {
    let mut out: Vec<&'static str> = embedded::FILES
        .iter()
        .filter_map(|(path, _)| path.strip_suffix("/template.json"))
        .filter(|id| !id.contains('/'))
        .collect();
    out.dedup();
    out
}

fn definition(id: &str) -> Result<TemplateDef, Rejection> {
    if !project::valid_id(id) {
        return Err(Rejection::new("not_found", "unknown template"));
    }
    let bytes = file(&format!("{id}/template.json"))
        .ok_or_else(|| Rejection::new("not_found", "unknown template"))?;
    let def: TemplateDef = serde_json::from_slice(bytes)
        .map_err(|err| Rejection::new("io", format!("template {id} is broken: {err}")))?;
    if def.id != id {
        return Err(Rejection::new(
            "io",
            format!("template {id} names another id"),
        ));
    }
    Ok(def)
}

/// The gallery, in the user's language. Broken templates are skipped (the
/// tests make sure none is).
pub fn list(locale: &str) -> Vec<TemplateSummary> {
    ids()
        .into_iter()
        .filter_map(|id| definition(id).ok())
        .map(|def| TemplateSummary {
            id: def.id.clone(),
            title: def.title.get(locale).to_string(),
            description: def.description.get(locale).to_string(),
            category: def.category.clone(),
            aspect: def.aspect.label().to_string(),
            duration: project::round_ms(def.scenes.iter().map(|s| s.duration).sum()),
            scenes: def.scenes.len(),
            attribution: def.attribution.clone(),
        })
        .collect()
}

/// A template for `aspect` (its own default when `None`) in `locale`.
pub fn materialize(
    id: &str,
    aspect: Option<Aspect>,
    locale: &str,
) -> Result<Materialized, Rejection> {
    let def = definition(id)?;
    let broken = |what: String| Rejection::new("io", format!("template {id}: {what}"));
    let mut meta = VideoMeta::new(def.title.get(locale), aspect.unwrap_or(def.aspect), def.fps);
    meta.template = Some(def.id.clone());
    meta.scenes = def
        .scenes
        .iter()
        .map(|s| Scene {
            id: s.id.clone(),
            title: s.title.get(locale).to_string(),
            duration: s.duration,
        })
        .collect();
    meta.variables = def
        .variables
        .iter()
        .map(|v| Variable {
            id: v.id.clone(),
            kind: v.kind,
            label: v.label.get(locale).to_string(),
            value: v.value.get(locale).to_string(),
        })
        .collect();
    let mut scenes = BTreeMap::new();
    for scene in &def.scenes {
        let bytes = file(&format!("{id}/compositions/{}.html", scene.id))
            .ok_or_else(|| broken(format!("scene {} is missing", scene.id)))?;
        let html = std::str::from_utf8(bytes).map_err(|_| broken("scene is not UTF-8".into()))?;
        scenes.insert(scene.id.clone(), html.to_string());
    }
    let theme = file(&format!("{id}/theme.css"))
        .map(|b| String::from_utf8_lossy(b).to_string())
        .unwrap_or_default();
    let mut assets = Vec::new();
    let prefix = format!("{id}/assets/");
    for (path, bytes) in embedded::FILES {
        if let Some(name) = path.strip_prefix(&prefix)
            && !name.contains('/')
        {
            assets.push((format!("assets/{name}"), bytes.to_vec()));
        }
    }
    for font in &def.fonts {
        let bytes = file(&format!("_fonts/{font}"))
            .ok_or_else(|| broken(format!("font {font} is missing")))?;
        assets.push((format!("assets/fonts/{font}"), bytes.to_vec()));
    }
    if let Some(music) = &def.music {
        meta.audio.music = Some(AudioTrack {
            file: music.file.clone(),
            volume: music.volume,
            duration: None,
        });
    }
    Ok(Materialized {
        meta,
        theme,
        scenes,
        assets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::library;
    use crate::video::preview;

    #[test]
    fn the_gallery_ships_the_promised_templates() {
        let listed = list("es");
        let ids: Vec<&str> = listed.iter().map(|t| t.id.as_str()).collect();
        for id in [
            "product-promo",
            "social-ad",
            "data-explainer",
            "logo-intro",
            "testimonial",
            "launch-countdown",
            "event-announcement",
            "tutorial-steps",
            "before-after",
            "year-in-review",
            "decision-tree",
            "editorial-chart",
        ] {
            assert!(ids.contains(&id), "missing template {id}: {ids:?}");
        }
        assert_eq!(
            ids.len(),
            super::ids().len(),
            "every template folder parses"
        );
        for template in &listed {
            assert!(!template.title.is_empty() && !template.description.is_empty());
            assert!(template.duration > 0.0 && template.duration <= project::MAX_DURATION_S);
        }
        assert_ne!(list("en")[0].title, String::new());
    }

    #[test]
    fn every_template_is_a_valid_project_in_every_aspect_and_language() {
        for id in ids() {
            for aspect in [Aspect::Landscape, Aspect::Portrait, Aspect::Square] {
                for locale in ["es", "en"] {
                    let m = materialize(id, Some(aspect), locale)
                        .unwrap_or_else(|e| panic!("{id}: {}", e.message));
                    let names: Vec<&str> = m.assets.iter().map(|(p, _)| p.as_str()).collect();
                    for (path, bytes) in &m.assets {
                        assert!(project::valid_asset_path(path), "{id}: {path}");
                        assert!(library::sniff_asset(path, bytes), "{id}: {path} content");
                    }
                    let has = |rel: &str| names.contains(&rel);
                    project::validate_meta(&m.meta, &has)
                        .unwrap_or_else(|e| panic!("{id} {locale}: {e}"));
                    project::validate_theme(&m.theme).unwrap_or_else(|e| panic!("{id} theme: {e}"));
                    for (scene, html) in &m.scenes {
                        project::validate_scene(scene, html)
                            .unwrap_or_else(|e| panic!("{id}/{scene}: {e}"));
                    }
                    // Fonts the theme references are shipped with it.
                    let low = m.theme.to_ascii_lowercase();
                    for (at, _) in low.match_indices("assets/fonts/") {
                        let rest = &low[at..];
                        let end = rest
                            .find(|c: char| c == ')' || c == '"' || c == '\'')
                            .unwrap_or(rest.len());
                        assert!(
                            has(&rest[..end]),
                            "{id}: theme uses {} without shipping it",
                            &rest[..end]
                        );
                    }
                    let asset = |rel: &str| {
                        m.assets
                            .iter()
                            .find(|(p, _)| p == rel)
                            .map(|(_, b)| b.clone())
                    };
                    let doc = preview::assemble(&preview::Parts {
                        meta: &m.meta,
                        theme: &m.theme,
                        scenes: &m.scenes,
                        asset: &asset,
                    })
                    .unwrap_or_else(|e| panic!("{id}: {}", e.message));
                    assert!(
                        !doc.contains("\"assets/"),
                        "{id}: an asset reference was not inlined"
                    );
                }
            }
        }
    }

    #[test]
    fn templates_stay_lean() {
        let total: usize = embedded::FILES.iter().map(|(_, b)| b.len()).sum();
        assert!(total < 2 * 1024 * 1024, "templates weigh {total} bytes");
        for (path, bytes) in embedded::FILES {
            assert!(bytes.len() < 400 * 1024, "{path} is {} bytes", bytes.len());
        }
    }

    #[test]
    fn unknown_or_hostile_ids_are_refused() {
        for id in ["", "../x", "_fonts", "nope", "Product-Promo"] {
            assert!(materialize(id, None, "es").is_err(), "{id}");
        }
    }

    /// Dev helper (template authoring): write every template's assembled
    /// preview, per aspect, to `$VIDEO_TEMPLATE_DUMP/<id>-<w>x<h>.html` to
    /// open in a browser with the player. `cargo test --lib
    /// dump_template_previews -- --ignored`.
    #[test]
    #[ignore]
    fn dump_template_previews() {
        let out = std::path::PathBuf::from(
            std::env::var("VIDEO_TEMPLATE_DUMP").expect("VIDEO_TEMPLATE_DUMP"),
        );
        std::fs::create_dir_all(&out).unwrap();
        for id in ids() {
            for aspect in [Aspect::Landscape, Aspect::Portrait, Aspect::Square] {
                let m = materialize(id, Some(aspect), "es").unwrap();
                let asset = |rel: &str| {
                    m.assets
                        .iter()
                        .find(|(p, _)| p == rel)
                        .map(|(_, b)| b.clone())
                };
                let doc = preview::assemble(&preview::Parts {
                    meta: &m.meta,
                    theme: &m.theme,
                    scenes: &m.scenes,
                    asset: &asset,
                })
                .unwrap();
                let (w, h) = aspect.size();
                std::fs::write(out.join(format!("{id}-{w}x{h}.html")), doc).unwrap();
            }
        }
    }
}
