# Security policy

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for security
reports.**

1. **Preferred:** GitHub private vulnerability reporting on this repository:
   [Security → Report a vulnerability](https://github.com/helmcode/nan-desktop/security/advisories/new).
2. **If that is unavailable to you:** email **support@helmcode.com** with the
   subject `[security] nan-desktop` and ask for a private channel. Do not
   include exploit details in that first email.

Please include the app version, OS, the affected component and steps to
reproduce. Never send real credentials or other people's data; redact
tokens.

What to expect: we acknowledge reports within 2 business days, keep you
updated while we work on a fix, and credit you in the release notes if you
wish. Please give us a reasonable time to ship a fix before any public
disclosure, and do not test against other users' accounts or data.

## Scope

In scope:
- The nan-desktop desktop application (this repository): credential storage and
  handling (encrypted vault + OS keychain master key, Rust core), Tauri IPC
  boundaries, the device login
  flow, markdown/sanitization of model output, the tool executor and its
  permission model, per-user data realms, artifact sharing, the sandboxed
  website preview, the assistant's in-app browser, the auto-update pipeline.
- Anything that would exfiltrate data, keys or conversations outside the two
  owned services (NaN community, Helmcode enterprise).

Out of scope here: the inference platforms themselves (`api.nan.builders`,
`api.helmcode.com`), the web portals and the artifact pages. Report those
through the same private channel; we route them to the right team.

## Security model (what we promise)

- **Locked endpoints, no third parties.** The app makes network calls ONLY
  to the two platforms' own hosts: `api.nan.builders` /
  `cloud-api.nan.builders` and `api.helmcode.com` / `cloud-api.helmcode.com`
  (mock overrides exist solely in debug builds).
  The one deliberate exception is the assistant's in-app browser: it loads
  the web pages the user or the assistant opens, like any browser, inside
  an isolated window (see [In-app browser](#in-app-browser)). The Rust core
  itself still only talks to the platform hosts.
- **Telemetry is technical metadata only** (always on, see
  [Telemetry](#telemetry-what-the-app-sends)): it goes to the same platform
  hosts, never to a third party, and never carries conversation content,
  files, paths or anything the user writes.
- **Credentials live in an encrypted vault**, read only by the Rust core. They
  never enter the web renderer process and are never logged (see
  [Credential storage](#credential-storage) below).
- **Model output is sanitized** (rehype-sanitize last) before rendering; raw
  HTML is never rendered.
- **Tool executor (when enabled) asks per action**: model proposes, user
  approves; file access is granted per folder.
- **Local data is isolated per signed-in user** (see
  [Per-user data realms](#per-user-data-realms) below): another account on the
  same device, even of the same tenant, sees nothing of yours.
- **Websites built by the assistant are isolated.** A site written by the
  `write_website` tool is previewed from its own `nan-site:` scheme inside an
  `<iframe sandbox="allow-scripts">` (opaque origin, no `allow-same-origin`)
  with a CSP header of `default-src 'none'; connect-src 'none'`: its scripts
  reach neither the app, nor storage, nor the Tauri bridge, nor the network.
  Implementation: `src-tauri/src/site_preview.rs`.
- **Videos are isolated, network-free and rendered only on our servers.**
  Video projects live in the signed-in user's realm (`videos/<id>/`); the
  renderer names projects by id and never sends a path or HTML (picked files
  go through the core's native dialog with the attachment refusals). Every
  scene is validated before it is written: no remote reference (http(s),
  `//`, absolute or `..` paths; `data:` URIs and relative `assets/` files
  only), no GSAP, no clocks, randomness, timers, network or storage APIs,
  finite animations. The preview is ONE assembled document (pinned runtime
  inlined, assets as `data:` URIs) served from `nan-site:` with the same
  no-network CSP + sandbox as websites, and the player loads it with an
  opaque origin. MP4 export zips the project in the core (90 MiB cap),
  uploads it with the session JWT through a closed route set, and downloads
  the result from the presigned URL without credentials; the renderer never
  sees the token or the URL. Details: [docs/VIDEO.md](docs/VIDEO.md).
- **Sharing is explicit and scoped.** Artifacts are uploaded only when the
  user presses Share and confirms; requests go through a closed route
  allowlist in the Rust core (`src-tauri/src/artifacts.rs`). Helmcode links
  are limited to org members or the whole org; NaN links to NaN members, who
  must sign in to open them. A detected secret needs its own confirmation.
- **A share the assistant starts always asks.** The `share_artifact` tool
  (offered only when shared links are on for the account) lets the
  assistant share a file by talking, through the same core checks as the
  manual Share (grants, type sniffing, 8 MiB cap, secret pre-scan). It is
  never automatic: every share shows an inline card (or the native dialog
  when a computer-wide grant governs the file) naming the file by its FULL
  path (home shown as `~`; a website or file written in this conversation
  is labeled as such; a symlink is named by its real path and refused),
  with control, line-separator and bidi/format characters in names, paths
  and titles replaced by U+FFFD so nothing can fake a line or reorder the
  text, the file name and the whole wrapped location always visible, the
  model's title labeled as "Title:", who gets it
  and the expiry, in every folder mode, including "allow without asking"
  and after browsing. Share answers never feed the "always allow"
  suggestion. Approval fatigue is capped: after the user declines a share,
  the same reply cannot ask again, and one reply asks at most 3 times. For a public link or community recipients the card
  carries the risk copy, and the core adds `risk_ack` to the upload only
  after the user's "Allow"; neither the model (unknown arguments are
  refused) nor the renderer (it can only answer a request the core
  created) can set it. The tool never sets `secret_ack`: a file that looks
  like it holds a credential is refused and the user is pointed to the
  manual Share, where the secret warning lives. As in the manual flow, the
  secret pre-scan only reads text formats (md, txt, csv, html, json...);
  binary formats (PDF, images, docx, xlsx) are not scanned on the device.
  Scope `members` stays manual-only. Files: the conversation's selected
  folders, THIS conversation's temp folder (never another conversation's)
  and images this app generated (shareable as in the manual flow). The created link is stored on
  the reply in the local database (device-local, never synced to the
  account) and is never logged or sent in telemetry (only the tool name).
  Implementation: `src-tauri/src/tools/share_artifact.rs`.
- **The assistant's browser is isolated and supervised.** Remote pages run
  in their own window with no access to any app or plugin command, a
  private non-persistent data store, no downloads, http/https only; the
  assistant asks before using each site, never types secrets and asks
  before every sign-in or payment (see [In-app browser](#in-app-browser)).
- **Crash logs are redacted.** Errors reaching the recovery screen are logged
  with tokens (`sk-`, `hke_`, `nan_`, `Bearer`, JWTs) redacted.

## Credential storage

Implementation: `src-tauri/src/credentials.rs`.

All secrets (per-user inference API keys and login session tokens) live in
ONE file, `vault.bin` in the app data directory. Since the per-user realms,
each secret is stored under the signed-in user's realm key
(`<profile>:<user-id>` and `<profile>:<user-id>.session`):

- **Encryption:** AES-256-GCM, a fresh random 96-bit nonce on every write, a
  versioned envelope (`HCDVAULT | version | nonce | ciphertext+tag`) whose
  header is authenticated as associated data.
- **Master key:** 32 random bytes from the OS CSPRNG.
  - Release builds: stored as the app's **single** OS keychain item
    (service `com.helmcode.nan.desktop`, account `vault-master-key`) and
    cached in memory after the first read — at most one keychain access per
    launch, and with "Always Allow" on a stable signed binary, none at all.
  - Debug builds: a `0600` file next to the vault (`vault.key`) so developers
    never see keychain prompts. Development builds therefore only get the
    file-permission guarantee, not encryption-at-rest separation.
- **Files:** created with mode `0600`; written atomically (temp file +
  `fsync` + `rename`) under a process-wide lock.
- **Failure mode:** a vault that is missing, truncated, tampered with, of an
  unknown version, or sealed with a different master key reads as **empty**:
  the user is signed out and the next sign-in writes a clean vault. Nothing
  panics. A master key that cannot be read (e.g. keychain access denied) is
  never silently replaced, so a valid vault is never orphaned.
- **Migration:** pre-vault versions kept one keychain item per secret. On the
  first launch with the vault, those items are copied into the vault and then
  deleted from the keychain (once, best-effort, silent — any failure simply
  means signing in again).

### What this protects against

- Other local users and processes running as a different user (file mode
  `0600`; in release builds the master key is not on disk at all).
- Leakage of the app data directory through backups, cloud sync or a copied
  home folder: the vault is ciphertext and its key stays in the keychain,
  which is not part of that data.
- Torn or half-written credential files (atomic writes) and tampering that
  would otherwise yield attacker-chosen credentials (authenticated
  encryption).

### What it does NOT protect against

- **Root, or malware running as the same user.** Such code can request the
  master key from the keychain under the app's identity, read the debug key
  file, or read the process memory. This is the same tradeoff mainstream
  desktop AI clients make. The previous design (one keychain item per secret)
  did not materially change this threat model but prompted users repeatedly,
  so we chose one well-protected key over many prompts.
- Unsigned or ad-hoc signed builds (older macOS releases, local builds from
  source): macOS binds "Always Allow" to the code signature, so on such a
  build an update may ask for the keychain password once more. Developer ID
  signed releases keep a stable identity.

The storage backend sits behind a `CredentialStore` trait; a per-item
keychain backend (`KeyringStore`) remains available behind the same seam if a
platform needs it.

## Per-user data realms

Implementation: `src-tauri/src/realm.rs` (plus `profile.rs` bindings and the
login boundary in `device_flow.rs`).

Up to v0.2.6 local data was keyed by the tenant (`nan` / `helmcode`), so two
accounts of the same tenant on one device shared conversations, skills and
folder grants. Every user-identifying store now lives in a per-user realm:

- **Realm key:** `<profile>:<user-id>`, where the user id is what the platform
  answers to `GET /api/auth/me` called with the NEW session right after the
  device-flow approval. No verified user id means no login: nothing is
  stored and the previously open realm does not change.
- **Realm folder:** `<app data>/realms/<hex(sha256(realm key))[0..16 bytes]>`
  (mode `0700`) holds `chat.db`, local skills, the org skills cache,
  `tools.json` (folder grants, approval modes, run_command switch), the tools
  audit log and `memory.json`.
- **Binding:** `profiles.json` (schema v3) records the user bound to each
  profile (id, email, realm hash). It lives outside the vault on purpose: a
  vault reset signs you out but never forgets whose data is whose. A binding
  whose realm hash does not match its user id is dropped, never followed.
- **Resolution:** commands reach a realm only for the ACTIVE, BOUND profile.
  Signed out, nothing is readable. Sign-out deletes the session and keeps the
  binding and the realm data, so the same user gets everything back.
- **Switching users:** a login of another user id opens a fresh, empty realm
  and deletes the previous user's credentials (their data stays on disk,
  unreachable). Every login and sign-out aborts running replies and image
  jobs and resets per-conversation tool state.
- **Shared on purpose:** generated images under `images/` (the asset
  protocol scope). Their names are random v4 uuids that no command lists;
  an image is only reachable through the `chat.db` row of the realm that
  made it.
- **Tool sandbox:** the protected area is still the WHOLE app data folder
  (vault, profiles, every realm), not only the open realm.

**One-time migration:** data written before realms has no owner. It is
assigned to whoever signs in to that profile FIRST after the update (moved,
not copied; `chat.db` is split per profile and vacuumed so no other
profile's text remains). Local skills, which had no profile at all, go to
the first sign-in on the device. Any later user gets a fresh realm.

**Not covered:** other people using the SAME OS account can still open the
app data folder directly (the realms are not encrypted at rest; use separate
OS accounts for real separation), and conversations that a previous version
already synced to another account's memory cannot be recalled from the
device.

## Telemetry (what the app sends)

Owner decision (2026-11-17): the app sends technical usage and error data
to fix bugs and understand usage. It is **always on** and has no setting.
Implementation: `src-tauri/src/telemetry.rs`.

**Where.** `POST {platform}/api/desktop/telemetry` on the signed-in
profile's own compiled-in platform (`cloud-api.nan.builders` or
`cloud-api.helmcode.com`), authenticated with the login session JWT, exactly
like the conversation memory sync. The JWT never leaves the Rust core; the
renderer never talks to the network for telemetry. Events are tagged with
the profile (and signed-in user) they were produced under and only ever go
to that profile's platform: nothing crosses from one tenant to the other.
Events recorded on a profile before any user signed in to it (for example a
sign-in error on the login screen) are sent with that profile's next
signed-in user. Install-level events recorded while no profile is active
(`app_start` on the login screen, a crash there) carry no tenant data and go
with the next flush of the active profile.

**Every request** carries: `install_id` (random uuid generated once per
install, stored in the app data dir), `app_version`, `os`
(`macos` / `windows` / `linux`), `os_version` (e.g. `15.1`,
`ubuntu 22.04`, `10.0.22631.4317`), `arch` (`aarch64`, `x86_64`). **Every
event** carries: a random event `id`, its `name`, a client timestamp `ts`
and a `session_id` (random uuid per app launch).

**The complete event list** (props are built only from enums, counters,
durations and fixed lists; tests pin every builder):

| Event | Props |
|---|---|
| `app_start` | none |
| `turn_end` | `reason` (`completed`, `tool_cap`, `stream_cut`, `length`, `interrupted`, `user_stop`, `error`), `error_kind` (the classified kind for `error` and `interrupted`, else null), `rounds`, `tool_calls`, `duration_ms`, `model` (only ids from the app's built-in model list, else `other`), `continued` (bool) |
| `tool_call` | `tool` (only names from the app's fixed tool list, else `unknown`), `outcome` (`ok`, `error`, `timeout`, `denied`), `duration_ms` |
| `error_shown` | `surface` (`chat`, `images`, `sign_in`, `memory`), `kind` (the classified error kind, e.g. `rate_limited`, `network`) |
| `attachment_added` | `kind` (`image`, `pdf`, `docx`, `sheet`, `text`, `other`), `count` (how many files of that kind one sent message carried; one event per kind) |
| `vision_routed` | `from_model`, `to_model` (only ids from the app's built-in model list, else `other`): a reply with images went to the model that can see them because the selected one cannot |
| `crash` | `source` (`rust_panic`, `renderer`), `location` (Rust: `file:line` where the panic happened, the app's or a library's source file, build-machine path prefixes removed; renderer: the error name, only standard error classes such as `TypeError` or the `typeof` of a non-Error rejection, anything else is sent as `Error`) |

The `tool` list includes the in-app browser tools (`browser_open`,
`browser_read`, `browser_click`, `browser_type`, `browser_scroll`,
`browser_back`, `browser_screenshot`, `browser_wait`): only the name,
outcome and duration are sent, never the address, the site, the page or
what was typed.

**Never sent:** message text, prompts, replies, file names or contents,
paths, URLs, command lines, search queries, emails, error or panic
messages, stack traces. Tool arguments and results are inspected only to
classify the outcome and are then discarded.

**Delivery.** A bounded queue on disk (`telemetry/queue.jsonl`, at most
1000 events, oldest dropped, events older than 30 days pruned) is flushed
in batches of up to 100 events: first about 15 s after launch, then every
60 s, as soon as 50 are queued, and best-effort on exit (3 s budget).
Network errors, 408, 429 and 5xx back off exponentially (60 s up to 15 min,
longer when the server sends a `Retry-After`, bounded to 15 min);
401/403/404 keep the events queued and stop sending for that profile until
the app restarts; any other non-2xx status (400, 413, ...) drops that
batch. Without a session, events only wait in the queue. A Rust panic
writes its `crash` event synchronously to `telemetry/crash.jsonl` before
the process ends; the next launch sends it. Renderer crashes are accepted
through one IPC command that takes only an error name (checked in Rust
against a fixed list of standard error names, at most 20 per launch).
Records read back from the queue file are re-validated (known event names
and props only, timestamp shape, no control characters) and a damaged file
is repaired on launch.

**Volume guards.** At most 5000 events are recorded per UTC day on an
install (counted in memory, saved at each flush and on exit), and at most
20 `tool_call` events per reply (longer replies are counted in
`turn_end.tool_calls`). The backends also cap each account at 20,000 events
per 24 h and answer `202` with `dropped`; the app treats any `202` as
delivered and never retries it. Automatic and "Continue" turns both
report `continued: true`.

## In-app browser

Implementation: `src-tauri/src/browser/` (design: `mod.rs`; addresses:
`url_policy.rs`; approvals: `policy.rs`; page scripts: `page.rs`), the
command ACL in `src-tauri/build.rs` and `capabilities/default.json`. Phase 2
(whole-computer control) is only a design so far: [docs/COMPUTER-USE.md](docs/COMPUTER-USE.md).

The assistant can drive a browser window inside the app with the
`browser_*` tools. The user sees that window, can use it at any time, and
can stop the assistant from the browser bar in the chat window.

**Isolation (what a web page can reach).**
- **No IPC.** The browser window (label `browser`) is in no capability, and
  the app declares an ACL manifest for its own commands (`build.rs`), so
  Tauri checks every app command against the capabilities, which grant
  them to the `main` window only. Plugin commands (events included) are
  equally ungranted. Tauri also refuses every app command from a remote
  origin. Verified live on macOS: a page calling `profiles_load`,
  `browser_state` or `plugin:event|listen` gets "not allowed on window
  browser"; a `lib.rs` test keeps the command list, the manifest and the
  capability identical.
- **Navigation guard** (`url_policy::navigation_allowed`) on every
  top-level navigation the engine reports (on Windows, WebView2 does not
  report sub-frame navigations to it): `http`/`https` only (plus
  `about:blank`), never `file:`, `data:`, `javascript:`, custom schemes or
  the app's own origins (`tauri://`, `ipc://`, `asset://`, `nan-site://`,
  and every `localhost` / `*.localhost` host, which Tauri treats as the app
  itself). Addresses with `user:password@` are refused. A frame that did
  load an app origin would still reach no command: the window has no
  capability at all (above).
- **First document is `about:blank`.** The window is created on
  `about:blank` and then navigated, so no page chooses the origin of the
  window's first document.
- **Every page permission is refused** (microphone, camera, location,
  notifications...), on every platform (`on_permission_request` ->
  `Deny`). Without it WKWebView would grant media capture silently.
- **Separate, private data store.** The webview is incognito
  (macOS non-persistent `WKWebsiteDataStore`, WebView2 InPrivate, WebKitGTK
  ephemeral context): no cookies, storage or cache shared with the app UI,
  nothing written to disk, everything gone when the window closes. A
  sign-in made in the browser lasts until the window closes, and it is
  shared by every conversation that uses the browser meanwhile (one
  window, one session): close the browser to end it.
- **Own WebView2 environment on Windows.** Tauri would give the browser
  the app's WebView2 user data folder, and WebView2 runs every webview of
  one folder in one browser process. The browser gets its own folder
  (`<local app data>/browser-webview2`, emptied at startup), so it shares
  no browser process with the chat window: its teardown can never take
  the chat's webview with it, and the two never share engine state.
- **No downloads.** Every download is cancelled; the chat window shows a
  notice and the assistant is told, so it can ask the user to download the
  file from their own browser. Nothing is saved or opened.
- **No new windows.** Popups and `target=_blank` links open in the same
  window, under the same navigation guard.
- **No file drops.** Files dragged onto the browser window are taken by
  the app's drop handler (so the page never receives them) and ignored:
  only the chat window turns dropped files into attachments.
- **No app data.** The browser has no access to the vault, sessions,
  realms or files: the tools only read the page and act inside it, and
  never grant file or command access.
- **Closing means stop.** When the user closes the browser (bar or window
  button), the reply driving it stops and the browser tools refuse until
  the user sends their next message.
- **Realm switch.** Signing in or out closes the browser and forgets every
  site approval.

**How the assistant sees and acts.** Page scripts run through the engine's
native script-evaluation callback (never through IPC), are parameterized
with JSON literals, and return JSON. A read returns the title, address,
visible text from the current scroll position (at most 12,000 characters)
and up to 120 numbered interactive elements. Element numbers are tied to
that read: after a navigation or another read they are refused as stale.
Field values are only shown for fields the assistant typed itself (never
what the user or the page filled in). Each script has an 8 s timeout and a
navigation 20 s; one action runs at a time, and a conversation never
waits behind another conversation's pending card (it is told the browser
is busy).

**Final address check.** Page content reaches the model only after the
site rule ran on the page's FINAL address: after a redirect, a link or a
script that moved the page to another site (or to the local network), that
site needs its own approval first; if the user declines, the model gets no
content, only "the page navigated to <host>, which the user did not
allow". After every read and screenshot the core re-reads the window's
address (never the page's own claim) and drops the result when the page
moved to another site, or from a public site to a local-network address,
meanwhile.

**Approval policy.**
- **Browser permission mode.** One setting (Settings, Working folders,
  "Navegador": "Preguntar siempre" / "Permitir sin preguntar", stored per
  signed-in user as `browser_mode` in `tools.json`, default `ask`) decides
  the two browser questions below that are about convenience: the per-site
  card and the post-browsing guard. `allow` turns both off. Switching to
  `allow` is confirmed by a native dialog the app window cannot fake (and
  audited); switching back to `ask` needs nothing. The chat may suggest it
  after three browser approvals in a conversation (new-site cards and
  post-browsing approvals; any denial resets; once per conversation) with
  "Permitir siempre" (stores `allow`) or "Solo en esta sesión" (an
  in-memory allow, never persisted, cleared when the app quits, on every
  sign-in/sign-out and when the user picks "Preguntar siempre"); both go
  through the same native confirmation. A store written by 0.2.14 with the
  old guard switch turned off migrates to `allow`. The mode NEVER changes
  the rules that ask or refuse in every mode: local-network addresses,
  sign-ins and payments, and secret fields (below).
- **Per site, per conversation.** In `ask` mode the first action on a site
  (host, `www.` ignored, subdomains separate) asks with an inline card; a
  yes covers that site for the rest of the conversation (until the app
  restarts or the account changes). This holds whatever the folder modes
  are: only the browser permission mode decides it. Public sites run
  without asking only when that mode allows (stored or for this session);
  this is re-evaluated on every action and never remembered, so switching
  back to "ask" takes effect at once. The chat still shows a "Using <host>" line for each
  new site. A pending card brings the chat
  window to the front; the browser opens beside the chat without taking
  the focus.
- **Local network asks in every mode** (once per conversation): loopback,
  RFC 1918, link-local, CGNAT, 198.18.0.0/15, IPv6 ULA and site-local,
  IPv4-mapped/compatible, NAT64 and 6to4 addresses, single-label and
  `.local`/`.lan`/`.internal` names. DNS answers are not inspected: a public name that resolves to a
  private address is treated as public.
- **Secrets are never typed by the assistant**, in any mode: password,
  verification-code and card fields (by type, `autocomplete` and
  name/label) are refused, and the page script refuses password fields a
  second time. The assistant asks the user to fill them in themselves.
- **Sign-ins and payments ask every time**, even in allow mode: submitting
  a form that has a password or card field, pressing a control whose label
  reads like a payment or purchase, or pressing a sign-in control on a page
  that shows a password field.
- **Time of check vs time of use.** The policy checks an element, then a
  second script acts on it; a hostile page can swap the element in
  between (the element registry lives in the page). The click script
  re-reads the element's label and refuses the click as stale when it
  changed, which closes the honest-page cases; a hostile page can still
  defeat it, which is why the policy is friction, not isolation.
- Every answer to a browser card is written to the tools audit log with
  the host only.
- **After browsing, commands and changes ask (in `ask` mode).** Page
  content can carry instructions aimed at the assistant. Once any browser
  result has been fed to the model in a conversation, `run_command`,
  `write_file`, `replace_file`, `move_path`, `delete_path` and `save_image`
  ask with an inline card even in folders set to "allow", until the user
  sends their next message in that conversation (a "Continue" does not end
  it). Reads (`read_file`, `list_files`) stay free. Under a whole-computer
  grant the question is the native dialog (as for every whole-computer
  approval). The card or dialog says why it asks, and the audit log records
  "allow mode suspended" (outcome `asked`). The guard ends only once the
  user's new message has been saved. The browser permission mode `allow`
  (stored or for this session) turns this guard off. Residual: the next message starts a new task, but the
  tool trace of the last two replies (which may hold page text) is still
  replayed as earlier data.

**Prompt injection.** Everything a page shows is untrusted. Reads are
wrapped in a header that says so, between markers with a random nonce that
is never sent to the page, and page text can never contain `<<<` (it is
neutralized after cleaning), so no page can open or close a marker; the system prompt tells the model never to follow
instructions from pages and never to copy private data into them unless
asked. The page facts that drive the policy (field types, labels) come
from the page itself: they add friction for honest sites, they do not make
a hostile site safe. Isolation does that.

**Screenshots** (`browser_screenshot`, offered only to models that can see
images) are taken by the engine itself (WKWebView snapshot, WebView2
`CapturePreview`, WebKitGTK snapshot) and show only the browser page,
never the rest of the screen. Only the newest screenshot is sent with a
request (earlier ones become a text stub), only to the profile's own
inference API, and none is stored in the conversation or its tool trace.
At most 4 MiB; Linux snapshots are scaled to 1280 px wide. If a vision model rejects
images in a reply (400), the retry turns that reply's screenshots into text
stubs, no further screenshot is offered or sent as an image in that reply,
and attachment images are not flagged `vision_rejected` (the culprit is
unknown).

**Known limitations.** Clicks and typing are synthetic DOM events: a few
sites that only accept real input may ignore them (the user can do that
step). Cross-origin iframes are not read. Same-OS-account malware is out of
scope, as everywhere else.

## Chat attachments

Files attached to a message (`src-tauri/src/attachments.rs`):

- **Who chooses the file.** The paperclip opens the native file dialog
  from the Rust core, and files dropped on the window are read from the
  window's own drop event in the core; the renderer never names a path.
  A pasted image is bytes the renderer already holds (images only, and
  only when the clipboard has no text).
- **What can be attached.** Any regular file the user explicitly picks or
  drops, whatever the folder permissions say, except: the app's own data
  folder; the always-refused write deny-list (keychains and credential
  stores, login items, shell startup files, `.pem`/`.key` files); and
  read secrets under the home folder (`~/.aws/credentials`,
  `~/.aws/config`, `~/.kube/config`, `~/.netrc`, `~/.docker/config.json`,
  `~/.config/gh/hosts.yml`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`)
  plus any file named `.env` or `.env.*` anywhere. The user sees a neutral
  "cannot be attached" message. On Unix the file is opened with
  `O_NOFOLLOW` and its type and size are checked on the open handle; size
  caps are checked before reading.
- **Drops** are staged only while the chat composer is on screen and no
  drag that started inside the page is in progress (WebKitGTK may report
  an in-page drag of a `file://` link as a file drop). Both signals come
  from the window, so this is defense in depth, not a boundary. **Needs
  manual verification on Linux.**
- **Images** are decoded with a pixel cap (decompression bombs are
  refused) and at most 2 at a time, downscaled to 1568 px on the long side
  and re-encoded as JPEG under the app's images folder. They are sent to
  the model as images only when the model accepts images
  (`src-tauri/chat-models.json`, `vision`); every request body is checked
  right before it is sent and a model that does not accept images never
  receives an image part. For text-only models an image becomes
  `[Image: <name>. Already viewed earlier in this conversation;
  description: <description>]`. The short description (which may
  transcribe text visible in the image) comes from one small request to
  the vision model, using the same inference key as the chat, made when
  the selected model is text-only or the first time a text-only request
  needs it. It is stored only on this device and never synced.
- **Documents** are copied to a private staging folder (outside the
  folder the window can load files from), read back once by the window to
  extract their text locally (pdf.js; mammoth and SheetJS inside a Web
  Worker that is terminated after 30 s, at most 5,000 rows x 100 columns
  per sheet) and deleted when the message is stored. The extracted text is
  capped (50,000 characters per file, 120,000 per message, with a note to
  the model when cut) and stored with the message on this device so the
  history can replay it. The window never receives the stored text again.
- **Prompt injection.** A document body cannot open or close its own
  `<attached_file>` block (such tokens are neutralized), descriptions lose
  brackets, parentheses and angle brackets, and a system note tells the
  model that attached content is data, never instructions.
- **Account memory** never uploads attachment bytes, extracted text or
  image descriptions: the synced copy of the message is its text plus one
  placeholder line per attachment (`[Attached file: <name>]`,
  `[Image: <name>]`). A new conversation started with files only is titled
  after the first file name, and that title syncs like any title.
- **Cleanup.** Unsent staged documents are deleted after 24 h; unsent or
  deleted images go with the startup sweep of unreferenced images.

## Tool output kept for continuity

To let the assistant continue a long task without redoing it, each reply
keeps its tool exchange on the device (`messages.tool_trace` in the realm's
`chat.db`): the tool calls and their results, which may include content of
files the user let the assistant read (for example a `.env`). The window is
bounded:

- each result is truncated to 4,000 characters and a reply keeps at most
  32,000 bytes (serialized JSON) of its newest rounds;
- only the **2 newest assistant replies of each conversation** keep a trace;
  older traces are deleted when a turn ends or is stopped, and for every
  conversation each time the store is opened;
- traces never leave the device: they are not sent to the renderer, not
  part of memory sync, and only replayed to the same inference API that
  produced them, marked as earlier data, not instructions;
- deleting the conversation deletes them.

## Command limits

`run_command` children run without a console window (also on Windows) and
are bounded: 120 s per command, after which the **whole process tree** is
killed (Unix: the process group; Windows: `taskkill /T /F`); pressing Stop
ends the tree of the command running for that conversation at once, and
so does any other end of the reply's task (a new message that replaces it,
or switching account). One
reply can run at most 60 tool rounds, so the worst case for a single reply
is 60 commands of 120 s each (about 2 hours) before the hard cap; every
command in `ask` mode still needs the user's approval.

## Supported versions

| Version | Supported |
|---------|-----------|
| latest tag + `main` | yes |
| older tags | best effort |

## Known limitations

- **Code signing** (state as of v0.2.10, stated in every release body):
  - macOS: signed with an Apple **Developer ID** and **notarized**.
  - Windows: **not Authenticode signed yet**; SmartScreen warns on first
    run. The pipeline enables signing automatically once the certificate
    secrets are configured.
  - Linux: packages are unsigned (standard for AppImage/deb/rpm on GitHub
    releases).

  Updates delivered by the auto-updater are always verified against the
  updater public key embedded in the app (`src-tauri/tauri.conf.json`).
  Verify installer hashes against the values shown on the GitHub release.
  Details and the owner setup checklist: [SIGNING.md](SIGNING.md).
- **Linux sign-in** needs a Secret Service provider (GNOME Keyring or
  KWallet) for the keychain.
- **Same OS account:** realms are not encrypted at rest; anyone using the
  same OS account can read the app data folder. Use separate OS accounts.
