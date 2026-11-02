# Changelog

## 0.2.0 — First public beta

The first publicly announced build of Helmcode Desktop: a focused AI
workspace for the NaN and Helmcode inference platforms, locked to
`api.nan.builders` and `api.helmcode.com`.

### Agent
- Tool approvals redesigned: per-folder modes (ask always / allow
  always), approval cards inline in the chat, and a suggestion to
  switch a busy folder to allow-always after repeated approvals.
- Full file surface: read, write, move, delete (to the OS trash where
  available) and command execution, always core-mediated with a
  sensitive-path deny-list that no mode bypasses.
- The model's native tool-call markup (including the fullwidth DSML
  variant observed in the wild) is parsed into real tool calls and
  never shown as chat text.
- Intrinsic web search through the platform's private wrapper, with a
  page reader for the preview pane. The search routes are private to
  the app: member API keys receive a bare 404.

### Product
- Brand: the official Helmcode mark everywhere, app name
  "Helmcode Desktop".
- Language chosen first (English or Spanish), before tenant selection;
  full i18n for every surface.
- Per-conversation working folders (multi-select, none by default;
  with none selected the agent works in a session temp folder and asks
  where to save).
- Preview pane: images, PDF, Markdown, HTML, Excel and Word files, and
  fetched web pages. The latest produced artifact opens automatically.
- Image generation through the tenant's images API (verified against
  the live endpoint).
- Conversations stream in the sidebar the moment they start, and keep
  streaming across switches.
- Credentials live in an encrypted local vault (single master key; no
  repeated OS keychain prompts).

### Platform
- Device-flow login (RFC 8628) against both tenants with per-device
  credentials.
- Signed release builds for macOS (Apple silicon + Intel), Windows and
  Linux; CI runs unit, wire-acceptance and E2E checks on every pull
  request.
