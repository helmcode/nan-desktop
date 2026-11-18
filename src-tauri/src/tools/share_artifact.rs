//! `share_artifact`: the model shares a file as a link just by talking
//! ("comparte la web con ana@acme.com").
//!
//! It is the manual share (`artifacts::artifact_share`) driven by a tool
//! call, through the SAME core code: [`artifacts::prepare_upload`] (grant
//! check, sniff, 8 MiB cap, secret pre-scan, [`artifacts::checked_meta`])
//! and [`artifacts::send_upload`]. What differs is who decides:
//!
//! - The user ALWAYS approves each share: an inline card (or the native
//!   dialog when a computer-wide grant governs the file), whatever the
//!   folder's approval mode and whether the assistant browsed the web.
//!   There is no `Auto` route here.
//! - The card names the file, who gets it and the expiry, plus the risk
//!   copy for a public link or community recipients. The user's "Allow" is
//!   the risk acknowledgement: the core adds `risk_ack` to the upload ONLY
//!   after that answer. Neither the model (unknown fields are refused) nor
//!   the renderer (it can only answer a request the core created) can set it.
//! - A file that looks like it holds a credential, an unsupported type or a
//!   file over the cap is refused: the model is told to ask the user to
//!   share it by hand from the file chip, where the secret warning lives.
//!   The tool never sets `secret_ack`.
//! - Scope `members` stays manual-only; `org` is offered on Helmcode only.
//!
//! Files: anything inside the conversation's folders (its folder selection),
//! this run's session temp folders (a website `write_website` built) and
//! images this app generated. Nothing in this module logs: no path, link,
//! token or content can reach a log line.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::artifacts::{self, ArtifactError, RiskAck, ShareMeta, ShareSource, Upload};

use super::audit::{self, AuditEntry};
use super::grants::{GrantScope, GrantsStore};
use super::{Approver, ShareAsk};

/// The tool name the model calls.
pub const TOOL_NAME: &str = "share_artifact";

/// What the model is told about sharing (appended to the system prompt only
/// when the tool is offered).
pub const GUIDANCE: &str = "Sharing as a link:\n\
- When the user asks to share, publish or send something as a link (\"comparte la \
web con ana@acme.com\", \"dame un enlace público\", \"pásaselo a mi equipo\"), call \
share_artifact with the file's absolute path: a website you built with write_website, \
a PDF or any other file this conversation produced or that is inside the user's \
folders.\n\
- audience: \"public\" (anyone with the link), \"emails\" (only the listed people; they \
open it signed in) or, when offered, \"org\" (the whole organization). Use exactly what \
the user said; if they did not say who, ask who before sharing. Never invent addresses.\n\
- Do not ask the user to confirm in the chat before calling share_artifact: the app \
always shows its own confirmation card with the file, the recipients and the expiry \
(asking twice is noise). If they decline, do not retry.\n\
- After a successful call, give the user the link from the tool result and say who can \
open it and when it expires. If the tool refuses the file (for example it may contain a \
password or key), end your reply with the file's absolute path on its own line and tell \
the user to share it by hand with the Share button on that file.";

/// Appended to the system prompt instead of [`GUIDANCE`] when the account
/// could have shared links with another plan (community paywall): no tool
/// is offered, the model only explains.
pub const PAYWALL_HINT: &str = "Sharing as a link: sharing files as links (Shared links) \
is not included in the user's current membership. If they ask to share something as a \
link, tell them in one sentence that it needs a membership with Shared links, and do not \
try to publish the file anywhere else.";

/// What the reply may do about sharing, from the renderer's reading of
/// `/api/auth/me` (`chat_send`'s `artifacts`: `on`, `paywall`, else off).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShareOffer {
    Off,
    On,
    Paywall,
}

impl ShareOffer {
    pub fn from_wire(value: Option<&str>) -> Self {
        match value {
            Some("on") => Self::On,
            Some("paywall") => Self::Paywall,
            _ => Self::Off,
        }
    }

    /// The system-prompt addition for this reply, if any.
    pub fn guidance(self) -> Option<&'static str> {
        match self {
            Self::On => Some(GUIDANCE),
            Self::Paywall => Some(PAYWALL_HINT),
            Self::Off => None,
        }
    }
}

/// Days a link lives when the model does not say. Mirrors the manual
/// dialog's `defaultExpiry` (src/artifacts/artifacts.ts) and the server's
/// scope defaults (enterprise-api / cloud-api `docs/ARTIFACTS.md`: public 7,
/// emails 30, members/org 90); `artifacts::expiry_allowed` holds the options.
fn default_expiry(audience: &str) -> u32 {
    match audience {
        "public" => 7,
        "emails" => 30,
        _ => 90,
    }
}

/// The OpenAI function definition for `profile_id` (`org` on Helmcode only).
pub fn tool_definition(profile_id: &str) -> serde_json::Value {
    let enterprise = profile_id == artifacts::ENTERPRISE_PROFILE;
    let audiences: Vec<&str> = if enterprise {
        vec!["public", "emails", "org"]
    } else {
        vec!["public", "emails"]
    };
    let audience_help = if enterprise {
        "public: anyone with the link. emails: only these people (they must be members of the user's organization). org: every member of the organization."
    } else {
        "public: anyone with the link. emails: only these people (they need a NaN account and open it signed in)."
    };
    let expiry_help = if enterprise {
        "Days until the link stops working. public: 1, 7 (default) or 30. emails: 1, 7, 30 (default) or 90. org: 7, 30, 90 (default) or 0 for never."
    } else {
        "Days until the link stops working. public: 1, 7 (default) or 30. emails: 1, 7, 30 (default) or 90."
    };
    serde_json::json!({ "type": "function", "function": {
        "name": TOOL_NAME,
        "description": "Share a file as a link (a website you built, a PDF, an image, a document...). The user always confirms it in the app first. Returns the link to give to the user.",
        "parameters": { "type": "object", "properties": {
            "path": { "type": "string", "description": "Absolute path of the file: one this conversation produced or one inside the user's folders." },
            "title": { "type": "string", "description": "Optional title shown on the shared page (defaults to the file name)." },
            "audience": { "type": "string", "enum": audiences, "description": audience_help },
            "emails": { "type": "array", "items": { "type": "string" }, "description": format!("audience emails only: the recipients' addresses (1 to {}).", artifacts::MAX_RECIPIENTS) },
            "expires_days": { "type": "integer", "description": expiry_help },
            "notify": { "type": "boolean", "description": "audience emails only: email them the link (default true)." }
        }, "required": ["path", "audience"] }
    }})
}

/// The arguments the model sends (unknown fields refused: the model can
/// never pass `risk_ack`, `secret_ack` or `member_ids`).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    path: String,
    #[serde(default)]
    title: Option<String>,
    audience: String,
    #[serde(default)]
    emails: Option<Vec<String>>,
    #[serde(default)]
    expires_days: Option<i64>,
    #[serde(default)]
    notify: Option<bool>,
}

/// A validated share request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareRequest {
    pub path: String,
    pub title: String,
    pub audience: String,
    pub emails: Vec<String>,
    pub expires_days: u32,
    pub notify: bool,
}

impl ShareRequest {
    /// The risk this share carries (what the user's "Allow" accepts):
    /// `public` for a public link, `external` for community recipients
    /// (every one of them is outside the user's account). Helmcode
    /// recipients are org members (the server refuses anyone else).
    pub fn risk(&self, profile_id: &str) -> Option<&'static str> {
        match self.audience.as_str() {
            "public" => Some("public"),
            "emails" if profile_id != artifacts::ENTERPRISE_PROFILE => Some("external"),
            _ => None,
        }
    }

    /// The share metadata as the manual dialog would send it, WITHOUT the
    /// risk acknowledgement (added only after the user's approval).
    fn meta(&self, risk: Option<&str>) -> ShareMeta {
        ShareMeta {
            title: self.title.clone(),
            scope: self.audience.clone(),
            emails: self.emails.clone(),
            member_ids: Vec::new(),
            expires_days: Some(i64::from(self.expires_days)),
            notify: self.notify,
            risk_ack: risk.map(|kind| RiskAck {
                kind: kind.to_string(),
                version: artifacts::RISK_VERSION.to_string(),
            }),
            secret_ack: None,
        }
    }
}

/// Parse and validate a tool call for `profile_id`. Errors are worded for
/// the model (it may fix the call).
pub fn parse_request(profile_id: &str, arguments: &str) -> Result<ShareRequest, String> {
    let args: Args = serde_json::from_str(if arguments.trim().is_empty() {
        "{}"
    } else {
        arguments
    })
    .map_err(|_| {
        "share_artifact needs path and audience (and only path, title, audience, emails, \
         expires_days, notify)"
            .to_string()
    })?;
    let path = args.path.trim().to_string();
    if path.is_empty() || !Path::new(&path).is_absolute() {
        return Err("path must be the file's absolute path".into());
    }
    let audience = args.audience.trim().to_ascii_lowercase();
    let allowed: &[&str] = if profile_id == artifacts::ENTERPRISE_PROFILE {
        &["public", "emails", "org"]
    } else {
        &["public", "emails"]
    };
    if !allowed.contains(&audience.as_str()) {
        return Err(format!(
            "audience must be one of: {} (sharing with chosen team members is done by the \
             user from the Share button)",
            allowed.join(", ")
        ));
    }
    let mut emails: Vec<String> = Vec::new();
    for raw in args.emails.unwrap_or_default() {
        let email = raw.trim().to_ascii_lowercase();
        if !artifacts::is_valid_email(&email) {
            return Err(format!("\"{}\" is not a valid email address", raw.trim()));
        }
        if !emails.contains(&email) {
            emails.push(email);
        }
    }
    if audience == "emails" {
        if emails.is_empty() {
            return Err("audience emails needs at least one address in emails".into());
        }
        if emails.len() > artifacts::MAX_RECIPIENTS {
            return Err(format!(
                "at most {} recipients per link",
                artifacts::MAX_RECIPIENTS
            ));
        }
    } else if !emails.is_empty() {
        return Err(format!(
            "emails only go with audience emails (not {audience})"
        ));
    }
    let days = args
        .expires_days
        .unwrap_or_else(|| i64::from(default_expiry(&audience)));
    if !artifacts::expiry_allowed(&audience, Some(days)) {
        let options = match audience.as_str() {
            "public" => "1, 7 or 30",
            "emails" => "1, 7, 30 or 90",
            _ => "7, 30, 90 or 0 (never)",
        };
        return Err(format!("expires_days for {audience} must be {options}"));
    }
    let title: String = args
        .title
        .unwrap_or_default()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(artifacts::MAX_TITLE_CHARS)
        .collect();
    Ok(ShareRequest {
        path,
        title,
        notify: audience == "emails" && args.notify.unwrap_or(true),
        audience,
        emails,
        expires_days: u32::try_from(days).unwrap_or(0),
    })
}

/// A link the model created (stored on the reply, shown as a card).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedLink {
    pub url: String,
    pub title: String,
    /// `public`, `emails` or `org`.
    pub scope: String,
    #[serde(default)]
    pub recipients: Vec<String>,
    /// RFC 3339, when the server set one.
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// Why a share did not happen, worded for the model.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareFailure {
    pub code: String,
    pub message: String,
}

impl ShareFailure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

const SHARE_BY_HAND: &str = "Do not retry. End your reply with the file's absolute \
     path on its own line (so the app shows the file with its Share button) and tell \
     the user they can share it by hand from that Share button, where they can review it \
     first.";

/// A core refusal before anything was uploaded.
fn refusal(err: &ArtifactError) -> ShareFailure {
    match err {
        ArtifactError::PossibleSecret => ShareFailure::new(
            "possible_secret",
            format!(
                "The file looks like it contains a password, token or key, so it was not shared. {SHARE_BY_HAND}"
            ),
        ),
        ArtifactError::TooLarge => ShareFailure::new(
            "too_large",
            format!("The file is larger than the 8 MB share limit. {SHARE_BY_HAND}"),
        ),
        ArtifactError::UnsupportedType => ShareFailure::new(
            "unsupported_type",
            "This file type cannot be shared (allowed: PDF, PNG, JPEG, WebP, GIF, Markdown, text, CSV, HTML, Word, Excel; the extension must match the content). Do not retry with the same file.",
        ),
        ArtifactError::Empty => ShareFailure::new("empty", "The file is empty."),
        ArtifactError::SourceRefused { .. } => ShareFailure::new(
            "not_shareable",
            "That file cannot be shared: only files this conversation produced or that are inside the user's selected folders (no symlinks, no protected files). Check the path.",
        ),
        ArtifactError::NoSession => ShareFailure::new(
            "no_session",
            "The user's session expired. Ask them to sign in again, then retry.",
        ),
        ArtifactError::Unavailable => ShareFailure::new(
            "unavailable",
            "Sharing links is not available for this account.",
        ),
        ArtifactError::Offline => ShareFailure::new(
            "offline",
            "The share did not complete (network). Tell the user; they can retry later.",
        ),
        ArtifactError::RequestInvalid | ArtifactError::RiskAckRequired => {
            ShareFailure::new("invalid_call", "The share request is not valid.")
        }
    }
}

/// A server error reply, by its `error` code.
fn server_failure(status: u16, body: &serde_json::Value) -> ShareFailure {
    let code = body
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    match (status, code) {
        (_, "recipient_not_member" | "recipient_not_user") => {
            let named: Vec<&str> = body
                .get("emails")
                .and_then(|v| v.as_array())
                .map(|list| list.iter().filter_map(|v| v.as_str()).take(20).collect())
                .unwrap_or_default();
            ShareFailure::new(
                "recipient_not_member",
                if named.is_empty() {
                    "Some recipients cannot receive this link (they must already have an account in the user's organization or community). Ask the user who to share it with.".to_string()
                } else {
                    format!(
                        "These addresses cannot receive this link (no account in the user's organization or community): {}. Ask the user how to proceed.",
                        named.join(", ")
                    )
                },
            )
        }
        (_, "possible_secret") => refusal(&ArtifactError::PossibleSecret),
        (413, _) | (_, "too_large") => refusal(&ArtifactError::TooLarge),
        (415, _) | (_, "unsupported_type") => refusal(&ArtifactError::UnsupportedType),
        (_, "quota_exceeded") => ShareFailure::new(
            "quota_exceeded",
            "The user reached their limit of shared links. They can revoke old ones in Shared links and retry.",
        ),
        (429, _) | (_, "rate_limited") => ShareFailure::new(
            "rate_limited",
            "Too many shares in a short time. Ask the user to retry in a moment.",
        ),
        (401, _) | (_, "session_required") => refusal(&ArtifactError::NoSession),
        (403 | 404, _) | (_, "entitlement_required" | "not_found") => ShareFailure::new(
            "unavailable",
            "Sharing links is not available for this account right now.",
        ),
        _ => ShareFailure::new(
            "server_error",
            "The share could not be created. Tell the user; they can retry later.",
        ),
    }
}

/// Whether a link from the server is safe to hand out and open: an https
/// URL without spaces or control characters, of a sane length.
pub fn is_link(url: &str) -> bool {
    url.len() <= 2048
        && url.starts_with("https://")
        && url.len() > "https://".len()
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The link from a 2xx reply: top-level `url`, else `artifact.url`.
fn link_from(
    response: &artifacts::ArtifactResponse,
    req: &ShareRequest,
    filename: &str,
) -> Result<SharedLink, ShareFailure> {
    if !(200..300).contains(&response.status) {
        return Err(server_failure(response.status, &response.body));
    }
    let artifact = response.body.get("artifact");
    let url = response
        .body
        .get("url")
        .and_then(|v| v.as_str())
        .or_else(|| artifact.and_then(|a| a.get("url")).and_then(|v| v.as_str()))
        .filter(|url| is_link(url))
        .ok_or_else(|| {
            ShareFailure::new(
                "server_error",
                "The link was created but the reply had no usable URL. The user can find it in Shared links.",
            )
        })?;
    let text = |key: &str| {
        artifact
            .and_then(|a| a.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    Ok(SharedLink {
        url: url.to_string(),
        // Shown on the link card: neutralized like the approval text.
        title: display_safe(&text("title").unwrap_or_else(|| {
            if req.title.is_empty() {
                filename.to_string()
            } else {
                req.title.clone()
            }
        })),
        scope: req.audience.clone(),
        recipients: req.emails.clone(),
        expires_at: text("expires_at"),
    })
}

/// The tool message for the model.
pub fn result_for_model(result: &Result<SharedLink, ShareFailure>) -> String {
    match result {
        Ok(link) => {
            let who = match link.scope.as_str() {
                "public" => "anyone with the link".to_string(),
                "org" => "every member of the organization".to_string(),
                _ => link.recipients.join(", "),
            };
            serde_json::json!({
                "ok": true,
                "url": link.url,
                "title": link.title,
                "audience": link.scope,
                "who_can_open": who,
                "expires_at": link.expires_at,
                "summary": "Shared. Give the user this link and say who can open it and when it expires. The link also appears in Shared links in the app.",
            })
            .to_string()
        }
        Err(failure) if failure.code == "declined" => serde_json::json!({
            "ok": false,
            "error": "declined",
            "message": "The user did not allow this share. Do not retry; ask them how to proceed."
        })
        .to_string(),
        Err(failure) => serde_json::json!({
            "ok": false,
            "error": failure.code,
            "message": failure.message,
        })
        .to_string(),
    }
}

/// The native dialog copy (Spanish UI, like `confirmation_text`).
pub fn confirmation_text(ask: &ShareAsk) -> (String, String) {
    let file = match ask.source.as_str() {
        "website" => format!("La web creada en esta conversación: {}", ask.location),
        "conversation" => format!("Un archivo creado en esta conversación: {}", ask.location),
        "generated" => format!("Una imagen generada en la app: {}", ask.location),
        _ => ask.location.clone(),
    };
    let who = match ask.audience.as_str() {
        "public" => "Con: cualquiera que tenga el enlace (enlace público)".to_string(),
        "org" => "Con: todas las personas de tu organización".to_string(),
        _ => format!(
            "Con: {}{}",
            ask.recipients.join(", "),
            if ask.notify {
                " (les llegará el enlace por correo)"
            } else {
                ""
            }
        ),
    };
    let expiry = match ask.expires_days {
        0 => "Caduca: nunca".to_string(),
        1 => "Caduca: en 1 día".to_string(),
        n => format!("Caduca: en {n} días"),
    };
    let risk = match ask.risk.as_deref() {
        Some("public") => {
            "\n\nCualquiera con este enlace podrá abrir el archivo sin iniciar sesión. Se puede \
             reenviar e indexar. Si lo permites, aceptas este riesgo."
        }
        Some(_) => {
            "\n\nEstas personas podrán abrir el archivo iniciando sesión con su cuenta. Si lo \
             permites, confirmas que puedes compartir este contenido con ellas."
        }
        None => "",
    };
    (
        "Compartir un archivo".into(),
        format!(
            "El asistente quiere COMPARTIR este archivo como enlace:\n\n{file}\n\nTítulo: {}\n{who}\n{expiry}{risk}\n\n¿Se lo permites?",
            ask.title
        ),
    )
}

/// Everything one share needs besides the request.
pub(crate) struct ShareEnv<'a> {
    /// The realm folder (tools store + audit log).
    pub realm_dir: &'a Path,
    /// The app data ROOT (protection + generated images).
    pub app_data: &'a Path,
    pub home: Option<&'a Path>,
    pub profile_id: &'a str,
    pub conversation_id: i64,
    /// THIS conversation's session temp folder (canonical), when it exists.
    pub scratch: Option<&'a Path>,
    pub base: &'a str,
    pub session_token: &'a str,
}

/// Whether `c` could rewrite how the approval text reads: a control
/// character (newlines, tabs...), a line/paragraph separator, or an
/// invisible format/bidi control (LRM/RLM, ALM, embeddings and overrides
/// U+202A..U+202E, isolates U+2066..U+2069, zero-width, BOM, soft hyphen,
/// interlinear annotations, tag characters, Hangul fillers, variation
/// selectors).
fn misleading_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{034F}'
                | '\u{061C}'
                | '\u{115F}'
                | '\u{1160}'
                | '\u{17B4}'
                | '\u{17B5}'
                | '\u{180B}'..='\u{180F}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{206F}'
                | '\u{3164}'
                | '\u{FE00}'..='\u{FE0F}'
                | '\u{FEFF}'
                | '\u{FFA0}'
                | '\u{FFF9}'..='\u{FFFB}'
                | '\u{E0000}'..='\u{E0FFF}'
        )
}

/// Text from a file name, a path or the model, made safe to show on the
/// approval card and in the native dialog: every [`misleading_char`]
/// becomes U+FFFD, so a name like `x.pdf\n\nCon: solo tu organización`
/// cannot fake a line, and a right-to-left override cannot flip `fdp.exe`
/// into `exe.pdf`. Pure.
/// Runs of other whitespace (including U+00A0 and U+3000) collapse to one
/// space, so padding cannot push text out of view.
pub fn display_safe(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if misleading_char(c) {
            out.push('\u{FFFD}');
            space = false;
        } else if c.is_whitespace() {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

/// A Windows verbatim path (`\\?\C:\x`, `\\?\UNC\srv\share\x`, what
/// `fs::canonicalize` returns there) in its everyday form (`C:\x`,
/// `\\srv\share\x`), so the approval shows the path the user knows and
/// it compares with the plain home and temp folders. Other paths unchanged.
pub fn without_verbatim_prefix(path: &Path) -> std::path::PathBuf {
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    match raw.strip_prefix(r"\\?\") {
        Some(rest) => std::path::PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

/// Where a file is, for the approval: see [`ShareAsk::source`]. `canonical`
/// is the resolved path; the home folder is shown as `~`. Pure.
pub fn location_of(
    canonical: &Path,
    home: Option<&Path>,
    scratch: Option<&Path>,
    generated: bool,
) -> (String, String) {
    let canonical = &without_verbatim_prefix(canonical);
    let home = home.map(without_verbatim_prefix);
    let home = home.as_deref();
    let scratch = scratch.map(without_verbatim_prefix);
    let scratch = scratch.as_deref();
    let name = canonical
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if generated {
        return ("generated".into(), name);
    }
    if scratch.is_some_and(|dir| super::grants::is_under(dir, canonical)) {
        let website = name.starts_with("website-") && name.ends_with(".html");
        return (
            if website { "website" } else { "conversation" }.into(),
            name,
        );
    }
    let shown = match home.and_then(|home| canonical.strip_prefix(home).ok()) {
        Some(rest) if !rest.as_os_str().is_empty() => {
            format!("~{}{}", std::path::MAIN_SEPARATOR, rest.display())
        }
        _ => canonical.display().to_string(),
    };
    ("folder".into(), shown)
}

/// The most share questions one reply may ask (approval fatigue).
pub const MAX_ASKS_PER_TURN: u8 = 3;

/// One reply's shares: the links created (shown under it) and how many
/// times it asked. After a "no" it stops asking until the next message.
#[derive(Debug, Default)]
pub struct ShareTurn {
    pub links: Vec<SharedLink>,
    asks: u8,
    declined: bool,
}

/// Whether a `share_artifact` call may run now. Pure.
/// - not offered this reply (artifacts off): refused;
/// - the user already declined a share in this reply: refused;
/// - [`MAX_ASKS_PER_TURN`] questions already asked: refused.
pub fn gate(offered: bool, turn: &ShareTurn) -> Result<(), ShareFailure> {
    if !offered {
        return Err(ShareFailure::new(
            "invalid_call",
            "share_artifact is not available in this conversation",
        ));
    }
    if turn.declined {
        return Err(ShareFailure::new(
            "declined",
            "the user declined a share in this reply",
        ));
    }
    if turn.asks >= MAX_ASKS_PER_TURN {
        return Err(ShareFailure::new(
            "too_many_shares",
            format!(
                "At most {MAX_ASKS_PER_TURN} share requests per reply. Do not retry now; tell \
                 the user what is left to share and let them ask again."
            ),
        ));
    }
    Ok(())
}

/// Record one call's result in the turn (a created link is kept for the
/// reply) and return the tool message for the model.
pub fn record(turn: &mut ShareTurn, result: &Result<SharedLink, ShareFailure>) -> String {
    if let Ok(link) = result {
        turn.links.push(link.clone());
    }
    result_for_model(result)
}

/// The store a model share reads from: the conversation's effective grants
/// plus THIS conversation's temp folder (its websites), read-only. Never the
/// whole session root: conversation A cannot share B's temp files. Pure.
pub fn share_store(
    mut store: GrantsStore,
    profile_id: &str,
    conversation_id: i64,
    scratch: Option<&Path>,
) -> GrantsStore {
    if let Some(dir) = scratch {
        let grant = super::scratch_grant(profile_id, conversation_id, dir.to_path_buf());
        if !store.grants.iter().any(|g| g.id == grant.id) {
            store.grants.push(grant);
        }
    }
    store
}

/// Which source a path is: an image this app generated, else a file that
/// must be inside `store`.
fn source_for(app_data: &Path, path: &str) -> ShareSource {
    let kind = if crate::images::verify_generated_image(app_data, Path::new(path)).is_ok() {
        "media"
    } else {
        "file"
    };
    ShareSource {
        kind: kind.into(),
        path: path.to_string(),
    }
}

/// Whether a computer-wide grant governs `path` in `store` (then the share
/// asks through the native dialog the renderer cannot fake).
fn governed_by_computer_wide(store: &GrantsStore, profile_id: &str, path: &str) -> bool {
    super::grants::resolve_under_grant(store, profile_id, path)
        .ok()
        .and_then(|(id, _)| {
            store
                .grant_by_id(&id)
                .map(|g| g.scope == GrantScope::ComputerWide)
        })
        .unwrap_or(false)
}

/// Read and check the file, ask the user, and only then upload. The
/// `risk_ack` the server needs is held back from the prepared upload and
/// put back ONLY after the user's yes.
pub(crate) async fn share_in<A: Approver>(
    store: &GrantsStore,
    env: &ShareEnv<'_>,
    approver: &A,
    request: &ShareRequest,
    turn: &mut ShareTurn,
) -> Result<SharedLink, ShareFailure> {
    gate(true, turn)?;
    let risk = request.risk(env.profile_id);
    let source = source_for(env.app_data, &request.path);
    let mut upload: Upload = artifacts::prepare_upload(
        store,
        env.profile_id,
        &source,
        request.meta(risk),
        env.app_data,
        env.home,
    )
    .map_err(|err| refusal(&err))?;
    // Not acknowledged yet: the user has not seen the card.
    let held_ack = upload.meta.risk_ack.take();

    let file_name = artifacts::sanitize_filename(&request.path);
    let canonical = std::fs::canonicalize(&request.path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&request.path));
    let (source_kind, location) =
        location_of(&canonical, env.home, env.scratch, source.kind == "media");
    // Everything a file system or the model controls is neutralized before
    // it reaches the card or the dialog.
    let ask = ShareAsk {
        file_name: display_safe(&file_name),
        source: source_kind,
        location: display_safe(&location),
        title: display_safe(&upload.meta.title),
        audience: request.audience.clone(),
        recipients: upload.meta.emails.clone(),
        expires_days: upload.meta.expires_days,
        notify: upload.meta.notify,
        risk: risk.map(str::to_string),
    };
    let (title, text) = confirmation_text(&ask);
    turn.asks = turn.asks.saturating_add(1);
    let granted = if governed_by_computer_wide(store, env.profile_id, &request.path) {
        let granted = approver.native(title, text).await;
        let request = approval_request(
            env.conversation_id,
            &request.path,
            ask,
            String::new(),
            String::new(),
        );
        approver.native_decided(&request, granted);
        granted
    } else {
        approver
            .inline(approval_request(
                env.conversation_id,
                &request.path,
                ask,
                title,
                text,
            ))
            .await
    };
    audit_decision(env, granted);
    if !granted {
        turn.declined = true;
        return Err(ShareFailure::new(
            "declined",
            "the user did not allow this share",
        ));
    }
    upload.meta.risk_ack = held_ack;
    let response = artifacts::send_upload(env.base, env.session_token, upload)
        .await
        .map_err(|err| refusal(&err))?;
    link_from(&response, request, &file_name)
}

fn approval_request(
    conversation_id: i64,
    path: &str,
    ask: ShareAsk,
    title: String,
    text: String,
) -> super::ApprovalRequest {
    super::ApprovalRequest {
        approval_id: String::new(),
        conversation_id: Some(conversation_id),
        action: TOOL_NAME.to_string(),
        summary: format!("Share {} as a link", ask.file_name),
        title,
        text,
        // The card names the file by `share.location`; the raw path the
        // model sent stays for the record.
        path: Some(path.to_string()),
        dest_path: None,
        command: None,
        diff_preview: None,
        permanent: false,
        expires_in_secs: super::PROPOSAL_TTL.as_secs(),
        after_browsing: false,
        share: Some(ask),
    }
}

/// Audit the user's decision: the scope only, never the file, the
/// recipients or a link. Best-effort.
fn audit_decision(env: &ShareEnv<'_>, granted: bool) {
    let _ = audit::append(
        env.realm_dir,
        &AuditEntry {
            ts: audit::timestamp_now_rfc3339(),
            event: if granted { "approve" } else { "deny" }.into(),
            action: TOOL_NAME.into(),
            outcome: "ok".into(),
            grant_id: None,
            profile_id: Some(env.profile_id.to_string()),
            detail: None,
        },
    );
}

/// [`share_in`] against the running app, for one model tool call.
pub(crate) async fn run_model_share(
    app: &tauri::AppHandle,
    profile_id: &str,
    conversation_id: i64,
    arguments: &str,
    turn: &mut ShareTurn,
) -> Result<SharedLink, ShareFailure> {
    use tauri::Manager as _;
    gate(true, turn)?;
    let request = parse_request(profile_id, arguments)
        .map_err(|message| ShareFailure::new("invalid_call", message))?;
    let unavailable = || refusal(&ArtifactError::Unavailable);
    let base = crate::device_flow::platform_base(profile_id).ok_or_else(unavailable)?;
    let token = crate::chat::read_session_token(profile_id)
        .ok_or_else(|| refusal(&ArtifactError::NoSession))?;
    let app_data = app.path().app_data_dir().map_err(|_| unavailable())?;
    let realm_dir = super::data_dir(app).map_err(|_| unavailable())?;
    // The conversation's own folders (its selection), plus THIS
    // conversation's temp folder (websites the assistant built here).
    let (store, scratch) = {
        let state = app.state::<super::ToolsState>();
        let scratch = std::fs::canonicalize(state.scratch_dir(conversation_id)).ok();
        let store = super::load_store(&realm_dir).map_err(|_| unavailable())?;
        let store = super::effective_store(&store, &state, profile_id, Some(conversation_id))
            .map_err(|_| unavailable())?;
        (
            share_store(store, profile_id, conversation_id, scratch.as_deref()),
            scratch,
        )
    };
    let home = std::env::home_dir();
    let env = ShareEnv {
        realm_dir: &realm_dir,
        app_data: &app_data,
        home: home.as_deref(),
        profile_id,
        conversation_id,
        scratch: scratch.as_deref(),
        base: &base,
        session_token: &token,
    };
    let approver = super::AppApprover { app: app.clone() };
    share_in(&store, &env, &approver, &request, turn).await
}

// ---------------------------------------------------------------- tests --

#[cfg(test)]
mod tests {

    #[test]
    fn windows_verbatim_paths_are_shown_in_their_everyday_form() {
        assert_eq!(
            without_verbatim_prefix(Path::new(r"\\?\C:\Users\ana\plan.pdf")),
            PathBuf::from(r"C:\Users\ana\plan.pdf")
        );
        assert_eq!(
            without_verbatim_prefix(Path::new(r"\\?\UNC\srv\share\plan.pdf")),
            PathBuf::from(r"\\srv\share\plan.pdf")
        );
        assert_eq!(
            without_verbatim_prefix(Path::new("/Users/ana/plan.pdf")),
            PathBuf::from("/Users/ana/plan.pdf")
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_verbatim_canonical_path_still_shows_home_as_tilde() {
        let (kind, shown) = location_of(
            Path::new(r"\\?\C:\Users\ana\docs\plan.pdf"),
            Some(Path::new(r"C:\Users\ana")),
            None,
            false,
        );
        assert_eq!(kind, "folder");
        assert_eq!(shown, r"~\docs\plan.pdf");
    }
    use super::*;
    use crate::tools::grants::{self, ApprovalMode};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const NAN: &str = "nan";
    const HELMCODE: &str = "helmcode";
    const TOKEN: &str = "jwt-canary-ZZ9";
    const LINK: &str = "https://artifacts.helmcode.com/a/tok-CANARY";

    /// An absolute path on every platform ("/x/a.pdf" is not absolute on
    /// Windows); parsing never touches the disk.
    fn abs() -> String {
        std::env::temp_dir().join("a.pdf").display().to_string()
    }

    fn args(json: serde_json::Value) -> String {
        json.to_string()
    }

    // ------------------------------------------------ arguments --

    #[test]
    fn audiences_follow_the_profile() {
        let call = |profile: &str, audience: &str| {
            parse_request(
                profile,
                &args(serde_json::json!({ "path": abs(), "audience": audience })),
            )
        };
        assert!(call(NAN, "public").is_ok());
        assert!(call(HELMCODE, "public").is_ok());
        assert!(call(HELMCODE, "org").is_ok());
        assert!(call(NAN, "org").is_err(), "the community has no org");
        assert!(call(HELMCODE, "members").is_err(), "members stays manual");
        assert!(call(NAN, "everyone").is_err());
        assert!(call(HELMCODE, "ORG").is_ok(), "case-insensitive");

        let names = |profile: &str| {
            tool_definition(profile)["function"]["parameters"]["properties"]["audience"]["enum"]
                .clone()
        };
        assert_eq!(names(NAN), serde_json::json!(["public", "emails"]));
        assert_eq!(
            names(HELMCODE),
            serde_json::json!(["public", "emails", "org"])
        );
        assert_eq!(tool_definition(NAN)["function"]["name"], TOOL_NAME);
    }

    #[test]
    fn emails_are_validated_normalized_and_capped() {
        let call = |json: serde_json::Value| parse_request(NAN, &args(json));
        let ok = call(serde_json::json!({
            "path": abs(), "audience": "emails",
            "emails": [" Ana@Acme.com ", "ana@acme.com", "bo@acme.io"]
        }))
        .expect("ok");
        assert_eq!(ok.emails, vec!["ana@acme.com", "bo@acme.io"]);
        assert!(ok.notify, "emails notify by default");
        assert_eq!(ok.expires_days, 30);

        let quiet = call(serde_json::json!({
            "path": abs(), "audience": "emails", "emails": ["a@b.co"], "notify": false
        }))
        .expect("ok");
        assert!(!quiet.notify);

        let bad = call(serde_json::json!({
            "path": abs(), "audience": "emails", "emails": ["not-an-email"]
        }))
        .expect_err("bad");
        assert!(bad.contains("not-an-email"));
        assert!(call(serde_json::json!({ "path": abs(), "audience": "emails" })).is_err());
        assert!(
            call(serde_json::json!({ "path": abs(), "audience": "emails", "emails": [] })).is_err()
        );
        let many: Vec<String> = (0..21).map(|i| format!("u{i}@acme.com")).collect();
        assert!(
            call(serde_json::json!({ "path": abs(), "audience": "emails", "emails": many }))
                .is_err()
        );
        assert!(
            call(serde_json::json!({ "path": abs(), "audience": "public", "emails": ["a@b.co"] }))
                .is_err(),
            "a public link names nobody"
        );
        let public =
            call(serde_json::json!({ "path": abs(), "audience": "public", "notify": true }))
                .expect("ok");
        assert!(!public.notify, "notify only travels with recipients");
    }

    #[test]
    fn expiry_defaults_and_options_follow_the_server() {
        let call = |profile: &str, json: serde_json::Value| parse_request(profile, &args(json));
        let days = |profile: &str, audience: &str, d: Option<i64>| {
            let mut json = serde_json::json!({ "path": abs(), "audience": audience });
            if audience == "emails" {
                json["emails"] = serde_json::json!(["a@b.co"]);
            }
            if let Some(d) = d {
                json["expires_days"] = d.into();
            }
            call(profile, json).map(|r| r.expires_days)
        };
        assert_eq!(days(NAN, "public", None), Ok(7));
        assert_eq!(days(HELMCODE, "org", None), Ok(90));
        assert_eq!(
            days(HELMCODE, "org", Some(0)),
            Ok(0),
            "org may never expire"
        );
        assert!(
            days(NAN, "public", Some(0)).is_err(),
            "public always expires"
        );
        assert!(days(NAN, "public", Some(90)).is_err());
        assert_eq!(days(NAN, "emails", Some(90)), Ok(90));
        assert!(days(NAN, "emails", Some(-1)).is_err());
        assert!(days(NAN, "emails", Some(5)).is_err());
    }

    #[test]
    fn the_model_cannot_pass_acks_members_or_relative_paths() {
        for extra in [
            serde_json::json!({ "risk_ack": { "kind": "public", "version": artifacts::RISK_VERSION } }),
            serde_json::json!({ "secret_ack": true }),
            serde_json::json!({ "member_ids": ["u1"] }),
            serde_json::json!({ "scope": "public" }),
        ] {
            let mut json = serde_json::json!({ "path": abs(), "audience": "public" });
            for (k, v) in extra.as_object().expect("obj") {
                json[k] = v.clone();
            }
            assert!(
                parse_request(NAN, &args(json)).is_err(),
                "unknown field refused"
            );
        }
        assert!(
            parse_request(
                NAN,
                &args(serde_json::json!({ "path": "a.pdf", "audience": "public" }))
            )
            .is_err()
        );
        assert!(
            parse_request(
                NAN,
                &args(serde_json::json!({ "path": "  ", "audience": "public" }))
            )
            .is_err()
        );
        assert!(parse_request(NAN, "not json").is_err());
        assert!(parse_request(NAN, "").is_err());
    }

    #[test]
    fn titles_are_trimmed_and_capped() {
        let long = "x".repeat(300);
        let r = parse_request(
            NAN,
            &args(serde_json::json!({
                "path": abs(), "audience": "public", "title": format!("  Mi \n web {long}")
            })),
        )
        .expect("ok");
        assert!(r.title.starts_with("Mi web x"));
        assert_eq!(r.title.chars().count(), artifacts::MAX_TITLE_CHARS);
    }

    #[test]
    fn risk_per_audience_and_profile() {
        let req = |audience: &str| ShareRequest {
            path: abs(),
            title: String::new(),
            audience: audience.into(),
            emails: vec![],
            expires_days: 7,
            notify: false,
        };
        assert_eq!(req("public").risk(NAN), Some("public"));
        assert_eq!(req("public").risk(HELMCODE), Some("public"));
        assert_eq!(req("emails").risk(NAN), Some("external"));
        assert_eq!(req("emails").risk(HELMCODE), None, "org members only");
        assert_eq!(req("org").risk(HELMCODE), None);
    }

    #[test]
    fn a_refusal_asks_the_model_to_surface_the_file_chip() {
        for err in [ArtifactError::PossibleSecret, ArtifactError::TooLarge] {
            let text = result_for_model(&Err(refusal(&err)));
            assert!(text.contains("absolute path on its own line"), "{text}");
            assert!(text.contains("Share button"), "{text}");
        }
        assert!(GUIDANCE.contains("absolute path on its own line"));
    }

    #[test]
    fn the_offer_follows_the_wire_value() {
        assert_eq!(ShareOffer::from_wire(Some("on")), ShareOffer::On);
        assert_eq!(ShareOffer::from_wire(Some("paywall")), ShareOffer::Paywall);
        assert_eq!(ShareOffer::from_wire(Some("off")), ShareOffer::Off);
        assert_eq!(ShareOffer::from_wire(None), ShareOffer::Off);
        assert_eq!(ShareOffer::On.guidance(), Some(GUIDANCE));
        assert_eq!(ShareOffer::Paywall.guidance(), Some(PAYWALL_HINT));
        assert!(
            !PAYWALL_HINT.contains(TOOL_NAME),
            "no tool is mentioned behind the paywall"
        );
        assert_eq!(ShareOffer::Off.guidance(), None);
    }

    #[test]
    fn guidance_covers_the_flow() {
        for needle in [
            "share_artifact",
            "public",
            "emails",
            "always shows its own confirmation card",
            "Share button",
            "Never invent addresses",
            "Do not ask the user to confirm in the chat",
            "ask who before sharing",
        ] {
            assert!(GUIDANCE.contains(needle), "{needle}");
        }
    }

    // ------------------------------------------------ the flow --

    struct Layout {
        _guard: tempfile::TempDir,
        app_data: PathBuf,
        realm: PathBuf,
        home: PathBuf,
        grant: PathBuf,
        outside: PathBuf,
    }

    fn layout() -> Layout {
        let guard = tempfile::tempdir().expect("tempdir");
        let base = fs::canonicalize(guard.path()).expect("canon");
        let home = base.join("home");
        let grant = home.join("proj");
        let app_data = home.join("app-data");
        let realm = app_data.join("realm");
        let outside = base.join("outside");
        for dir in [
            &grant,
            &app_data,
            &realm,
            &outside,
            &crate::images::images_dir(&app_data),
        ] {
            fs::create_dir_all(dir).expect("mkdir");
        }
        Layout {
            _guard: guard,
            app_data,
            realm,
            home,
            grant,
            outside,
        }
    }

    fn store(l: &Layout, profile: &str, mode: ApprovalMode) -> GrantsStore {
        let mut store = grants::default_store();
        store
            .add_grant(
                "g0".into(),
                profile,
                l.grant.clone(),
                "2026-11-18T00:00:00Z".into(),
            )
            .expect("grant");
        store.set_mode("g0", mode).expect("mode");
        store
    }

    fn computer_wide(l: &Layout, profile: &str) -> GrantsStore {
        let mut store = grants::default_store();
        store.add_computer_wide_grant(
            "cw".into(),
            profile,
            l.home.clone(),
            "2026-11-18T00:00:00Z".into(),
            ApprovalMode::Allow,
        );
        store
    }

    /// Records every ask; answers with `answer`.
    struct Fake {
        answer: bool,
        inline: Mutex<Vec<crate::tools::ApprovalRequest>>,
        native: Mutex<Vec<(String, String)>>,
    }

    impl Fake {
        fn new(answer: bool) -> Self {
            Self {
                answer,
                inline: Mutex::new(vec![]),
                native: Mutex::new(vec![]),
            }
        }
    }

    impl Approver for Fake {
        fn native(
            &self,
            title: String,
            text: String,
        ) -> impl std::future::Future<Output = bool> + Send {
            self.native.lock().unwrap().push((title, text));
            let answer = self.answer;
            async move { answer }
        }
        fn inline(
            &self,
            request: crate::tools::ApprovalRequest,
        ) -> impl std::future::Future<Output = bool> + Send {
            self.inline.lock().unwrap().push(request);
            let answer = self.answer;
            async move { answer }
        }
    }

    fn env<'a>(l: &'a Layout, profile: &'a str, base: &'a str) -> ShareEnv<'a> {
        ShareEnv {
            realm_dir: &l.realm,
            app_data: &l.app_data,
            home: Some(&l.home),
            profile_id: profile,
            conversation_id: 7,
            scratch: None,
            base,
            session_token: TOKEN,
        }
    }

    fn request(path: &Path, json: serde_json::Value, profile: &str) -> ShareRequest {
        let mut json = json;
        json["path"] = path.display().to_string().into();
        parse_request(profile, &json.to_string()).expect("valid")
    }

    fn block<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn created(scope: &str) -> String {
        serde_json::json!({
            "artifact": { "id": "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e", "title": "Informe", "scope": scope,
                          "expires_at": "2026-11-25T10:00:00Z", "url": LINK },
            "url": LINK
        })
        .to_string()
    }

    /// The multipart `meta` part of a raw request.
    fn meta_part(raw: &[u8]) -> serde_json::Value {
        let text = String::from_utf8_lossy(raw);
        let start = text.find("name=\"meta\"").expect("meta part");
        let body = &text[start..];
        let json_start = body.find("\r\n\r\n").expect("headers") + 4;
        let json_end = body[json_start..].find("\r\n--").expect("end") + json_start;
        serde_json::from_str(&body[json_start..json_end]).expect("json")
    }

    #[test]
    fn a_public_share_asks_inline_then_uploads_with_the_ack() {
        let l = layout();
        let path = l.grant.join("informe.pdf");
        fs::write(&path, b"%PDF-1.7 report").expect("write");
        let (base, server) = crate::artifacts::tests::mock_server(201, created("public"));
        // Even a folder in allow mode asks: a share is never automatic.
        let store = store(&l, NAN, ApprovalMode::Allow);
        let fake = Fake::new(true);
        let req = request(
            &path,
            serde_json::json!({ "audience": "public", "title": "Informe" }),
            NAN,
        );
        let link = block(share_in(
            &store,
            &env(&l, NAN, &base),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ))
        .expect("shared");
        assert_eq!(link.url, LINK);
        assert_eq!(link.scope, "public");
        assert_eq!(link.expires_at.as_deref(), Some("2026-11-25T10:00:00Z"));

        let asked = fake.inline.lock().unwrap().clone();
        assert_eq!(asked.len(), 1, "exactly one card");
        assert!(fake.native.lock().unwrap().is_empty());
        let card = &asked[0];
        assert_eq!(card.action, TOOL_NAME);
        assert_eq!(card.conversation_id, Some(7));
        let ask = card.share.as_ref().expect("share details");
        assert_eq!(ask.file_name, "informe.pdf");
        assert_eq!(ask.audience, "public");
        assert_eq!(ask.expires_days, 7);
        assert_eq!(ask.risk.as_deref(), Some("public"));
        assert!(card.text.contains("cualquiera"), "{}", card.text);

        let raw = server.join().expect("server");
        let head = String::from_utf8_lossy(&raw);
        assert!(head.starts_with("POST /api/artifacts "));
        assert!(
            head.contains(&format!("Bearer {TOKEN}")) || head.contains(&format!("bearer {TOKEN}"))
        );
        let meta = meta_part(&raw);
        assert_eq!(meta["scope"], "public");
        assert_eq!(meta["expires_days"], 7);
        assert_eq!(meta["risk_ack"]["kind"], "public");
        assert_eq!(meta["risk_ack"]["version"], artifacts::RISK_VERSION);
        assert!(
            meta.get("secret_ack").is_none(),
            "the tool never acks a secret"
        );

        let model = result_for_model(&Ok(link));
        assert!(model.contains(LINK));
        assert!(model.contains("anyone with the link"));
    }

    #[test]
    fn a_declined_share_never_reaches_the_network() {
        let l = layout();
        let path = l.grant.join("informe.pdf");
        fs::write(&path, b"%PDF-1.7 report").expect("write");
        let fake = Fake::new(false);
        let req = request(&path, serde_json::json!({ "audience": "public" }), NAN);
        // Port 9 (discard): any upload attempt would fail as `offline`.
        let err = block(share_in(
            &store(&l, NAN, ApprovalMode::Allow),
            &env(&l, NAN, "http://127.0.0.1:9"),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ))
        .expect_err("declined");
        assert_eq!(err.code, "declined");
        assert_eq!(fake.inline.lock().unwrap().len(), 1);
        let model = result_for_model(&Err(err));
        assert!(model.contains("\"declined\"") && model.contains("Do not retry"));
        let audit = fs::read_to_string(l.realm.join(audit::AUDIT_FILE)).unwrap_or_default();
        assert!(
            audit.contains("share_artifact") && audit.contains("deny"),
            "{audit}"
        );
        assert!(!audit.contains("informe"), "the audit never names the file");
    }

    #[test]
    fn without_the_users_ack_the_contract_fails_closed() {
        let l = layout();
        let path = l.grant.join("informe.pdf");
        fs::write(&path, b"%PDF-1.7 report").expect("write");
        let req = request(&path, serde_json::json!({ "audience": "public" }), NAN);
        // The prepared upload carries the ack only as the request's intent;
        // `share_in` takes it out before asking and puts it back only on a
        // yes (a "no" sends nothing: `a_declined_share_never_reaches_the_network`).
        let upload = artifacts::prepare_upload(
            &store(&l, NAN, ApprovalMode::Ask),
            NAN,
            &source_for(&l.app_data, &req.path),
            req.meta(req.risk(NAN)),
            &l.app_data,
            Some(&l.home),
        )
        .expect("prepared");
        assert!(upload.meta.risk_ack.is_some());
        // Without the user's ack the server contract fails closed.
        let mut no_ack = req.meta(None);
        no_ack.title = "x".into();
        assert_eq!(
            artifacts::checked_meta(NAN, no_ack, "informe.pdf").expect_err("needs ack"),
            ArtifactError::RiskAckRequired
        );
    }

    #[test]
    fn community_emails_carry_the_external_ack_and_enterprise_emails_none() {
        let l = layout();
        let path = l.grant.join("notas.md");
        fs::write(&path, b"# Notas\nhola\n").expect("write");

        let (base, server) = crate::artifacts::tests::mock_server(201, created("emails"));
        let fake = Fake::new(true);
        let req = request(
            &path,
            serde_json::json!({ "audience": "emails", "emails": ["ana@acme.com"] }),
            NAN,
        );
        block(share_in(
            &store(&l, NAN, ApprovalMode::Ask),
            &env(&l, NAN, &base),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ))
        .expect("ok");
        let meta = meta_part(&server.join().expect("server"));
        assert_eq!(meta["risk_ack"]["kind"], "external");
        assert_eq!(meta["emails"], serde_json::json!(["ana@acme.com"]));
        assert_eq!(meta["notify"], true);
        let ask = fake.inline.lock().unwrap()[0].share.clone().expect("ask");
        assert_eq!(ask.recipients, vec!["ana@acme.com"]);
        assert_eq!(ask.risk.as_deref(), Some("external"));

        let (base, server) = crate::artifacts::tests::mock_server(201, created("org"));
        let fake = Fake::new(true);
        let req = request(&path, serde_json::json!({ "audience": "org" }), HELMCODE);
        block(share_in(
            &store(&l, HELMCODE, ApprovalMode::Ask),
            &env(&l, HELMCODE, &base),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ))
        .expect("ok");
        let meta = meta_part(&server.join().expect("server"));
        assert_eq!(meta["scope"], "org");
        assert_eq!(meta["expires_days"], 90);
        assert!(meta.get("risk_ack").is_none());
        assert_eq!(
            fake.inline.lock().unwrap()[0]
                .share
                .as_ref()
                .expect("ask")
                .risk,
            None
        );
    }

    #[test]
    fn a_computer_wide_file_asks_through_the_native_dialog() {
        let l = layout();
        let path = l.grant.join("informe.pdf");
        fs::write(&path, b"%PDF-1.7 report").expect("write");
        let (base, server) = crate::artifacts::tests::mock_server(201, created("public"));
        let fake = Fake::new(true);
        let req = request(&path, serde_json::json!({ "audience": "public" }), NAN);
        block(share_in(
            &computer_wide(&l, NAN),
            &env(&l, NAN, &base),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ))
        .expect("ok");
        server.join().expect("server");
        assert!(fake.inline.lock().unwrap().is_empty());
        let native = fake.native.lock().unwrap().clone();
        assert_eq!(native.len(), 1, "allow mode never skips the question");
        assert!(native[0].1.contains("informe.pdf"));
        assert!(native[0].1.contains("Caduca: en 7 días"));
    }

    #[test]
    fn files_outside_the_conversation_folders_are_refused_without_asking() {
        let l = layout();
        let path = l.outside.join("secreto.pdf");
        fs::write(&path, b"%PDF-1.7 x").expect("write");
        let fake = Fake::new(true);
        let req = request(&path, serde_json::json!({ "audience": "public" }), NAN);
        let err = block(share_in(
            &store(&l, NAN, ApprovalMode::Allow),
            &env(&l, NAN, "http://127.0.0.1:9"),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ))
        .expect_err("outside");
        assert_eq!(err.code, "not_shareable");
        assert!(fake.inline.lock().unwrap().is_empty() && fake.native.lock().unwrap().is_empty());
    }

    #[test]
    fn secrets_unsupported_and_oversized_files_go_back_to_the_manual_share() {
        let l = layout();
        let secret = l.grant.join("config.md");
        fs::write(&secret, "# cfg\nkey sk-hke_CANARYCANARYCANARY123\n").expect("write");
        let exe = l.grant.join("tool.exe");
        fs::write(&exe, b"MZ\x90\x00binary").expect("write");
        let big = l.grant.join("big.txt");
        fs::write(
            &big,
            vec![b'a'; (artifacts::MAX_ARTIFACT_BYTES + 1) as usize],
        )
        .expect("write");
        for (path, code) in [
            (&secret, "possible_secret"),
            (&exe, "unsupported_type"),
            (&big, "too_large"),
        ] {
            let fake = Fake::new(true);
            let req = request(path, serde_json::json!({ "audience": "public" }), NAN);
            let err = block(share_in(
                &store(&l, NAN, ApprovalMode::Allow),
                &env(&l, NAN, "http://127.0.0.1:9"),
                &fake,
                &req,
                &mut ShareTurn::default(),
            ))
            .expect_err(code);
            assert_eq!(err.code, code);
            assert!(
                fake.inline.lock().unwrap().is_empty(),
                "{code}: nothing asked"
            );
            let model = result_for_model(&Err(err));
            assert!(!model.contains("CANARY"), "never echoes content");
        }
        let model = result_for_model(&Err(refusal(&ArtifactError::PossibleSecret)));
        assert!(model.contains("Share button") && model.contains("Do not retry"));
    }

    #[test]
    fn a_generated_image_is_shareable() {
        let l = layout();
        let image =
            crate::images::images_dir(&l.app_data).join("0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e.png");
        fs::write(&image, b"\x89PNG\r\n\x1a\nrest").expect("write");
        assert_eq!(
            source_for(&l.app_data, &image.display().to_string()).kind,
            "media"
        );
        assert_eq!(
            source_for(&l.app_data, &l.grant.join("a.png").display().to_string()).kind,
            "file"
        );
    }

    #[test]
    fn server_errors_become_clear_model_messages() {
        let body = serde_json::json!({ "error": "recipient_not_member", "emails": ["out@x.com"] });
        let f = server_failure(400, &body);
        assert_eq!(f.code, "recipient_not_member");
        assert!(f.message.contains("out@x.com"));
        assert_eq!(
            server_failure(409, &serde_json::json!({ "error": "quota_exceeded" })).code,
            "quota_exceeded"
        );
        assert_eq!(
            server_failure(429, &serde_json::Value::Null).code,
            "rate_limited"
        );
        assert_eq!(
            server_failure(404, &serde_json::json!({ "error": "not_found" })).code,
            "unavailable"
        );
        assert_eq!(
            server_failure(422, &serde_json::json!({ "error": "possible_secret" })).code,
            "possible_secret"
        );
        assert_eq!(
            server_failure(500, &serde_json::Value::Null).code,
            "server_error"
        );
    }

    #[test]
    fn a_server_refusal_or_a_bad_link_is_reported() {
        let l = layout();
        let path = l.grant.join("informe.pdf");
        fs::write(&path, b"%PDF-1.7 report").expect("write");
        let req = request(&path, serde_json::json!({ "audience": "public" }), NAN);
        let (base, server) =
            crate::artifacts::tests::mock_server(409, r#"{"error":"quota_exceeded"}"#.into());
        let err = block(share_in(
            &store(&l, NAN, ApprovalMode::Ask),
            &env(&l, NAN, &base),
            &Fake::new(true),
            &req,
            &mut ShareTurn::default(),
        ))
        .expect_err("quota");
        server.join().expect("server");
        assert_eq!(err.code, "quota_exceeded");

        // The server's title is neutralized for the link card too.
        let (base, server) = crate::artifacts::tests::mock_server(
            201,
            serde_json::json!({ "url": LINK, "artifact": { "title": "Plan\u{202E}fdp" } })
                .to_string(),
        );
        let link = block(share_in(
            &store(&l, NAN, ApprovalMode::Ask),
            &env(&l, NAN, &base),
            &Fake::new(true),
            &req,
            &mut ShareTurn::default(),
        ))
        .expect("shared");
        server.join().expect("server");
        assert_eq!(link.title, "Plan\u{FFFD}fdp");

        let (base, server) =
            crate::artifacts::tests::mock_server(201, r#"{"url":"javascript:alert(1)"}"#.into());
        let err = block(share_in(
            &store(&l, NAN, ApprovalMode::Ask),
            &env(&l, NAN, &base),
            &Fake::new(true),
            &req,
            &mut ShareTurn::default(),
        ))
        .expect_err("bad link");
        server.join().expect("server");
        assert_eq!(err.code, "server_error");

        assert!(is_link(LINK));
        assert!(!is_link("http://x.com/a"));
        assert!(!is_link("https://"));
        assert!(!is_link("https://x.com/a b"));
    }

    #[test]
    fn failures_never_carry_paths_tokens_or_content() {
        let all = [
            ArtifactError::RequestInvalid,
            ArtifactError::Unavailable,
            ArtifactError::NoSession,
            ArtifactError::Offline,
            ArtifactError::TooLarge,
            ArtifactError::UnsupportedType,
            ArtifactError::Empty,
            ArtifactError::PossibleSecret,
            ArtifactError::RiskAckRequired,
            ArtifactError::SourceRefused {
                reason: "escape".into(),
            },
        ];
        for err in all {
            let text = result_for_model(&Err(refusal(&err)));
            assert!(
                !text.contains(TOKEN) && !text.contains("https://") && !text.contains("/home"),
                "{text}"
            );
        }
    }

    #[test]
    fn the_card_and_the_dialog_name_the_full_path_not_just_the_name() {
        let l = layout();
        let nested = l.grant.join("clients").join("acme");
        fs::create_dir_all(&nested).expect("mkdir");
        let path = nested.join("plan.pdf");
        fs::write(&path, b"%PDF-1.7 plan").expect("write");
        let shown = format!(
            "~{0}proj{0}clients{0}acme{0}plan.pdf",
            std::path::MAIN_SEPARATOR
        );

        // Inline card: the location is the whole path (home as ~).
        let fake = Fake::new(false);
        let req = request(
            &path,
            serde_json::json!({ "audience": "public", "title": "Mi plan" }),
            NAN,
        );
        let _ = block(share_in(
            &store(&l, NAN, ApprovalMode::Ask),
            &env(&l, NAN, "http://127.0.0.1:9"),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ));
        let ask = fake.inline.lock().unwrap()[0].share.clone().expect("ask");
        assert_eq!(ask.source, "folder");
        assert_eq!(ask.location, shown);
        assert_eq!(ask.file_name, "plan.pdf");
        assert!(fake.inline.lock().unwrap()[0].text.contains(&shown));
        assert!(
            fake.inline.lock().unwrap()[0]
                .text
                .contains("Título: Mi plan"),
            "the model's title is labeled"
        );

        // Native dialog (computer-wide): the same full path.
        let fake = Fake::new(false);
        let _ = block(share_in(
            &computer_wide(&l, NAN),
            &env(&l, NAN, "http://127.0.0.1:9"),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ));
        let native = fake.native.lock().unwrap().clone();
        assert!(native[0].1.contains(&shown), "{}", native[0].1);
        assert!(native[0].1.contains("Título: Mi plan"));
    }

    #[test]
    fn a_website_from_this_conversation_gets_a_friendly_label() {
        let l = layout();
        let scratch = l.home.join("tmp").join("conversation-7");
        fs::create_dir_all(&scratch).expect("mkdir");
        let site = scratch.join("website-calculadora.html");
        fs::write(&site, b"<!doctype html><html><body>hola</body></html>").expect("write");
        let store = share_store(grants::default_store(), NAN, 7, Some(&scratch));
        let mut e = env(&l, NAN, "http://127.0.0.1:9");
        e.scratch = Some(&scratch);
        let fake = Fake::new(false);
        let req = request(&site, serde_json::json!({ "audience": "public" }), NAN);
        let _ = block(share_in(&store, &e, &fake, &req, &mut ShareTurn::default()));
        let card = fake.inline.lock().unwrap()[0].clone();
        let ask = card.share.expect("ask");
        assert_eq!(
            (ask.source.as_str(), ask.location.as_str()),
            ("website", "website-calculadora.html")
        );
        assert!(
            card.text
                .contains("La web creada en esta conversación: website-calculadora.html")
        );
        assert_eq!(
            location_of(
                &scratch.join("notas.md"),
                Some(&l.home),
                Some(&scratch),
                false
            )
            .0,
            "conversation"
        );
        assert_eq!(
            location_of(&l.app_data.join("x.png"), Some(&l.home), None, true).0,
            "generated"
        );
        assert_eq!(
            location_of(&l.outside.join("a.pdf"), Some(&l.home), None, false).1,
            without_verbatim_prefix(&l.outside.join("a.pdf"))
                .display()
                .to_string(),
            "outside home: the absolute path, without a Windows verbatim prefix"
        );
    }

    #[test]
    fn another_conversations_temp_files_are_not_shareable() {
        let l = layout();
        let mine = l.home.join("tmp").join("conversation-7");
        let theirs = l.home.join("tmp").join("conversation-8");
        for dir in [&mine, &theirs] {
            fs::create_dir_all(dir).expect("mkdir");
        }
        let other = theirs.join("website-secreto.html");
        fs::write(&other, b"<!doctype html><p>x</p>").expect("write");
        let store = share_store(grants::default_store(), NAN, 7, Some(&mine));
        let fake = Fake::new(true);
        let req = request(&other, serde_json::json!({ "audience": "public" }), NAN);
        let err = block(share_in(
            &store,
            &env(&l, NAN, "http://127.0.0.1:9"),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ))
        .expect_err("other conversation");
        assert_eq!(err.code, "not_shareable");
        assert!(fake.inline.lock().unwrap().is_empty());
        // No duplicate grant when the effective store already has the folder.
        let twice = share_store(store.clone(), NAN, 7, Some(&mine));
        assert_eq!(twice.grants.len(), store.grants.len());
    }

    #[test]
    fn the_gate_refuses_when_not_offered_after_a_no_and_past_the_cap() {
        let turn = ShareTurn::default();
        assert_eq!(gate(false, &turn).expect_err("off").code, "invalid_call");
        assert!(gate(true, &turn).is_ok());
        let declined = ShareTurn {
            declined: true,
            ..ShareTurn::default()
        };
        assert_eq!(gate(true, &declined).expect_err("no").code, "declined");
        let full = ShareTurn {
            asks: MAX_ASKS_PER_TURN,
            ..ShareTurn::default()
        };
        let err = gate(true, &full).expect_err("cap");
        assert_eq!(err.code, "too_many_shares");
        assert!(result_for_model(&Err(err)).contains("Do not retry"));
    }

    #[test]
    fn after_a_no_the_turn_stops_asking_and_the_cap_holds() {
        let l = layout();
        let path = l.grant.join("informe.pdf");
        fs::write(&path, b"%PDF-1.7 report").expect("write");
        let req = request(&path, serde_json::json!({ "audience": "public" }), NAN);
        let st = store(&l, NAN, ApprovalMode::Ask);

        let mut turn = ShareTurn::default();
        let fake = Fake::new(false);
        let e = env(&l, NAN, "http://127.0.0.1:9");
        assert_eq!(
            block(share_in(&st, &e, &fake, &req, &mut turn))
                .expect_err("no")
                .code,
            "declined"
        );
        assert_eq!(
            block(share_in(&st, &e, &fake, &req, &mut turn))
                .expect_err("again")
                .code,
            "declined"
        );
        assert_eq!(fake.inline.lock().unwrap().len(), 1, "asked once only");

        // Three granted asks (each upload fails offline), then the cap.
        let mut turn = ShareTurn::default();
        let fake = Fake::new(true);
        for _ in 0..MAX_ASKS_PER_TURN {
            assert_eq!(
                block(share_in(&st, &e, &fake, &req, &mut turn))
                    .expect_err("offline")
                    .code,
                "offline"
            );
        }
        assert_eq!(
            block(share_in(&st, &e, &fake, &req, &mut turn))
                .expect_err("cap")
                .code,
            "too_many_shares"
        );
        assert_eq!(
            fake.inline.lock().unwrap().len(),
            usize::from(MAX_ASKS_PER_TURN)
        );
    }

    #[test]
    fn a_created_link_is_kept_for_the_reply() {
        let mut turn = ShareTurn::default();
        let link = SharedLink {
            url: LINK.into(),
            title: "Informe".into(),
            scope: "public".into(),
            recipients: vec![],
            expires_at: None,
        };
        assert!(record(&mut turn, &Ok(link.clone())).contains(LINK));
        let _ = record(&mut turn, &Err(ShareFailure::new("offline", "x")));
        assert_eq!(turn.links, vec![link]);
    }

    #[test]
    fn display_safe_neutralizes_controls_and_bidi() {
        assert_eq!(display_safe("plan.pdf"), "plan.pdf");
        assert_eq!(display_safe("a\nb\rc\td"), "a\u{FFFD}b\u{FFFD}c\u{FFFD}d");
        for bidi in [
            '\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}',
            '\u{2068}', '\u{2069}', '\u{200E}', '\u{200F}', '\u{2028}', '\u{2029}', '\u{061C}',
            '\u{FEFF}',
        ] {
            assert!(
                !display_safe(&format!("x{bidi}y")).contains(bidi),
                "{:?}",
                bidi
            );
        }
        assert_eq!(
            display_safe("año ünïcode 文件"),
            "año ünïcode 文件",
            "ordinary text is kept"
        );
        for hidden in [
            '\u{00AD}',
            '\u{034F}',
            '\u{180E}',
            '\u{FFF9}',
            '\u{FFFA}',
            '\u{FFFB}',
            '\u{E0001}',
            '\u{E007F}',
            '\u{115F}',
            '\u{1160}',
            '\u{3164}',
            '\u{FE0F}',
        ] {
            assert_eq!(
                display_safe(&format!("a{hidden}b")),
                "a\u{FFFD}b",
                "{:?}",
                hidden
            );
        }
        assert_eq!(
            display_safe("a  \u{00A0}\u{3000} b"),
            "a b",
            "whitespace runs collapse"
        );
        assert_eq!(display_safe("plan     final.pdf"), "plan final.pdf");
    }

    #[test]
    #[cfg(unix)]
    fn misleading_characters_never_reach_the_card_or_the_dialog() {
        // End to end: a real file whose name carries a fake line and an
        // RTL override (both legal on macOS).
        let l = layout();
        let evil = l
            .grant
            .join("x.pdf\n\nCon: solo tu organización \u{202E}txt.pdf");
        fs::write(&evil, b"%PDF-1.7 x").expect("write");
        let req = request(
            &evil,
            serde_json::json!({ "audience": "public", "title": "Plan\u{202E}" }),
            NAN,
        );
        let fake = Fake::new(false);
        let _ = block(share_in(
            &store(&l, NAN, ApprovalMode::Ask),
            &env(&l, NAN, "http://127.0.0.1:9"),
            &fake,
            &req,
            &mut ShareTurn::default(),
        ));
        let fake_native = Fake::new(false);
        let _ = block(share_in(
            &computer_wide(&l, NAN),
            &env(&l, NAN, "http://127.0.0.1:9"),
            &fake_native,
            &req,
            &mut ShareTurn::default(),
        ));
        let card = fake.inline.lock().unwrap()[0].clone();
        let ask = card.share.clone().expect("ask");
        let dialog = fake_native.native.lock().unwrap()[0].1.clone();
        for text in [
            &ask.location,
            &ask.file_name,
            &ask.title,
            &card.text,
            &dialog,
        ] {
            assert!(!text.contains('\u{202E}'), "{text:?}");
            assert!(!text.contains("\n\nCon: solo tu organización"), "{text:?}");
        }
        // The dialog's own lines are intact: exactly one "Con:" line.
        assert_eq!(dialog.matches("\nCon: ").count(), 1, "{dialog}");
    }

    #[test]
    #[cfg(unix)]
    fn a_symlink_in_the_temp_folder_is_named_by_its_real_path_and_refused() {
        let l = layout();
        let scratch = l.home.join("tmp").join("conversation-7");
        fs::create_dir_all(&scratch).expect("mkdir");
        let real = l.grant.join("informe.pdf");
        fs::write(&real, b"%PDF-1.7 report").expect("write");
        let link = scratch.join("website-trap.html");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        // The location comes from the RESOLVED path: the real folder file,
        // never the friendly "this conversation" label.
        let canonical = fs::canonicalize(&link).expect("canon");
        let (source, location) = location_of(&canonical, Some(&l.home), Some(&scratch), false);
        assert_eq!(source, "folder");
        assert_eq!(
            location,
            format!("~{0}proj{0}informe.pdf", std::path::MAIN_SEPARATOR)
        );
        // And the share itself refuses a symlink before any question.
        let mut st = store(&l, NAN, ApprovalMode::Ask);
        st = share_store(st, NAN, 7, Some(&scratch));
        let mut e = env(&l, NAN, "http://127.0.0.1:9");
        e.scratch = Some(&scratch);
        let fake = Fake::new(true);
        let req = request(&link, serde_json::json!({ "audience": "public" }), NAN);
        let err =
            block(share_in(&st, &e, &fake, &req, &mut ShareTurn::default())).expect_err("symlink");
        assert_eq!(err.code, "not_shareable");
        assert!(fake.inline.lock().unwrap().is_empty());
    }

    #[test]
    fn the_module_never_logs() {
        let source = include_str!("share_artifact.rs");
        let code = source.split("#[cfg(test)]").next().expect("code");
        for call in [
            "println!",
            "eprintln!",
            "dbg!",
            "log::",
            "tracing::",
            "print!(",
        ] {
            assert!(
                !code.contains(call),
                "share_artifact.rs must not log ({call})"
            );
        }
    }
}
