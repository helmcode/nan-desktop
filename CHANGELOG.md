# Changelog

## Unreleased

### Platform
- macOS: fixed "Helmcode Desktop is damaged and can't be opened". 0.2.0
  shipped an app that was only linker-signed (bundle resources not sealed).
  Release builds now get a verified bundle signature, and the app inside the
  dmg is checked before upload.
- Release pipeline ready for Developer ID signing + notarization (macOS) and
  Authenticode (Windows). It turns on automatically once the signing secrets
  exist, and every release states its real signing status. See SIGNING.md.
- Auto-update: the app checks for a new signed release on startup and every
  6 hours and shows a small banner at the top of the chat with an Update
  button (download, verify, install, relaunch). It never installs by itself.
  Releases publish a signed `latest.json` once the updater key secrets exist.
- Windows icon: icon.ico carries every frame size (16 to 256 px).

### Chat
- The model picker is now an editable allowlist: it shows exactly the ids in
  `src-tauri/chat-models.json` (deepseek-v4-flash, glm5.3, glm5.3-flash), in
  file order with the headliner first. Edit that file to change the picker.
- Images in the chat show a download icon in their corner on hover (same
  native Save-as dialog as the "Save as…" button).
- The composer's image button now uses a sparkle icon and the tooltip
  "Create image"; when image mode is on, the placeholder asks for the image
  to create and the button shows the accent state.
- Image editing (NaN community): edits happen in the new **Image Studio**,
  a view of its own. Open it from the Edit action on any chat image, from
  the visible "Edit image" button in the preview pane (chat images and
  PNG/JPEG/WebP files from your working folders), or from "Image Studio" in
  the sidebar to start from a file you pick. The Studio shows the image on
  a canvas (fit to view or actual size), pins it as the locked base, takes
  up to 2 more reference images, an instruction (up to 2000 characters,
  with a counter) and one Apply button with progress and Cancel. Every
  result joins a history strip (original, then each edit); click any step
  to keep editing from it, and download the current image. Esc goes
  back, Cmd/Ctrl + Enter applies. Results also appear in the chat as a new
  image with an "Edited" badge and a link to its original. Sent from the
  Rust core to `POST /v1/images/edits` with the desktop session; images are
  read from disk by the core and checked (PNG/JPEG/WebP, 20 MB each).
  Picked or previewed files go through the folder grants and the
  sensitive-path deny-list (new core command `image_edit_stage` for files
  already shown in the preview pane). While an edit runs, switching to
  another conversation is paused (the sidebar explains why) so the result
  and any error land in the open Studio.
- Image Studio region tools: the **Brush** and the **Rectangle** in the
  Studio toolbar now work. Pick one (one at a time; click again to turn it
  off), paint over or drag a box around the part to change, and "Clear
  marks" starts over. Marks are drawn in magenta on a layer above the image,
  never into it, and reset when the base image changes. Applying with marks
  sends the untouched base plus a marked copy and tells the model to change
  only the magenta area (the marked copy takes one reference slot and never
  joins the history). Without marks an edit works exactly as before. Needs
  an edit model that takes two images (NaN community); on the enterprise
  FLUX editor the tools show as unavailable. Core: new command
  `image_edit_stage_annotation`, and `edit_images` takes an optional
  `annotationPath` (older callers are unaffected).
- Image Studio: the pinned base image has an X ("Remove base image ... and
  start over"). It closes the current session and starts a fresh one, like
  "New chat": the canvas shows "Get started: add an image or choose a file"
  with the file picker (focused) and a pointer to the sidebar chats, the
  tray and the history strip empty, the tools reset, and the next edit
  creates its own conversation. Earlier results stay in their chat. The X
  is disabled while an edit runs.
- Preview pane: an image (a chat image or an image file) shows a
  small X on its corner, "Remove from preview". It takes the image out of
  the pane (no reopen toggle is left behind) so another one can be opened;
  the file itself is never touched. Other previews keep only the pane's
  close button.
- The "Only images inside your working folders can be used..." refusal in
  the Image Studio is now a card with an **Open Settings** button that
  opens Settings on the working folders. Settings' Back then reads "Back to
  the Image Studio" and returns to the same Studio session.

### Skills
- New **Skills** section in the sidebar: save instructions you reuse and
  turn them on in any conversation. A skill is three fields (name, what it
  is for, instructions) plus up to 5 optional reference files (.md, .txt,
  .json, .yaml, .yml; UTF-8 text, 64 KB each). The app generates the
  agentskills bundle (`SKILL.md` + `references/`) from them; the 64 KB
  `SKILL.md` and 256 KB bundle caps and the bundle path rules (NFC, no
  dotfiles, no `..`, no NUL) are checked in the Rust core on every save.
  Skills are stored locally only (`app_data/skills/`, one JSON per skill,
  atomic writes); there is no sharing yet.
- In the chat, the composer's bolt button ("Use skill") or typing `/` at the
  start of a message opens a picker (arrows, Enter, Esc). The active skill
  shows as a pill above the composer with an X to turn it off; it is
  remembered per conversation. "Save as skill" in the chat header opens the
  form preloaded from the conversation for review. Skills can be edited and
  deleted (two-step confirm); deleting one turns it off everywhere.
- Security: only the skill id is sent with `chat_send`; the core reads the
  skill from its store and adds it as its own delimited, labeled system
  block (tags inside the text are neutralized). A skill is text only: it
  never changes the offered tools, the folder grants, the approval modes or
  the model (pinned by
  `chat::tests::activating_a_skill_cannot_change_tools_permissions_or_model`).

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
- Release builds for macOS (Apple silicon + Intel), Windows and
  Linux (not code-signed; see SIGNING.md); CI runs unit, wire-acceptance and E2E checks on every pull
  request.
