//! Which addresses the in-app browser may load (pure, unit-tested).
//!
//! Two entry points share one rule set:
//! - [`parse_agent_url`]: the address a model passes to `browser_open`
//!   (a bare `example.com` gets `https://`).
//! - [`navigation_allowed`]: the window's navigation guard, asked by the
//!   webview for EVERY navigation the page or the user starts.
//!
//! Only `http` / `https` load. Never `file:`, `data:`, `javascript:`,
//! `blob:`, custom schemes or the app's own origins: `tauri://`,
//! `ipc://`, `asset://`, `nan-site://` and, because Tauri treats
//! `http://<scheme>.localhost` as the app's own (local) origin on Windows,
//! every `localhost` / `*.localhost` host. A page that reached a local
//! origin would be treated by Tauri as the app itself, so this list is a
//! security boundary, not a convenience (see SECURITY.md, In-app browser).
//!
//! Private / local-network addresses (loopback IPs, RFC 1918, link-local,
//! CGNAT, IPv6 ULA, single-label and `.local`-style names) still load, so a
//! user can test their own local server, but [`ParsedUrl::private`] marks
//! them: the agent always needs an explicit approval for them (see
//! `policy.rs`). DNS answers are not inspected (a public name that resolves
//! to a private address is treated as public; documented limitation).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use tauri::Url;

/// Longest address the agent may open.
pub const MAX_URL_LEN: usize = 2048;

/// Why an address was refused (fed back to the model as-is).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlRefusal {
    Empty,
    TooLong,
    Invalid,
    /// Not http/https.
    Scheme,
    /// `user:password@` in the address.
    Credentials,
    /// `localhost`, `*.localhost`: the app's own origins live there.
    AppOrigin,
}

impl UrlRefusal {
    pub fn message(self) -> &'static str {
        match self {
            Self::Empty => "the address is empty",
            Self::TooLong => "the address is too long",
            Self::Invalid => "the address is not a valid web address",
            Self::Scheme => "only http and https web pages can be opened in the browser",
            Self::Credentials => {
                "addresses with a user name or password inside are not allowed; \
                 ask the user to sign in themselves in the browser window"
            }
            Self::AppOrigin => {
                "localhost addresses cannot be opened (use 127.0.0.1 for a local server)"
            }
        }
    }
}

/// An address that passed the rules.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUrl {
    pub url: Url,
    /// Lowercase host, as the user sees it.
    pub host: String,
    /// The approval key ([`site_key`]).
    pub site: String,
    /// Local network / loopback address: always needs an explicit approval.
    pub private: bool,
}

/// The approval key of a host: lowercase, without a leading `www.`.
/// Subdomains are separate sites on purpose (`accounts.example.com` is not
/// `example.com`).
pub fn site_key(host: &str) -> String {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host.strip_prefix("www.").unwrap_or(&host).to_string()
}

/// Validate an address the model wants to open. A missing scheme means
/// `https://`.
pub fn parse_agent_url(raw: &str) -> Result<ParsedUrl, UrlRefusal> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(UrlRefusal::Empty);
    }
    if raw.len() > MAX_URL_LEN {
        return Err(UrlRefusal::TooLong);
    }
    if raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(UrlRefusal::Invalid);
    }
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        // Anything with a scheme but no `//` (`javascript:`, `data:`,
        // `mailto:`, `file:`) is refused outright instead of being glued
        // to https:// and reinterpreted.
        if let Some((scheme, _)) = raw.split_once(':')
            && !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
            && !scheme.contains('.')
            && !raw[scheme.len() + 1..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_digit())
        {
            return Err(UrlRefusal::Scheme);
        }
        format!("https://{raw}")
    };
    let url = Url::parse(&candidate).map_err(|_| UrlRefusal::Invalid)?;
    check(url)
}

/// The rule set on an already parsed URL.
fn check(url: Url) -> Result<ParsedUrl, UrlRefusal> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(UrlRefusal::Scheme);
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UrlRefusal::Credentials);
    }
    let Some(host) = url.host_str() else {
        return Err(UrlRefusal::Invalid);
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return Err(UrlRefusal::Invalid);
    }
    if is_app_origin_host(&host) {
        return Err(UrlRefusal::AppOrigin);
    }
    // The URL parser already normalized IP literals (`0x7f.1` ->
    // `127.0.0.1`); IPv6 hosts keep their brackets in `host_str`.
    let private = match host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        Ok(ip) => is_private_ip(ip),
        Err(_) => is_private_name(&host),
    };
    Ok(ParsedUrl {
        site: site_key(&host),
        host,
        url,
        private,
    })
}

/// The navigation guard: may the browser window load `url`? `about:blank`
/// is the only non-web page allowed (an empty frame, nothing to reach).
pub fn navigation_allowed(url: &Url) -> bool {
    if url.as_str() == "about:blank" {
        return true;
    }
    check(url.clone()).is_ok()
}

/// `localhost` and every `*.localhost` name: Tauri serves the app's own
/// origins there (`http://tauri.localhost`, `http://ipc.localhost`,
/// `http://nan-site.localhost` on Windows) and treats them as LOCAL, i.e.
/// as the app itself.
fn is_app_origin_host(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost")
}

fn is_private_name(host: &str) -> bool {
    // Single-label names (`router`, `nas`) resolve on the local network.
    !host.contains('.')
        || [
            ".local",
            ".lan",
            ".internal",
            ".intranet",
            ".home.arpa",
            ".home",
            ".corp",
        ]
        .iter()
        .any(|suffix| host.ends_with(suffix))
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        // 100.64.0.0/10 (carrier-grade NAT, also used by VPN overlays).
        || (a == 100 && (64..128).contains(&b))
        // 0.0.0.0/8
        || a == 0
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        // fc00::/7 unique local
        || (first & 0xfe00) == 0xfc00
        // fe80::/10 link local
        || (first & 0xffc0) == 0xfe80
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) -> ParsedUrl {
        parse_agent_url(raw).unwrap_or_else(|err| panic!("{raw}: {err:?}"))
    }

    #[test]
    fn a_bare_domain_opens_over_https() {
        let parsed = ok("example.com/path?q=1");
        assert_eq!(parsed.url.as_str(), "https://example.com/path?q=1");
        assert_eq!(parsed.host, "example.com");
        assert_eq!(parsed.site, "example.com");
        assert!(!parsed.private);
        assert_eq!(ok("http://Example.COM").url.scheme(), "http");
    }

    #[test]
    fn www_is_the_same_site_but_subdomains_are_not() {
        assert_eq!(ok("https://www.example.com").site, "example.com");
        assert_eq!(
            ok("https://accounts.example.com").site,
            "accounts.example.com"
        );
        assert_eq!(site_key("WWW.Example.com."), "example.com");
    }

    #[test]
    fn only_http_and_https_load() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<b>x</b>",
            "blob:https://example.com/uuid",
            "tauri://localhost/index.html",
            "ipc://localhost/chat_send",
            "asset://localhost/x.png",
            "nan-site://localhost/abc",
            "ftp://example.com",
            "mailto:someone@example.com",
            "chrome://settings",
            "about:config",
            "view-source:https://example.com",
        ] {
            assert_eq!(parse_agent_url(raw), Err(UrlRefusal::Scheme), "{raw}");
        }
    }

    #[test]
    fn the_apps_own_local_origins_are_refused() {
        for raw in [
            "http://localhost:1420/",
            "https://localhost",
            "http://tauri.localhost/index.html",
            "http://ipc.localhost/chat_send",
            "http://nan-site.localhost/0123",
            "http://asset.localhost/x.png",
            "http://LOCALHOST./",
        ] {
            assert_eq!(parse_agent_url(raw), Err(UrlRefusal::AppOrigin), "{raw}");
        }
    }

    #[test]
    fn credentials_in_the_address_are_refused() {
        assert_eq!(
            parse_agent_url("https://user:secret@example.com"),
            Err(UrlRefusal::Credentials)
        );
        assert_eq!(
            parse_agent_url("https://user@example.com"),
            Err(UrlRefusal::Credentials)
        );
    }

    #[test]
    fn garbage_is_invalid_not_reinterpreted() {
        assert_eq!(parse_agent_url("   "), Err(UrlRefusal::Empty));
        assert_eq!(parse_agent_url("exa mple.com"), Err(UrlRefusal::Invalid));
        assert_eq!(parse_agent_url("https://"), Err(UrlRefusal::Invalid));
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert_eq!(parse_agent_url(&long), Err(UrlRefusal::TooLong));
    }

    #[test]
    fn a_host_with_a_port_is_not_mistaken_for_a_scheme() {
        let parsed = ok("127.0.0.1:3000/app");
        assert_eq!(parsed.url.as_str(), "https://127.0.0.1:3000/app");
        assert!(parsed.private);
        assert_eq!(ok("example.com:8443").url.port(), Some(8443));
    }

    #[test]
    fn local_network_addresses_load_but_are_marked_private() {
        for raw in [
            "http://127.0.0.1:8080",
            "http://10.1.2.3",
            "http://172.16.0.1",
            "http://192.168.1.1",
            "http://169.254.169.254/latest/meta-data",
            "http://100.64.0.1",
            "http://0.0.0.0:8000",
            "http://[::1]:3000",
            "http://[fd00::1]",
            "http://[fe80::1]",
            "http://[::ffff:192.168.0.1]",
            "http://router",
            "http://nas.local",
            "http://printer.lan",
            "http://wiki.corp",
        ] {
            assert!(ok(raw).private, "{raw} must be private");
        }
        for raw in [
            "https://8.8.8.8",
            "https://example.org",
            "http://[2001:db8::1]",
        ] {
            assert!(!ok(raw).private, "{raw} must be public");
        }
    }

    #[test]
    fn the_navigation_guard_applies_the_same_rules() {
        let allowed = |raw: &str| navigation_allowed(&Url::parse(raw).unwrap());
        assert!(allowed("https://example.com/a"));
        assert!(allowed("http://192.168.1.1/"));
        assert!(allowed("about:blank"));
        assert!(!allowed("about:srcdoc"));
        assert!(!allowed("file:///etc/hosts"));
        assert!(!allowed("tauri://localhost/"));
        assert!(!allowed("http://tauri.localhost/"));
        assert!(!allowed("http://localhost:1420/"));
        assert!(!allowed("data:text/html,hi"));
        assert!(!allowed("javascript:alert(1)"));
        assert!(!allowed("https://u:p@example.com/"));
    }
}
