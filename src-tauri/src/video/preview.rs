//! The sandboxed video preview (R-V1): ONE self-contained document the
//! player loads from the `nan-site` scheme, under the exact isolation the
//! website preview has (`crate::site_preview`: opaque origin, no Tauri
//! bridge, the no-network `SITE_CSP` as a response header).
//!
//! How a multi-file project becomes one document, without loosening the
//! policy:
//! - `index.html` is regenerated from `video.json` (the same function the
//!   writes use), so what is previewed is exactly what will be rendered;
//! - the HyperFrames runtime (vendored, pinned) is inlined as the first
//!   script of `<head>`: the player cannot inject it from its CDN (no
//!   network) nor reach into the opaque frame, and the runtime's own
//!   detection skips any second copy;
//! - every scene file is appended as its inline `<template id="<scene>-template">`:
//!   the runtime mounts an inline template instead of fetching
//!   `data-composition-src` (a fetch `connect-src 'none'` would block);
//! - every `assets/...` reference (attributes, CSS `url()`, variable values)
//!   becomes a `data:` URI of the file's bytes, the only kind of source the
//!   policy allows.
//!
//! Scenes are re-validated on the way in (defence in depth: the library is
//! on disk and could have been edited outside the app).

use std::collections::BTreeMap;

use base64::Engine as _;

use super::library;
use super::project::{self, VideoMeta};
use crate::tools::Rejection;

/// The HyperFrames browser runtime, `@hyperframes/core@0.9.86`
/// (`src-tauri/vendor/hyperframes/NOTICE.md`).
pub const RUNTIME: &str = include_str!("../../vendor/hyperframes/hyperframe.runtime.iife.js");

/// SHA-256 of [`RUNTIME`] (the published file; `NOTICE.md` and
/// `src/video/runtimePin.test.ts` pin the same value).
#[cfg(test)]
pub const RUNTIME_SHA256: &str = "33d00f387cea4763f02c8339022daa3f27004ca8c36ad6b01e8f1afca67d8a2c";

/// Largest assembled preview document (assets grow by a third as base64).
pub const MAX_PREVIEW_BYTES: usize = 160 * 1024 * 1024;

/// What the renderer needs next to the URL to lay the player out.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PreviewInfo {
    pub url: String,
    pub title: String,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub duration: f64,
    pub aspect: String,
}

/// The parts of a project (from disk or from a bundled template).
pub struct Parts<'a> {
    pub meta: &'a VideoMeta,
    pub theme: &'a str,
    /// Scene html by id.
    pub scenes: &'a BTreeMap<String, String>,
    /// Asset bytes by `assets/...` path.
    pub asset: &'a dyn Fn(&str) -> Option<Vec<u8>>,
}

/// Assemble the self-contained preview document.
pub fn assemble(parts: &Parts) -> Result<String, Rejection> {
    let mut templates = String::new();
    for scene in &parts.meta.scenes {
        let html = parts.scenes.get(&scene.id).ok_or_else(|| {
            Rejection::new("invalid", format!("scene \"{}\" is missing", scene.id))
        })?;
        let html = project::validate_scene(&scene.id, html)
            .map_err(|message| Rejection::new("invalid", message))?;
        templates.push_str(&html);
        templates.push('\n');
    }
    let theme = project::validate_theme(parts.theme).map_err(|m| Rejection::new("invalid", m))?;
    let index = project::generate_index(parts.meta, &theme);
    let body_end = index
        .rfind("</body>")
        .ok_or_else(|| Rejection::new("io", "unexpected index layout"))?;
    let mut doc = String::with_capacity(index.len() + templates.len());
    doc.push_str(&index[..body_end]);
    doc.push_str(&templates);
    doc.push_str(&index[body_end..]);
    // Assets first, so the runtime's own text is never rewritten.
    let doc = inline_assets(&doc, parts.asset)?;
    const CHARSET: &str = "<meta charset=\"utf-8\">\n";
    let head = doc
        .find(CHARSET)
        .map(|at| at + CHARSET.len())
        .ok_or_else(|| Rejection::new("io", "unexpected index layout"))?;
    let runtime = format!("<script id=\"hf-runtime\">{RUNTIME}</script>\n");
    if doc.len() + runtime.len() > MAX_PREVIEW_BYTES {
        return Err(too_large());
    }
    Ok(format!("{}{runtime}{}", &doc[..head], &doc[head..]))
}

/// Bytes that may continue an asset path.
fn path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/')
}

/// Replace every reference to an existing project asset (`assets/...`,
/// optionally written `./assets/...`) by a `data:` URI of its bytes.
/// References to files that do not exist stay as they are (the policy
/// blocks them: they show nothing). Each file is encoded once.
pub fn inline_assets(
    doc: &str,
    asset: &dyn Fn(&str) -> Option<Vec<u8>>,
) -> Result<String, Rejection> {
    let bytes = doc.as_bytes();
    let mut cache: BTreeMap<String, Option<String>> = BTreeMap::new();
    let mut out = String::with_capacity(doc.len());
    let mut copied = 0;
    let mut i = 0;
    while let Some(found) = doc[i..].find("assets/") {
        let at = i + found;
        // The reference starts here, or at a `./` right before it.
        let start = if at >= 2 && &doc[at - 2..at] == "./" {
            at - 2
        } else {
            at
        };
        let boundary = start == 0 || !path_byte(bytes[start - 1]);
        let mut end = at + "assets/".len();
        while end < bytes.len() && path_byte(bytes[end]) {
            end += 1;
        }
        let rel = &doc[at..end];
        if boundary && project::valid_asset_path(rel) {
            let uri = cache
                .entry(rel.to_string())
                .or_insert_with(|| {
                    let (mime, _) = project::asset_type(rel)?;
                    let data = asset(rel)?;
                    Some(format!(
                        "data:{mime};base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(data)
                    ))
                })
                .clone();
            if let Some(uri) = uri {
                out.push_str(&doc[copied..start]);
                out.push_str(&uri);
                copied = end;
                if out.len() > MAX_PREVIEW_BYTES {
                    return Err(too_large());
                }
            }
        }
        i = end;
    }
    out.push_str(&doc[copied..]);
    if out.len() > MAX_PREVIEW_BYTES {
        return Err(too_large());
    }
    Ok(out)
}

fn too_large() -> Rejection {
    Rejection::new(
        "too_large",
        "this video is too large to preview (more than about 120 MB of files)",
    )
}

/// Assemble a project from its folder.
pub fn assemble_project(dir: &std::path::Path) -> Result<(VideoMeta, String), Rejection> {
    let meta = library::read_meta(dir)?;
    let theme =
        library::read_text(dir, "theme.css", project::MAX_THEME_BYTES as u64)?.unwrap_or_default();
    let mut scenes = BTreeMap::new();
    for scene in &meta.scenes {
        let html = library::read_text(
            dir,
            &format!("compositions/{}.html", scene.id),
            project::MAX_SCENE_BYTES as u64,
        )?
        .ok_or_else(|| Rejection::new("invalid", format!("scene \"{}\" is missing", scene.id)))?;
        scenes.insert(scene.id.clone(), html);
    }
    let asset = |rel: &str| {
        library::read_file(dir, rel, library::MAX_ASSET_BYTES)
            .ok()
            .flatten()
    };
    let doc = assemble(&Parts {
        meta: &meta,
        theme: &theme,
        scenes: &scenes,
        asset: &asset,
    })?;
    Ok((meta, doc))
}

pub fn info(meta: &VideoMeta, url: String) -> PreviewInfo {
    let (width, height) = meta.aspect.size();
    PreviewInfo {
        url,
        title: meta.title.clone(),
        width,
        height,
        fps: meta.fps,
        duration: meta.duration(),
        aspect: meta.aspect.label().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::library::tests::{PNG, fresh_project, sample_meta, scene_html};
    use crate::video::library::{Change, apply, read_meta};
    use crate::video::project::{Variable, VariableKind};

    #[test]
    fn the_runtime_is_the_pinned_build_and_safe_to_inline() {
        assert!(RUNTIME.len() > 500_000);
        assert!(
            !RUNTIME.contains("</script"),
            "would end the inline script early"
        );
        use sha2::Digest as _;
        let digest = sha2::Sha256::digest(RUNTIME.as_bytes());
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, RUNTIME_SHA256);
        assert_eq!(project::HYPERFRAMES_VERSION, "0.9.86");
    }

    #[test]
    fn a_project_becomes_one_self_contained_document() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        let mut meta = read_meta(&dir).unwrap();
        meta.variables.push(Variable {
            id: "logo".into(),
            kind: VariableKind::Image,
            label: "Logo".into(),
            value: "assets/logo.png".into(),
        });
        let intro = scene_html("intro").replace(
            "</h1>",
            "</h1><img id=\"intro-logo\" src=\"./assets/logo.png\" data-var-src=\"logo\" alt=\"\"><div style=\"background:url(assets/logo.png)\"></div>",
        );
        apply(
            &dir,
            Change {
                meta: Some(meta),
                scenes: vec![("intro".into(), intro)],
                assets: vec![("assets/logo.png".into(), PNG.to_vec())],
                ..Change::default()
            },
        )
        .unwrap();
        let (meta, doc) = assemble_project(&dir).unwrap();
        assert_eq!(meta.duration(), 5.0);
        // Runtime first in <head>, before any scene script.
        let runtime_at = doc.find("<script id=\"hf-runtime\">").expect("runtime");
        assert!(runtime_at < doc.find("</head>").unwrap());
        // Each scene as its inline template, inside the body.
        for id in ["intro", "outro"] {
            let at = doc
                .find(&format!("<template id=\"{id}-template\">"))
                .expect("template");
            assert!(at > doc.find("<body>").unwrap() && at < doc.find("</body>").unwrap());
        }
        // Every reference to the asset is a data: URI now: src, CSS, the
        // variable declaration and the per-scene values.
        assert!(!doc.contains("assets/logo.png"), "no file reference left");
        let png = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(PNG)
        );
        assert!(
            doc.matches(&png).count() >= 4,
            "{}",
            doc.matches(&png).count()
        );
        assert!(!doc.contains("./data:"));
    }

    #[test]
    fn inlining_respects_path_boundaries_and_missing_files() {
        let asset = |rel: &str| (rel == "assets/a.png").then(|| PNG.to_vec());
        let doc = "<img src=\"assets/a.png\"><img src=\"assets/a.pngx\"><img src=\"myassets/a.png\">\
                   <img src=\"assets/missing.png\"><p>assets/a.png</p>";
        let out = inline_assets(doc, &asset).unwrap();
        assert_eq!(out.matches("data:image/png;base64,").count(), 2);
        assert!(out.contains("assets/a.pngx"));
        assert!(out.contains("myassets/a.png"));
        assert!(out.contains("assets/missing.png"));
    }

    #[test]
    fn a_tampered_scene_on_disk_is_refused_at_preview_time() {
        let (_tmp, _realm, _id, dir) = fresh_project();
        std::fs::write(
            dir.join("compositions/intro.html"),
            "<template><div data-composition-id=\"intro\"><script src=\"https://x.io/a.js\"></script></div></template>",
        )
        .unwrap();
        assert_eq!(assemble_project(&dir).unwrap_err().kind, "invalid");
    }

    #[test]
    fn info_reports_the_canvas() {
        let info = info(&sample_meta(), "nan-site://localhost/x".into());
        assert_eq!((info.width, info.height, info.fps), (1920, 1080, 30));
        assert_eq!(info.duration, 5.0);
        assert_eq!(info.aspect, "16:9");
    }
}
