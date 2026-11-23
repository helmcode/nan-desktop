//! Shared artifact links in the preview pane (issue #57).
//!
//! A share link (`https://artifacts.nan.builders/a/<token>`, or the
//! Helmcode twin `https://artifacts.helmcode.com/a/<token>`) points at a
//! share PAGE: our own server template with the file's metadata and an
//! embed of the real bytes behind a short-lived content ticket
//! (`https://<host>/c/<ticket>`, 5 minutes, authorized by the ticket only).
//! Reading that page through the generic web preview only ever showed the
//! metadata as text. Here the core:
//!
//! 1. accepts ONLY those two hosts, over https, with an exact `/a/<token>`
//!    path ([`parse_share_url`]); the query and fragment are dropped, so a
//!    one-use member-email grant (`?e=` / `?g=`) is never spent by the app;
//! 2. GETs the share page with NO credentials (no cookie store, no session,
//!    no redirects). A public link answers with the viewer; a restricted
//!    one answers with a sign-in page, which has no content link, and the
//!    renderer falls back to opening the link in the browser;
//! 3. finds the content ticket on the SAME host ([`content_ticket`]) and
//!    GETs `/c/<ticket>` (8 MiB cap, the server's own upload limit), then
//!    decides how to show it from the served `Content-Type` only
//!    ([`kind_for_content_type`]): HTML is registered in the sandboxed
//!    document class of [`crate::site_preview`] (opaque origin, scripts
//!    only, no network: the same posture as the share page's own
//!    `sandbox="allow-scripts"` frame and the content CSP), every other
//!    previewable type goes back as bytes for the existing renderers.
//!
//! Nothing here logs: no URL, no token, no ticket, no content.

use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::preview::MAX_PREVIEW_FILE_BYTES;
use crate::site_preview::SiteRegistry;
use crate::tools::Rejection;

/// The artifact hosts of the two tenants (community, enterprise).
pub const ARTIFACT_HOSTS: &[&str] = &["artifacts.nan.builders", "artifacts.helmcode.com"];

/// Largest share page read (the page is our template plus, at most, a
/// server-rendered preview of a small text file).
const MAX_PAGE_BYTES: usize = 4 * 1024 * 1024;

/// Longest share URL accepted.
const MAX_URL_CHARS: usize = 2048;

/// Link tokens are base64url (43 chars today); a little slack either way.
const TOKEN_LEN: std::ops::RangeInclusive<usize> = 16..=128;

/// Content tickets are opaque base64url-ish blobs, bounded.
const TICKET_LEN: std::ops::RangeInclusive<usize> = 16..=4096;

/// Longest title / file name forwarded to the renderer (chars).
const MAX_LABEL_CHARS: usize = 200;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// A validated share link: one of [`ARTIFACT_HOSTS`] and its token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareLink {
    pub host: String,
    pub token: String,
}

/// Whether `url` is a share link of one of the two artifact hosts: https,
/// the exact host (no port, no credentials, no other subdomain) and the
/// exact path `/a/<token>`. The query and fragment are accepted and
/// dropped. Anything else is `None` and keeps the generic web preview.
pub fn parse_share_url(url: &str) -> Option<ShareLink> {
    let url = url.trim();
    if url.is_empty()
        || url.chars().count() > MAX_URL_CHARS
        || url.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let scheme = url.get(..8)?;
    if !scheme.eq_ignore_ascii_case("https://") {
        return None;
    }
    let rest = &url[8..];
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(authority_end);
    let host = authority.to_ascii_lowercase();
    if !ARTIFACT_HOSTS.contains(&host.as_str()) {
        return None;
    }
    let path = &tail[..tail.find(['?', '#']).unwrap_or(tail.len())];
    let token = path.strip_prefix("/a/")?;
    let token_ok = TOKEN_LEN.contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !token_ok {
        return None;
    }
    Some(ShareLink {
        host,
        token: token.to_string(),
    })
}

fn is_ticket_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~')
}

/// The content ticket the share page embeds (`https://<host>/c/<ticket>`,
/// as the frame / image source or the download link), on the SAME host as
/// the link. `None` when the page carries none: a sign-in page, a 404
/// page, or content on any other host.
pub fn content_ticket(page: &str, host: &str) -> Option<String> {
    let needle = format!("https://{host}/c/");
    let mut from = 0;
    while let Some(at) = page[from..].find(&needle) {
        let start = from + at + needle.len();
        let len = page.as_bytes()[start..]
            .iter()
            .take_while(|b| is_ticket_byte(**b))
            .count();
        let ticket = &page[start..start + len];
        if TICKET_LEN.contains(&ticket.len()) {
            return Some(ticket.to_string());
        }
        from = start;
    }
    None
}

/// Decode the HTML character references Go's `html/template` emits (named
/// basics plus decimal / hex numeric references). Unknown ones stay as is.
pub fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let decoded = rest.find(';').filter(|end| *end <= 10).and_then(|end| {
            let name = &rest[1..end];
            let ch = match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ => {
                    let code = if let Some(hex) =
                        name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"))
                    {
                        u32::from_str_radix(hex, 16).ok()
                    } else {
                        name.strip_prefix('#').and_then(|dec| dec.parse().ok())
                    };
                    code.and_then(char::from_u32)
                }
            };
            ch.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Plain text of an HTML fragment: tags dropped, references decoded,
/// whitespace collapsed, capped. `None` when nothing is left.
fn plain_label(fragment: &str) -> Option<String> {
    let mut text = String::new();
    let mut in_tag = false;
    for c in fragment.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                text.push(' ');
            }
            _ if !in_tag => text.push(c),
            _ => {}
        }
    }
    let decoded = decode_entities(&text);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_LABEL_CHARS)
        .collect();
    (!capped.is_empty()).then_some(capped)
}

/// The artifact's title: the first `<h1>` of the share page (the viewer
/// header of both tenants' templates).
pub fn page_title(page: &str) -> Option<String> {
    let open = page.find("<h1")?;
    let body_start = open + page[open..].find('>')? + 1;
    let body_end = body_start + page[body_start..].find("</h1>")?;
    plain_label(&page[body_start..body_end])
}

/// The artifact's file name: the download link's `aria-label="Download
/// <file name>"` (same contract in both tenants' templates).
pub fn page_filename(page: &str) -> Option<String> {
    const MARK: &str = "aria-label=\"Download ";
    let start = page.find(MARK)? + MARK.len();
    let end = start + page[start..].find('"')?;
    plain_label(&page[start..end])
}

/// How the renderer shows a served `Content-Type` (the server's own table:
/// pdf, png/jpeg/webp/gif, md, txt, csv, html, docx, xlsx). The names are
/// the renderer's `PreviewKind`s. `None`: not previewable here.
pub fn kind_for_content_type(content_type: &str) -> Option<&'static str> {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Some(match essence.as_str() {
        "text/html" => "html",
        "application/pdf" => "pdf",
        "image/png" | "image/jpeg" | "image/webp" | "image/gif" => "image",
        "text/markdown" => "markdown",
        "text/plain" => "text",
        "text/csv" => "sheet",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        _ => return None,
    })
}

/// The fetched artifact, before it is handed to the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FetchedArtifact {
    pub kind: &'static str,
    pub title: Option<String>,
    pub filename: Option<String>,
    pub bytes: Vec<u8>,
}

/// `artifact_link_preview` reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactLinkPreview {
    /// The renderer's `PreviewKind` (`html`, `pdf`, `image`, `markdown`,
    /// `text`, `sheet`, `docx`).
    pub kind: &'static str,
    pub title: Option<String>,
    pub filename: Option<String>,
    pub size: u64,
    /// Standard base64 of the bytes; absent for HTML (served by the
    /// sandboxed site scheme instead).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    /// HTML only: the sandboxed document URL (ephemeral class, released by
    /// the renderer when the preview closes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_url: Option<String>,
}

fn invalid_url() -> Rejection {
    Rejection::new("invalid_url", "not a shared artifact link")
}

fn unavailable() -> Rejection {
    Rejection::new("unavailable", "the shared file could not be loaded")
}

fn status_rejection(status: u16) -> Rejection {
    match status {
        404 | 410 => Rejection::new("not_found", "the shared link is not available"),
        429 => Rejection::new("rate_limited", "too many requests, try again later"),
        _ => unavailable(),
    }
}

/// The HTTP client for share pages and content: no cookies, no redirects,
/// bounded time. `https_only` is off only in tests (loopback mock server).
pub fn client(https_only: bool) -> Result<reqwest::Client, Rejection> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .https_only(https_only)
        .build()
        .map_err(|_| unavailable())
}

async fn read_capped(response: reqwest::Response, max: usize) -> Result<Vec<u8>, Rejection> {
    use futures_util::StreamExt as _;
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| unavailable())?;
        if body.len() + chunk.len() > max {
            return Err(Rejection::new(
                "too_large",
                "the shared file is over the preview limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Fetch the share page and the artifact bytes. `base` is where requests
/// go (`https://<link host>` in the app; a loopback mock in tests); the
/// ticket is always looked up under the LINK's host.
///
/// Rejections: `not_found` (404/410), `rate_limited` (429), `unavailable`
/// (network, any other status), `restricted` (the page carries no content:
/// a sign-in page), `unsupported` (a type the pane cannot show),
/// `too_large` (over the 8 MiB cap).
pub async fn fetch_artifact(
    client: &reqwest::Client,
    base: &str,
    link: &ShareLink,
) -> Result<FetchedArtifact, Rejection> {
    let page = client
        .get(format!("{base}/a/{}", link.token))
        .header(reqwest::header::ACCEPT, "text/html")
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = page.status().as_u16();
    if status != 200 {
        return Err(status_rejection(status));
    }
    let page = read_capped(page, MAX_PAGE_BYTES).await.map_err(|err| {
        if err.kind == "too_large" {
            unavailable()
        } else {
            err
        }
    })?;
    let page = String::from_utf8_lossy(&page);
    let ticket = content_ticket(&page, &link.host)
        .ok_or_else(|| Rejection::new("restricted", "the shared file opens in the browser only"))?;
    let title = page_title(&page);
    let filename = page_filename(&page);

    let content = client
        .get(format!("{base}/c/{ticket}"))
        .send()
        .await
        .map_err(|_| unavailable())?;
    let status = content.status().as_u16();
    if status != 200 {
        return Err(status_rejection(status));
    }
    let content_type = content
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let kind = kind_for_content_type(&content_type)
        .ok_or_else(|| Rejection::new("unsupported", "this file type cannot be previewed here"))?;
    let bytes = read_capped(content, MAX_PREVIEW_FILE_BYTES as usize).await?;
    Ok(FetchedArtifact {
        kind,
        title,
        filename,
        bytes,
    })
}

/// Turn a fetched artifact into the reply: HTML goes to the sandboxed
/// document class of the site registry (never to the renderer as bytes),
/// everything else as base64.
pub fn into_reply(artifact: FetchedArtifact, sites: &SiteRegistry) -> ArtifactLinkPreview {
    let size = artifact.bytes.len() as u64;
    let (base64, site_url) = if artifact.kind == "html" {
        let token = sites.register_document(artifact.bytes);
        (None, Some(crate::site_preview::site_url(&token)))
    } else {
        (
            Some(base64::engine::general_purpose::STANDARD.encode(&artifact.bytes)),
            None,
        )
    };
    ArtifactLinkPreview {
        kind: artifact.kind,
        title: artifact.title,
        filename: artifact.filename,
        size,
        base64,
        site_url,
    }
}

#[tauri::command]
pub async fn artifact_link_preview(
    app: AppHandle,
    url: String,
) -> Result<ArtifactLinkPreview, Rejection> {
    let link = parse_share_url(&url).ok_or_else(invalid_url)?;
    let client = client(true)?;
    let artifact = fetch_artifact(&client, &format!("https://{}", link.host), &link).await?;
    let sites = app.try_state::<SiteRegistry>().ok_or_else(unavailable)?;
    Ok(into_reply(artifact, sites.inner()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    const TOKEN: &str = "Zk3d9QpL2xVb7Nw4Rt6Ys1Ue8Ia0Oc5Hj2Kl4Mn6Pq";
    const TICKET: &str = "AbCdEf0123456789-_AbCdEf0123456789.xyz";

    // ---------------------------------------------------------- matching --

    #[test]
    fn only_the_two_artifact_hosts_with_an_exact_share_path_match() {
        for host in ARTIFACT_HOSTS {
            let link = parse_share_url(&format!("https://{host}/a/{TOKEN}")).unwrap();
            assert_eq!(link.host, *host);
            assert_eq!(link.token, TOKEN);
        }
        // Host and scheme are case-insensitive; query and fragment dropped.
        let link = parse_share_url(&format!(
            "HTTPS://Artifacts.NAN.builders/a/{TOKEN}?e=grant#x"
        ))
        .unwrap();
        assert_eq!(link.host, "artifacts.nan.builders");
        assert_eq!(link.token, TOKEN);
    }

    #[test]
    fn everything_else_is_not_an_artifact_link() {
        let refused = [
            format!("http://artifacts.nan.builders/a/{TOKEN}"),
            format!("https://artifacts.nan.builders:443/a/{TOKEN}"),
            format!("https://user@artifacts.nan.builders/a/{TOKEN}"),
            format!("https://evil.artifacts.nan.builders/a/{TOKEN}"),
            format!("https://artifacts.nan.builders.evil.com/a/{TOKEN}"),
            format!("https://cloud.nan.builders/a/{TOKEN}"),
            format!("https://artifacts.helmcode.com.evil/a/{TOKEN}"),
            format!("https://artifacts.nan.builders/c/{TOKEN}"),
            format!("https://artifacts.nan.builders/a/{TOKEN}/"),
            format!("https://artifacts.nan.builders/a/{TOKEN}/x"),
            format!("https://artifacts.nan.builders/x/a/{TOKEN}"),
            "https://artifacts.nan.builders/a/short".to_string(),
            "https://artifacts.nan.builders/a/".to_string(),
            "https://artifacts.nan.builders/".to_string(),
            format!("https://artifacts.nan.builders/a/{TOKEN}%2F"),
            format!("https://artifacts.nan.builders/a/{}", "a".repeat(200)),
            format!("https://artifacts.nan.builders/a/ {TOKEN}"),
            format!("javascript:https://artifacts.nan.builders/a/{TOKEN}"),
            String::new(),
        ];
        for url in refused {
            assert_eq!(parse_share_url(&url), None, "{url}");
        }
    }

    // ------------------------------------------------------- page parsing --

    fn community_page(ticket: &str) -> String {
        format!(
            "<!doctype html><html><head><title>Q3 report · NaN</title></head><body>\
             <header><span class=\"brand\">NaN</span></header><main>\
             <section class=\"file-head\"><div class=\"file-info\">\
             <p class=\"eyebrow\">q3 &amp; plan.html</p>\
             <h1 class=\"file-title\">Q3 &#34;report&#34; &lt;draft&gt;</h1>\
             <dl class=\"file-meta\"><div><dt>Shared by</dt><dd>Ana</dd></div></dl></div>\
             <a class=\"dl\" href=\"https://artifacts.nan.builders/c/{ticket}?dl=1\" \
             aria-label=\"Download q3 &amp; plan.html\" title=\"Download\"><svg></svg></a></section>\
             <iframe sandbox=\"allow-scripts\" src=\"https://artifacts.nan.builders/c/{ticket}\" \
             title=\"Q3\"></iframe></main></body></html>"
        )
    }

    fn enterprise_page(ticket: &str) -> String {
        format!(
            "<html><body><header class=\"bar\"><span class=\"brand\"><svg></svg></span>\
             <div class=\"file\"><h1 title=\"Budget\">Budget</h1><ul class=\"meta\">\
             <li>Shared by Bea</li><li>budget.pdf</li></ul></div>\
             <a class=\"icon-btn\" href=\"https://artifacts.helmcode.com/c/{ticket}?dl=1\" \
             aria-label=\"Download budget.pdf\" title=\"Download\"></a></header>\
             <main class=\"stage\"><iframe class=\"frame\" src=\"https://artifacts.helmcode.com/c/{ticket}\" \
             title=\"Budget\"></iframe></main></body></html>"
        )
    }

    const SIGN_IN_PAGE: &str = "<html><body><main><h1>Sign in to open this file</h1>\
        <div class=\"box\"><p>This file was shared with specific NaN members.</p>\
        <p><a class=\"btn\" href=\"https://cloud.nan.builders/login\">Sign in to NaN</a></p>\
        </div></main></body></html>";

    #[test]
    fn the_ticket_title_and_file_name_come_from_both_tenants_pages() {
        let page = community_page(TICKET);
        assert_eq!(
            content_ticket(&page, "artifacts.nan.builders").as_deref(),
            Some(TICKET)
        );
        assert_eq!(page_title(&page).as_deref(), Some("Q3 \"report\" <draft>"));
        assert_eq!(page_filename(&page).as_deref(), Some("q3 & plan.html"));

        let page = enterprise_page(TICKET);
        assert_eq!(
            content_ticket(&page, "artifacts.helmcode.com").as_deref(),
            Some(TICKET)
        );
        assert_eq!(page_title(&page).as_deref(), Some("Budget"));
        assert_eq!(page_filename(&page).as_deref(), Some("budget.pdf"));
    }

    #[test]
    fn no_ticket_on_a_sign_in_page_or_on_another_host() {
        assert_eq!(content_ticket(SIGN_IN_PAGE, "artifacts.nan.builders"), None);
        // The community page's content is on its own host, never another.
        assert_eq!(
            content_ticket(&community_page(TICKET), "artifacts.helmcode.com"),
            None
        );
        let foreign = format!("<img src=\"https://evil.example/c/{TICKET}\">");
        assert_eq!(content_ticket(&foreign, "artifacts.nan.builders"), None);
        // A too-short candidate is skipped, the next valid one wins.
        let page = format!(
            "https://artifacts.nan.builders/c/x\" https://artifacts.nan.builders/c/{TICKET}\""
        );
        assert_eq!(
            content_ticket(&page, "artifacts.nan.builders").as_deref(),
            Some(TICKET)
        );
    }

    #[test]
    fn entities_decode_like_go_templates_emit_them() {
        assert_eq!(
            decode_entities("a &amp; b &#39;c&#39; &#x41; &quot;"),
            "a & b 'c' A \""
        );
        assert_eq!(decode_entities("&bogus; & &#xZZ;"), "&bogus; & &#xZZ;");
        assert_eq!(decode_entities("trailing &"), "trailing &");
    }

    #[test]
    fn served_content_types_map_to_the_renderers() {
        let cases = [
            ("text/html; charset=utf-8", Some("html")),
            ("application/pdf", Some("pdf")),
            ("image/png", Some("image")),
            ("image/jpeg", Some("image")),
            ("image/webp", Some("image")),
            ("image/gif", Some("image")),
            ("text/markdown; charset=utf-8", Some("markdown")),
            ("text/plain; charset=utf-8", Some("text")),
            ("text/csv; charset=utf-8", Some("sheet")),
            (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                Some("sheet"),
            ),
            (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                Some("docx"),
            ),
            ("Application/PDF", Some("pdf")),
            ("image/svg+xml", None),
            ("application/octet-stream", None),
            ("", None),
        ];
        for (ct, kind) in cases {
            assert_eq!(kind_for_content_type(ct), kind, "{ct}");
        }
    }

    // ----------------------------------------------------- fetch (mocked) --

    struct Route {
        path: String,
        status: u16,
        content_type: &'static str,
        body: Vec<u8>,
    }

    /// Serves `routes` (one connection per route, in any order) and
    /// returns every request head it saw.
    fn mock_server(routes: Vec<Route>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let expected = routes.len();
        let handle = std::thread::spawn(move || {
            let mut heads = Vec::new();
            for stream in listener.incoming().take(expected) {
                let mut stream = stream.unwrap();
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = stream.read(&mut chunk).unwrap();
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                let route = routes.iter().find(|r| r.path == path);
                let (status, ct, body) = match route {
                    Some(r) => (r.status, r.content_type, r.body.clone()),
                    None => (404, "text/plain", b"nope".to_vec()),
                };
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: {ct}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                // The client may hang up early (the size cap): ignore it.
                let _ = stream.write_all(reply.as_bytes());
                let _ = stream.write_all(&body);
                heads.push(head);
            }
            heads
        });
        (base, handle)
    }

    fn fetch(base: &str, link: &ShareLink) -> Result<FetchedArtifact, Rejection> {
        tauri::async_runtime::block_on(fetch_artifact(&client(false).unwrap(), base, link))
    }

    fn nan_link() -> ShareLink {
        parse_share_url(&format!("https://artifacts.nan.builders/a/{TOKEN}?e=grant")).unwrap()
    }

    #[test]
    fn a_public_html_artifact_is_fetched_with_no_credentials_and_served_sandboxed() {
        let html = b"<!doctype html><h1>Hello</h1><script>1</script>".to_vec();
        let (base, server) = mock_server(vec![
            Route {
                path: format!("/a/{TOKEN}"),
                status: 200,
                content_type: "text/html; charset=utf-8",
                body: community_page(TICKET).into_bytes(),
            },
            Route {
                path: format!("/c/{TICKET}"),
                status: 200,
                content_type: "text/html; charset=utf-8",
                body: html.clone(),
            },
        ]);
        let fetched = fetch(&base, &nan_link()).unwrap();
        let heads = server.join().unwrap();
        assert_eq!(fetched.kind, "html");
        assert_eq!(fetched.title.as_deref(), Some("Q3 \"report\" <draft>"));
        assert_eq!(fetched.filename.as_deref(), Some("q3 & plan.html"));
        assert_eq!(fetched.bytes, html);
        // The grant query never leaves the app; no cookie or session is sent.
        assert!(heads[0].starts_with(&format!("GET /a/{TOKEN} HTTP/1.1")));
        assert!(heads[1].starts_with(&format!("GET /c/{TICKET} HTTP/1.1")));
        for head in &heads {
            let lower = head.to_ascii_lowercase();
            assert!(!lower.contains("cookie"), "{head}");
            assert!(!lower.contains("authorization"), "{head}");
            assert!(!lower.contains("grant"), "{head}");
        }

        let sites = SiteRegistry::default();
        let reply = into_reply(fetched, &sites);
        assert_eq!(reply.kind, "html");
        assert_eq!(reply.base64, None);
        assert_eq!(reply.size, html.len() as u64);
        let url = reply.site_url.clone().unwrap();
        let token = url.rsplit('/').next().unwrap();
        assert!(crate::site_preview::valid_token(token));
        // Ephemeral document class: the renderer's release drops it.
        assert!(sites.release_document(token));
        let wire = serde_json::to_value(&reply).unwrap();
        assert_eq!(wire["siteUrl"], serde_json::json!(url));
        assert!(wire.get("base64").is_none());
    }

    #[test]
    fn a_pdf_artifact_goes_back_as_bytes() {
        let pdf = b"%PDF-1.7 fake".to_vec();
        let (base, server) = mock_server(vec![
            Route {
                path: format!("/a/{TOKEN}"),
                status: 200,
                content_type: "text/html",
                body: enterprise_page(TICKET).into_bytes(),
            },
            Route {
                path: format!("/c/{TICKET}"),
                status: 200,
                content_type: "application/pdf",
                body: pdf.clone(),
            },
        ]);
        let link = parse_share_url(&format!("https://artifacts.helmcode.com/a/{TOKEN}")).unwrap();
        let fetched = fetch(&base, &link).unwrap();
        server.join().unwrap();
        let reply = into_reply(fetched, &SiteRegistry::default());
        assert_eq!(reply.kind, "pdf");
        assert_eq!(reply.site_url, None);
        let wire = serde_json::to_value(&reply).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "kind": "pdf", "title": "Budget", "filename": "budget.pdf",
                "size": pdf.len(),
                "base64": base64::engine::general_purpose::STANDARD.encode(&pdf),
            })
        );
    }

    #[test]
    fn a_restricted_link_shows_no_content_and_is_never_retried() {
        let (base, server) = mock_server(vec![Route {
            path: format!("/a/{TOKEN}"),
            status: 200,
            content_type: "text/html",
            body: SIGN_IN_PAGE.as_bytes().to_vec(),
        }]);
        let err = fetch(&base, &nan_link()).unwrap_err();
        assert_eq!(err.kind, "restricted");
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn failures_map_to_typed_kinds_without_leaking_the_link() {
        for (status, kind) in [
            (404, "not_found"),
            (429, "rate_limited"),
            (503, "unavailable"),
            (303, "unavailable"),
        ] {
            let (base, server) = mock_server(vec![Route {
                path: format!("/a/{TOKEN}"),
                status,
                content_type: "text/html",
                body: Vec::new(),
            }]);
            let err = fetch(&base, &nan_link()).unwrap_err();
            server.join().unwrap();
            assert_eq!(err.kind, kind, "{status}");
            assert!(!err.message.contains(TOKEN));
        }
        // A content type the pane cannot show.
        let (base, server) = mock_server(vec![
            Route {
                path: format!("/a/{TOKEN}"),
                status: 200,
                content_type: "text/html",
                body: community_page(TICKET).into_bytes(),
            },
            Route {
                path: format!("/c/{TICKET}"),
                status: 200,
                content_type: "application/zip",
                body: b"PK".to_vec(),
            },
        ]);
        assert_eq!(fetch(&base, &nan_link()).unwrap_err().kind, "unsupported");
        server.join().unwrap();
        // An expired ticket / revoked link at the content route.
        let (base, server) = mock_server(vec![
            Route {
                path: format!("/a/{TOKEN}"),
                status: 200,
                content_type: "text/html",
                body: community_page(TICKET).into_bytes(),
            },
            Route {
                path: format!("/c/{TICKET}"),
                status: 404,
                content_type: "text/plain",
                body: b"not found".to_vec(),
            },
        ]);
        assert_eq!(fetch(&base, &nan_link()).unwrap_err().kind, "not_found");
        server.join().unwrap();
    }

    #[test]
    fn content_over_the_preview_cap_is_too_large() {
        let (base, server) = mock_server(vec![
            Route {
                path: format!("/a/{TOKEN}"),
                status: 200,
                content_type: "text/html",
                body: community_page(TICKET).into_bytes(),
            },
            Route {
                path: format!("/c/{TICKET}"),
                status: 200,
                content_type: "image/png",
                body: vec![0u8; MAX_PREVIEW_FILE_BYTES as usize + 1],
            },
        ]);
        assert_eq!(fetch(&base, &nan_link()).unwrap_err().kind, "too_large");
        server.join().unwrap();
    }

    #[test]
    fn the_app_client_refuses_plain_http() {
        let err = tauri::async_runtime::block_on(fetch_artifact(
            &client(true).unwrap(),
            "http://127.0.0.1:9",
            &nan_link(),
        ))
        .unwrap_err();
        assert_eq!(err.kind, "unavailable");
    }
}
