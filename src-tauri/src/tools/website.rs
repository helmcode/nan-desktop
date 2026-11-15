//! `write_website` (R20-D): the model builds a small static website from
//! the chat as ONE self-contained HTML document.
//!
//! The model sends a title and the full HTML (inline CSS and JS; assets as
//! `data:` URIs only). Before anything is written the document is checked
//! here ([`validate_html`]): text without NUL bytes, at most
//! [`MAX_WEBSITE_BYTES`], and NOTHING fetched from the network: every
//! `src`/`href`/`srcset`/`action`/... attribute must be a fragment or a
//! `data:` URI (plus `mailto:`/`tel:` links), CSS may not `@import` or
//! `url()` anything but `data:`, and inline scripts may not mention a
//! remote URL. A site that passes works anywhere, offline, in the sandboxed
//! page a shared link serves.
//!
//! The write itself goes through the core's write rules (propose, the
//! inline approval card, execute) into the conversation's session temp
//! folder as `website-<slug>.html` (`tools::write_website_in`), and the file
//! is declared the turn's deliverable (`tools::declare_outputs`), so the
//! preview opens it and the header offers Share.

use serde::Deserialize;

/// The tool name the model calls.
pub const TOOL_NAME: &str = "write_website";

/// Largest website (the preview and share cap).
pub const MAX_WEBSITE_BYTES: usize = 8 * 1024 * 1024;

/// Longest title kept (characters).
pub const MAX_TITLE_CHARS: usize = 120;

/// Longest file-name slug (bytes, ASCII).
const MAX_SLUG: usize = 60;

/// What the model is told about building websites (appended to the system
/// prompt, like the other always-on tools' guidance).
pub const GUIDANCE: &str = "Building a website:\n\
- When the user asks for a web page, landing page, mini site or any small static \
website, call write_website once with a short title and the COMPLETE HTML document. \
The app saves it in this conversation's temporary folder (the user approves the \
write) and opens it in the preview, where they can share it as a link.\n\
- Build ONE self-contained file: all CSS inside <style>, all JavaScript inside \
<script>, every image, icon or font as a data: URI (inline SVG is fine). Nothing may \
load from the network: no external stylesheets, scripts, fonts, CDNs, analytics, \
iframes or remote images, and no links to other sites or pages (use #section anchors \
for navigation). The app refuses a document that references a remote URL.\n\
- It must work offline in a sandboxed page: no forms that submit anywhere, no \
fetch/XHR, no localStorage. Make it responsive (a viewport meta tag, flexible \
layout) and readable, in the user's language.\n\
- To change the site, call write_website again with the whole updated document and \
the same title.\n\
- After the call, tell the user in one short sentence that the site is ready in the \
preview, with the path from the tool result.";

/// The arguments the model sends.
#[derive(Debug, Deserialize)]
struct Args {
    title: String,
    html: String,
}

/// A validated website, ready to write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebsiteDraft {
    pub title: String,
    pub html: String,
}

impl WebsiteDraft {
    /// The file name it is written as: `website-<slug>.html`.
    pub fn file_name(&self) -> String {
        format!("website-{}.html", slug(&self.title))
    }
}

/// The OpenAI function definition offered on every reply.
pub fn tool_definition() -> serde_json::Value {
    serde_json::json!({ "type": "function", "function": {
        "name": TOOL_NAME,
        "description": "Build a small static website as ONE self-contained HTML file (inline CSS and JS, assets as data: URIs, nothing loaded from the network). It is saved in this conversation's temporary folder (the user approves) and opened in the preview, where it can be shared as a link.",
        "parameters": { "type": "object", "properties": {
            "title": { "type": "string", "description": "Short title of the site, in the user's language (names the file)." },
            "html": { "type": "string", "description": "The complete HTML document, from <!doctype html> to </html>, fully self-contained." }
        }, "required": ["title", "html"] }
    }})
}

/// Parse and validate a tool call.
pub fn parse_draft(arguments: &str) -> Result<WebsiteDraft, String> {
    let args: Args = serde_json::from_str(arguments)
        .map_err(|_| "write_website needs title and html".to_string())?;
    let title: String = args
        .title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect();
    if title.is_empty() {
        return Err("title is empty".into());
    }
    validate_html(&args.html)?;
    Ok(WebsiteDraft {
        title,
        html: args.html,
    })
}

/// A file-name slug: ASCII letters and digits (accents folded), words
/// joined by `-`, at most [`MAX_SLUG`] bytes; `site` when nothing is left.
pub fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in title.chars().flat_map(fold_accent) {
        if c.is_ascii_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c.to_ascii_lowercase());
            if out.len() >= MAX_SLUG {
                break;
            }
        } else {
            dash = true;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "site".into() } else { out }
}

/// Spanish (and common Latin) accents to their base letter.
fn fold_accent(c: char) -> Vec<char> {
    let base = match c {
        'á' | 'à' | 'ä' | 'â' | 'ã' | 'Á' | 'À' | 'Ä' | 'Â' | 'Ã' => 'a',
        'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' | 'Ó' | 'Ò' | 'Ö' | 'Ô' | 'Õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => 'u',
        'ñ' | 'Ñ' => 'n',
        'ç' | 'Ç' => 'c',
        other => other,
    };
    vec![base]
}

/// URL-carrying attributes: each value must stay inside the document.
const URL_ATTRIBUTES: &[&str] = &[
    "src",
    "href",
    "srcset",
    "action",
    "formaction",
    "poster",
    "data",
    "background",
    "cite",
    "xlink:href",
    "ping",
    "manifest",
    "codebase",
    "longdesc",
    "lowsrc",
    "dynsrc",
    "imagesrcset",
];

/// Remote-looking URL starts, wherever they appear in a script or CSS.
const REMOTE_MARKERS: &[&str] = &["http://", "https://", "ws://", "wss://", "ftp://"];

/// Why a document was refused, worded for the model (it may retry).
fn refused(what: &str) -> String {
    format!(
        "{what}. The website must be ONE self-contained file: inline every style, script, \
         image and font (assets as data: URIs) and use #anchors instead of links."
    )
}

/// Whether an attribute value stays inside the document.
fn local_value(name: &str, value: &str) -> bool {
    let v = value.trim().to_ascii_lowercase();
    if name == "srcset" || name == "imagesrcset" {
        // Candidates are comma-separated, and data: URIs carry commas: the
        // set must start with a data: URI and name no remote URL at all.
        return v.is_empty()
            || v.starts_with("data:") && !REMOTE_MARKERS.iter().any(|m| v.contains(m));
    }
    v.is_empty()
        || v.starts_with('#')
        || v.starts_with("data:")
        || (name == "href" && (v.starts_with("mailto:") || v.starts_with("tel:")))
}

/// ASCII-lowercase copy (byte offsets preserved, so slices line up).
fn lower(html: &str) -> String {
    html.to_ascii_lowercase()
}

/// Check a whole document: size, text, and no network reference.
pub fn validate_html(html: &str) -> Result<(), String> {
    if html.trim().is_empty() {
        return Err("html is empty".into());
    }
    if html.len() > MAX_WEBSITE_BYTES {
        return Err(format!(
            "the website is {} bytes; the limit is {MAX_WEBSITE_BYTES} (8 MiB). Use smaller images.",
            html.len()
        ));
    }
    if html.contains('\0') {
        return Err("html contains NUL bytes; it must be text".into());
    }
    let low = lower(html);
    check_attributes(html, &low)?;
    check_blocks(
        &low,
        "<script",
        "</script>",
        "an inline script references a remote URL",
    )?;
    check_blocks(
        &low,
        "<style",
        "</style>",
        "a stylesheet references a remote URL",
    )?;
    check_css(&low)?;
    if low.contains("<base") {
        return Err(refused("a <base> element is not allowed"));
    }
    Ok(())
}

/// Every `name=value` attribute inside a tag, for the URL attributes.
fn check_attributes(html: &str, low: &str) -> Result<(), String> {
    let bytes = low.as_bytes();
    let mut i = 0;
    while let Some(open) = low[i..].find('<') {
        let start = i + open;
        // Skip comments, and the bodies of scripts and styles (checked
        // separately as code).
        if low[start..].starts_with("<!--") {
            i = low[start..]
                .find("-->")
                .map_or(low.len(), |end| start + end + 3);
            continue;
        }
        let Some(close) = low[start..].find('>') else {
            break;
        };
        let end = start + close;
        let tag = &low[start + 1..end];
        let original = &html[start + 1..end];
        check_tag(tag, original)?;
        i = end + 1;
        for raw in ["script", "style"] {
            if tag.starts_with(raw)
                && bytes
                    .get(start + 1 + raw.len())
                    .is_none_or(|b| !b.is_ascii_alphanumeric())
            {
                let closing = format!("</{raw}");
                i = low[i..].find(&closing).map_or(low.len(), |at| i + at);
            }
        }
    }
    Ok(())
}

/// The attributes of one tag (`tag` lowercased, `original` as written).
fn check_tag(tag: &str, original: &str) -> Result<(), String> {
    let b = tag.as_bytes();
    // Skip the element name.
    let mut i = b
        .iter()
        .position(|c| c.is_ascii_whitespace())
        .unwrap_or(b.len());
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let name_start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        let name = &tag[name_start..i];
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i >= b.len() || b[i] != b'=' {
            continue;
        }
        i += 1;
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let (value_start, value_end) = match b.get(i) {
            Some(q @ (b'"' | b'\'')) => {
                let from = i + 1;
                let to = tag[from..].find(*q as char).map_or(b.len(), |at| from + at);
                i = (to + 1).min(b.len());
                (from, to)
            }
            _ => {
                let from = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                (from, i)
            }
        };
        let value = &original[value_start..value_end];
        if URL_ATTRIBUTES.contains(&name) && !local_value(name, &decode_entities(value)) {
            return Err(refused(&format!(
                "the {name} attribute points outside the file ({})",
                shorten(value)
            )));
        }
        if name == "http-equiv" && value.trim().eq_ignore_ascii_case("refresh") {
            return Err(refused("a meta refresh is not allowed"));
        }
        if name == "style" && css_remote(&value.to_ascii_lowercase()) {
            return Err(refused("an inline style loads a remote URL"));
        }
        if name.starts_with("on")
            && REMOTE_MARKERS
                .iter()
                .any(|m| value.to_ascii_lowercase().contains(m))
        {
            return Err(refused("an event handler references a remote URL"));
        }
    }
    Ok(())
}

/// The few entities that could hide a scheme (`&#58;` for `:`...).
fn decode_entities(value: &str) -> String {
    value
        .replace("&colon;", ":")
        .replace("&#58;", ":")
        .replace("&#x3a;", ":")
        .replace("&#x3A;", ":")
        .replace("&sol;", "/")
        .replace("&#47;", "/")
        .replace("&#x2f;", "/")
        .replace("&#x2F;", "/")
}

fn shorten(value: &str) -> String {
    let short: String = value.chars().take(60).collect();
    if short.len() < value.len() {
        format!("{short}…")
    } else {
        short
    }
}

/// The bodies between `open` and `close` (lowercased document) must not
/// mention a remote URL (or a protocol-relative one).
fn check_blocks(low: &str, open: &str, close: &str, what: &str) -> Result<(), String> {
    let mut i = 0;
    while let Some(at) = low[i..].find(open) {
        let start = i + at;
        let body_start = low[start..]
            .find('>')
            .map_or(low.len(), |end| start + end + 1);
        let body_end = low[body_start..]
            .find(close)
            .map_or(low.len(), |end| body_start + end);
        let body = &low[body_start..body_end];
        if REMOTE_MARKERS.iter().any(|m| body.contains(m))
            || body.contains("\"//")
            || body.contains("'//")
            || body.contains("`//")
        {
            return Err(refused(what));
        }
        i = body_end;
    }
    Ok(())
}

/// CSS anywhere in the document: `@import` and `url()` must stay local.
fn check_css(low: &str) -> Result<(), String> {
    if low.contains("@import") {
        return Err(refused("CSS @import is not allowed"));
    }
    if css_remote(low) {
        return Err(refused(
            "a CSS url() loads something that is not a data: URI",
        ));
    }
    Ok(())
}

/// Whether some CSS `url(...)` points at anything but `data:` or `#`.
fn css_remote(low: &str) -> bool {
    let mut i = 0;
    while let Some(at) = low[i..].find("url(") {
        let start = i + at + 4;
        let rest =
            low[start..].trim_start_matches(|c: char| c.is_whitespace() || c == '"' || c == '\'');
        if !(rest.starts_with("data:") || rest.starts_with('#')) {
            return true;
        }
        i = start;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const SITE: &str = "<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">\
        <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
        <title>Panadería</title><style>body{font-family:system-ui;background:url(data:image/png;base64,iVBORw0KGgo=)}</style>\
        </head><body><nav><a href=\"#menu\">Menú</a> <a href=\"mailto:hola@panaderia.es\">Escríbenos</a></nav>\
        <img src=\"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=\" alt=\"logo\">\
        <section id=\"menu\"><h1>Pan del día</h1></section>\
        <script>document.querySelector('h1').addEventListener('click', () => alert('hola'));</script>\
        </body></html>";

    fn args(title: &str, html: &str) -> String {
        serde_json::json!({ "title": title, "html": html }).to_string()
    }

    #[test]
    fn a_self_contained_site_passes() {
        let draft = parse_draft(&args("  Panadería  de   Ana ", SITE)).expect("valid");
        assert_eq!(draft.title, "Panadería de Ana");
        assert_eq!(draft.file_name(), "website-panaderia-de-ana.html");
        assert_eq!(draft.html, SITE);
    }

    #[test]
    fn data_uri_heavy_sites_up_to_the_cap_pass() {
        let image = format!(
            "<img src=\"data:image/png;base64,{}\">",
            "A".repeat(4 * 1024 * 1024)
        );
        let html = format!("<!doctype html><html><body>{image}</body></html>");
        assert!(html.len() < MAX_WEBSITE_BYTES);
        validate_html(&html).expect("data URIs are fine");
    }

    #[test]
    fn oversized_sites_are_refused() {
        let html = format!(
            "<html><body>{}</body></html>",
            "a".repeat(MAX_WEBSITE_BYTES)
        );
        let err = validate_html(&html).expect_err("too big");
        assert!(err.contains("8 MiB"), "{err}");
    }

    #[test]
    fn remote_scripts_styles_images_and_links_are_refused() {
        for html in [
            "<script src=\"https://cdn.example.com/x.js\"></script>",
            "<script src='//cdn.example.com/x.js'></script>",
            "<script SRC=https://cdn.example.com/x.js></script>",
            "<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css\">",
            "<img src=\"http://example.com/a.png\">",
            "<img src=\"logo.png\">",
            "<img srcset=\"https://x.io/a.png 2x\">",
            "<a href=\"https://example.com\">x</a>",
            "<a href=\"otra.html\">x</a>",
            "<a href=\"javascript:alert(1)\">x</a>",
            "<a href=\"https&#58;//example.com\">x</a>",
            "<form action=\"https://example.com/submit\"></form>",
            "<iframe src=\"https://example.com\"></iframe>",
            "<video poster=\"https://x.io/p.jpg\"></video>",
            "<div style=\"background:url(https://x.io/a.png)\"></div>",
            "<style>@import url('https://x.io/a.css');</style>",
            "<style>body{background:url(https://x.io/a.png)}</style>",
            "<style>@font-face{src:url(font.woff2)}</style>",
            "<script>fetch('https://api.example.com/data')</script>",
            "<script>new WebSocket('wss://x.io')</script>",
            "<script>const s=document.createElement('script');s.src='//x.io/a.js'</script>",
            "<button onclick=\"location='https://x.io'\">go</button>",
            "<base href=\"https://x.io/\">",
            "<meta http-equiv=\"refresh\" content=\"0;url=https://x.io\">",
            "<img srcset=\"data:image/png;base64,AAAA 1x, https://x.io/b.png 2x\">",
        ] {
            let doc = format!("<!doctype html><html><body>{html}</body></html>");
            assert!(validate_html(&doc).is_err(), "should refuse: {html}");
        }
    }

    #[test]
    fn text_that_merely_mentions_a_url_outside_code_is_fine() {
        validate_html(
            "<html><head><meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\"></head>\
             <body><p>Pulsa refresh</p><img srcset=\"data:image/png;base64,AA,BB 2x\"></body></html>",
        )
        .expect("a harmless http-equiv and a data: srcset");
        let doc = "<html><body><p>Visítanos en https://panaderia.es</p>\
            <!-- <script src=\"https://x.io/a.js\"></script> --></body></html>";
        validate_html(doc).expect("plain text and comments are not loaded");
    }

    #[test]
    fn empty_nul_and_bad_arguments_are_refused() {
        assert!(validate_html("   ").is_err());
        assert!(validate_html("<p>a\0b</p>").is_err());
        assert!(parse_draft(&args("", SITE)).is_err());
        assert!(parse_draft(&args("   ", SITE)).is_err());
        assert!(parse_draft("{\"title\":\"x\"}").is_err());
        assert!(parse_draft("not json").is_err());
    }

    #[test]
    fn slugs_are_ascii_short_and_never_empty() {
        assert_eq!(slug("Mi Landing — Café & Té!"), "mi-landing-cafe-te");
        assert_eq!(slug("¡¡¡"), "site");
        assert_eq!(slug("../../etc/passwd"), "etc-passwd");
        assert!(slug(&"palabra ".repeat(40)).len() <= MAX_SLUG);
        assert!(!slug(&"palabra ".repeat(40)).ends_with('-'));
    }

    #[test]
    fn the_definition_and_guidance_describe_a_self_contained_site() {
        let def = tool_definition();
        assert_eq!(def["function"]["name"], TOOL_NAME);
        assert_eq!(
            def["function"]["parameters"]["required"],
            serde_json::json!(["title", "html"])
        );
        assert!(GUIDANCE.contains("write_website"));
        assert!(GUIDANCE.contains("self-contained"));
        assert!(GUIDANCE.contains("data: URI"));
        assert!(GUIDANCE.contains("sandboxed"));
    }
}
