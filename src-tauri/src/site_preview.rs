//! R20-D sandboxed website preview: how a website `write_website` built is
//! shown with its styles, images and scripts, isolated from the app.
//!
//! Why a custom scheme and not `srcdoc` / `blob:` / `data:`: those frames
//! inherit the APP's Content-Security-Policy (`script-src 'self'`), so the
//! site's inline scripts would never run in a release build (they would in
//! dev, whose CSP allows inline scripts: a trap). A document served from
//! its own scheme gets its own policy instead, and the core sets it.
//!
//! The flow:
//! 1. `preview_read_file` reads a file. Only when the core's gating marker
//!    says it is a website `write_website` wrote this session
//!    ([`crate::tools::ToolsState::is_tool_website`]: `website-*.html`,
//!    inside the session temp folders, byte-for-byte what the tool
//!    validated) does it [`SiteRegistry::register`] those exact bytes under
//!    a random token and reply `selfContainedWebsite: true` + `siteUrl`.
//!    The renderer cannot ask for this mode; it only receives it.
//! 2. The renderer shows `siteUrl` in `<iframe sandbox="allow-scripts">`
//!    (no `allow-same-origin`: an opaque origin, so the site's scripts
//!    reach neither the app DOM, nor storage, nor cookies, nor the Tauri
//!    bridge).
//! 3. [`respond`] serves the registered bytes for `nan-site://localhost/<token>`
//!    (`http://nan-site.localhost/<token>` on Windows) with [`SITE_CSP`] as a
//!    response HEADER (the document cannot loosen it) plus a CSP `sandbox`
//!    directive, and the same policy as a `<meta>` when the document has none
//!    ([`with_csp_meta`]). No network: `connect-src 'none'`, `default-src
//!    'none'`, only inline code and `data:` assets.
//!
//! The handler never touches the disk: it only serves bytes the preview
//! command already read through every grant check. Nothing here logs.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tauri::http;

/// The custom URI scheme the sandboxed site preview is served from.
pub const SCHEME: &str = "nan-site";

/// The policy every previewed site runs under: nothing loads from
/// anywhere, inline code and `data:` assets only.
pub const SITE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline' data:; \
style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; \
connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// How many sites the registry keeps (the preview shows one at a time; a
/// few let the pane go back and forth without a re-read). Each is at most
/// the 8 MiB preview cap.
pub const MAX_SITES: usize = 4;

/// Bytes registered for the sandboxed preview, by random token.
#[derive(Default)]
pub struct SiteRegistry {
    sites: Mutex<VecDeque<(String, Arc<Vec<u8>>)>>,
}

impl SiteRegistry {
    /// Register a site's (already gated) bytes; returns its fresh token.
    /// The oldest site is forgotten past [`MAX_SITES`].
    pub fn register(&self, bytes: Vec<u8>) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut sites) = self.sites.lock() {
            sites.push_back((token.clone(), Arc::new(bytes)));
            while sites.len() > MAX_SITES {
                sites.pop_front();
            }
        }
        token
    }

    fn get(&self, token: &str) -> Option<Arc<Vec<u8>>> {
        let sites = self.sites.lock().ok()?;
        sites
            .iter()
            .find(|(known, _)| known == token)
            .map(|(_, bytes)| bytes.clone())
    }

    /// Forget every site (a realm switch).
    pub fn clear(&self) {
        if let Ok(mut sites) = self.sites.lock() {
            sites.clear();
        }
    }
}

/// The URL the renderer loads a registered site from. Windows WebView2
/// serves custom schemes as `http://<scheme>.localhost`.
pub fn site_url(token: &str) -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost/{token}")
    } else {
        format!("{SCHEME}://localhost/{token}")
    }
}

/// Whether the document already declares a CSP `<meta>`.
fn has_csp_meta(html: &str) -> bool {
    let lower = html.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(at) = rest.find("<meta") {
        let tag = &rest[at..];
        let end = tag.find('>').unwrap_or(tag.len());
        let tag = &tag[..end];
        if tag.contains("http-equiv") && tag.contains("content-security-policy") {
            return true;
        }
        rest = &rest[at + 5..];
    }
    false
}

/// End (byte index just past `>`) of the first `<name ...>` opening tag
/// (case-insensitive, `name` followed by whitespace, `/` or `>`).
fn after_open_tag(html: &str, name: &str) -> Option<usize> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("<{name}");
    let mut from = 0;
    while let Some(found) = lower[from..].find(&needle) {
        let start = from + found;
        let next = lower[start + needle.len()..].chars().next();
        if matches!(next, Some(c) if c == '>' || c == '/' || c.is_ascii_whitespace()) {
            return lower[start..].find('>').map(|end| start + end + 1);
        }
        from = start + needle.len();
    }
    None
}

/// The document with [`SITE_CSP`] as a `<meta http-equiv>` at the very top
/// of its head, ONLY when it declares none of its own (the response header
/// enforces [`SITE_CSP`] regardless, and policies only ever tighten). The
/// meta goes right after `<head>`, else after `<html>`, else after the
/// doctype (the parser opens an implicit head there), else first.
pub fn with_csp_meta(html: &str) -> String {
    if has_csp_meta(html) {
        return html.to_string();
    }
    let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{SITE_CSP}\">");
    let at = after_open_tag(html, "head")
        .or_else(|| after_open_tag(html, "html"))
        .or_else(|| after_open_tag(html, "!doctype"))
        .unwrap_or(0);
    let mut out = String::with_capacity(html.len() + meta.len());
    out.push_str(&html[..at]);
    out.push_str(&meta);
    out.push_str(&html[at..]);
    out
}

/// The protocol handler's reply for a request `path` (`/<token>`). Only
/// `GET` of a registered token is served; everything else is a 404 with no
/// body. A site that is not valid UTF-8 (never the case for a gated one)
/// is served unmodified under the same header.
pub fn respond(registry: &SiteRegistry, method: &str, path: &str) -> http::Response<Vec<u8>> {
    let not_found = || {
        http::Response::builder()
            .status(404)
            .header("Cache-Control", "no-store")
            .body(Vec::new())
            .unwrap_or_default()
    };
    if method != "GET" {
        return not_found();
    }
    let token = path.trim_start_matches('/');
    if token.is_empty() || token.contains('/') {
        return not_found();
    }
    let Some(bytes) = registry.get(token) else {
        return not_found();
    };
    let body = match std::str::from_utf8(&bytes) {
        Ok(html) => with_csp_meta(html).into_bytes(),
        Err(_) => bytes.to_vec(),
    };
    http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header(
            "Content-Security-Policy",
            format!("{SITE_CSP}; sandbox allow-scripts"),
        )
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Cache-Control", "no-store")
        .body(body)
        .unwrap_or_else(|_| not_found())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE: &str = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">\
<title>Pan</title></head><body><h1>Pan</h1><script>document.title='x'</script></body></html>";

    fn body(response: &http::Response<Vec<u8>>) -> String {
        String::from_utf8(response.body().clone()).expect("utf8")
    }

    #[test]
    fn the_policy_blocks_every_network_load_and_allows_only_inline_and_data() {
        for directive in [
            "default-src 'none'",
            "script-src 'unsafe-inline' data:",
            "style-src 'unsafe-inline' data:",
            "img-src data:",
            "connect-src 'none'",
            "frame-src 'none'",
            "form-action 'none'",
        ] {
            assert!(SITE_CSP.contains(directive), "{directive}");
        }
        assert!(!SITE_CSP.contains("http"), "no remote source anywhere");
        assert!(!SITE_CSP.contains('*'));
    }

    #[test]
    fn injects_the_meta_at_the_top_of_the_head_when_the_document_has_none() {
        let out = with_csp_meta(SITE);
        let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{SITE_CSP}\">");
        assert!(out.starts_with(&format!(
            "<!doctype html><html lang=\"es\"><head>{meta}<meta charset"
        )));
        // Before any script, so it governs all of them.
        assert!(out.find(&meta).expect("meta") < out.find("<script").expect("script"));
        assert_eq!(out.replace(&meta, ""), SITE, "nothing else changes");
    }

    #[test]
    fn places_the_meta_where_the_parser_opens_the_head_without_a_head_tag() {
        let meta = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{SITE_CSP}\">");
        assert_eq!(
            with_csp_meta("<HTML><body>hi</body></HTML>"),
            format!("<HTML>{meta}<body>hi</body></HTML>")
        );
        assert_eq!(
            with_csp_meta("<!DOCTYPE html><p>hi"),
            format!("<!DOCTYPE html>{meta}<p>hi")
        );
        assert_eq!(with_csp_meta("<p>hi</p>"), format!("{meta}<p>hi</p>"));
        // <header> is not <head>; <html> follows the doctype.
        assert_eq!(
            with_csp_meta("<!doctype html><html><body><header>x</header>"),
            format!("<!doctype html><html>{meta}<body><header>x</header>")
        );
    }

    #[test]
    fn keeps_the_documents_own_policy_untouched() {
        let own = "<html><head><META HTTP-EQUIV='Content-Security-Policy' content=\"default-src 'none'\"></head></html>";
        assert_eq!(with_csp_meta(own), own);
    }

    #[test]
    fn serves_a_registered_site_with_the_policy_as_a_header_and_a_sandbox() {
        let registry = SiteRegistry::default();
        let token = registry.register(SITE.as_bytes().to_vec());
        let response = respond(&registry, "GET", &format!("/{token}"));
        assert_eq!(response.status(), 200);
        let headers = response.headers();
        assert_eq!(headers["Content-Type"], "text/html; charset=utf-8");
        let csp = headers["Content-Security-Policy"].to_str().expect("csp");
        assert!(csp.starts_with(SITE_CSP));
        assert!(
            csp.ends_with("; sandbox allow-scripts"),
            "opaque origin even top level"
        );
        assert!(!csp.contains("allow-same-origin"));
        assert_eq!(headers["X-Content-Type-Options"], "nosniff");
        assert_eq!(headers["Cache-Control"], "no-store");
        assert_eq!(body(&response), with_csp_meta(SITE));
    }

    #[test]
    fn a_site_with_its_own_meta_policy_still_gets_the_header_policy() {
        let registry = SiteRegistry::default();
        let own =
            "<head><meta http-equiv=\"content-security-policy\" content=\"connect-src *\"></head>";
        let token = registry.register(own.as_bytes().to_vec());
        let response = respond(&registry, "GET", &format!("/{token}"));
        assert_eq!(body(&response), own, "meta untouched");
        let csp = response.headers()["Content-Security-Policy"]
            .to_str()
            .expect("csp");
        assert!(
            csp.contains("connect-src 'none'"),
            "the header still forbids the network"
        );
    }

    #[test]
    fn unknown_tokens_other_methods_and_odd_paths_are_404_without_a_body() {
        let registry = SiteRegistry::default();
        let token = registry.register(SITE.as_bytes().to_vec());
        for (method, path) in [
            ("GET", "/".to_string()),
            ("GET", "/nope".to_string()),
            ("GET", format!("/{token}/x")),
            ("GET", format!("/../{token}")),
            ("POST", format!("/{token}")),
        ] {
            let response = respond(&registry, method, &path);
            assert_eq!(response.status(), 404, "{method} {path}");
            assert!(response.body().is_empty());
        }
    }

    #[test]
    fn tokens_are_random_and_the_registry_keeps_only_the_latest_sites() {
        let registry = SiteRegistry::default();
        let first = registry.register(b"<p>1</p>".to_vec());
        let tokens: Vec<String> = (0..MAX_SITES)
            .map(|i| registry.register(format!("<p>{i}</p>").into_bytes()))
            .collect();
        assert_ne!(first, tokens[0]);
        assert_eq!(first.len(), 32);
        assert_eq!(
            respond(&registry, "GET", &format!("/{first}")).status(),
            404,
            "evicted"
        );
        for token in &tokens {
            assert_eq!(
                respond(&registry, "GET", &format!("/{token}")).status(),
                200
            );
        }
        registry.clear();
        assert_eq!(
            respond(&registry, "GET", &format!("/{}", tokens[0])).status(),
            404
        );
    }

    #[test]
    fn the_url_names_only_the_scheme_and_the_token() {
        let url = site_url("abc");
        if cfg!(windows) {
            assert_eq!(url, "http://nan-site.localhost/abc");
        } else {
            assert_eq!(url, "nan-site://localhost/abc");
        }
    }
}
