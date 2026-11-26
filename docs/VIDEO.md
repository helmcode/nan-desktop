# Videos (R-V1)

> **Audience: contributors.** How the Videos feature works end to end and
> which guarantees it keeps. Code: `src-tauri/src/video/` (core) and
> `src/video/` (renderer). The shared contract with the platform teams
> (composition format, render API, dispatcher) lives outside this repo; the
> desktop implements its §1 and §2.

Both tenants (NaN community and Helmcode enterprise) get the same feature;
there is no feature flag. Rendering to MP4 happens ONLY on the tenant's
servers (the render service); the desktop authors, previews, edits and
uploads, and downloads the result.

## Pieces

| Piece | Where | What |
|---|---|---|
| Format | `video/project.rs` | `video.json`, scene rules, generated `index.html` |
| Library | `video/library.rs` | per-user projects on disk, validate-then-write |
| Model tools | `video/tool.rs` | `create_video`, `edit_video`, GUIDANCE |
| Preview | `video/preview.rs`, `site_preview.rs` | one self-contained, network-free document |
| Templates | `video/templates.rs`, `src-tauri/video-templates/` | the bundled gallery |
| Editor | `video/editor.rs`, `src/video/VideoEditor.tsx` | fields, scenes, audio, format |
| Export | `video/render.rs`, `src/video/ExportPanel.tsx` | zip, upload, poll, download |
| Player | `src/video/VideoPlayer.tsx` | `@hyperframes/player`, sealed |
| Lint | `src/video/lint.ts` | `@hyperframes/lint` on the project sources |
| Motion lint | `video/motion.rs` | warnings for stutter-prone scenes, in the tool result |

## HyperFrames version

ONE pinned release, **0.9.86**, for `@hyperframes/player`,
`@hyperframes/lint`, `@hyperframes/core` (dev only: the runtime pin check),
the runtime the core inlines (`src-tauri/vendor/hyperframes/`, byte for byte
the published `dist/hyperframe.runtime.iife.js`, Apache-2.0) and the server
renderer (`@hyperframes/producer`, other repo). `src/video/runtimePin.test.ts`
and `video::preview` tests fail when the pieces in this repo drift; bumping
is one coordinated change with the render service.

GSAP is never used (its license forbids no-code animation builders): scenes
animate with CSS `@keyframes` (or WAAPI), driven by the HyperFrames CSS/WAAPI
adapters.

## Project format

```text
<realm>/videos/<project id>/      32 lowercase hex, never a path from outside
  video.json                      title, aspect, fps, scenes (order + seconds),
                                  variables (+ current values), voice/music,
                                  template id
  index.html                      GENERATED from video.json by the core
  theme.css                       optional shared CSS (fonts, palette)
  compositions/<scene>.html       one <template id="<scene>-template"> each
  assets/<name>, assets/fonts/<name>
  exports/<name>.mp4              downloaded renders (never uploaded)
```

`index.html` is never written by the model or the renderer: the root
(`data-composition-id="main"`, `data-duration` = sum of the scenes), one host
per scene (`data-composition-src`, computed `data-start`), the managed voice
and music `<audio>` clips, the variable declarations (each value is the
declared default, so the render needs no extra input) and every value on each
host (`data-variable-values`) all come from `video.json`. Reordering scenes,
changing a duration or a value can therefore never leave the composition
inconsistent. Scene roots get `data-width`/`data-height` of the project
canvas on every write (16:9 1920x1080, 9:16 1080x1920, 1:1 1080x1080), so a
template or an aspect change fits.

Limits (contract §1 + amendment): 600 s per video, 0.5 to 120 s per scene,
24 scenes, 24 variables, fps 24/25/30/60, 80 MiB per asset, 88 MiB per
project, 90 MiB per uploaded bundle (checked on the zipped bytes before any
upload).

## Validation (what the core refuses)

Everything is validated before anything is written (`library::apply`); a
change that fails writes nothing, and the model gets the reason as its tool
result so it can fix and retry.

- **No network.** Every URL-carrying attribute and CSS `url()` must be a
  relative `assets/` path, a `data:` URI or a fragment (the website
  validator's tokenizer with a video URL policy). `http(s)://`, `//host`,
  `file:`, absolute and `..` paths are refused at write time, at preview time
  and again by `render::prepare` before an export, so a bundle the server
  would reject for remote references is never uploaded. `data:` URIs are
  ALLOWED on purpose: they are inline bytes, not references (nothing is
  fetched), the server renderer treats them as local, and the preview itself
  inlines assets that way. No `<link>`, `<meta>`,
  `<iframe>`, `<object>`, `<form>`, `<base>`, external or module scripts,
  `@import`, inline event handlers or `crossorigin`.
- **Deterministic.** Scripts may not mention GSAP, `Date.now`, `new Date()`,
  `performance.now`, `Math.random`, timers, `requestAnimationFrame`, `fetch`,
  XHR, WebSockets, storage, cookies, `eval`, navigation, `.play(` or
  `currentTime`; CSS animations must be finite (no `infinite`).
- **Structure.** One `<template>` per scene, a root with
  `data-composition-id="<scene>"` (`data-no-timeline` added when missing),
  media rules (`<video muted>` or `data-has-audio`, `<audio id>`, no
  autoplay/loop/controls).
- **Files.** A closed set of project-relative paths; ids validated; no
  symlink is ever followed (`symlink_metadata` on every component,
  `O_NOFOLLOW` reads); atomic writes (temp + rename); asset extension and
  magic bytes must agree.

On top, the renderer runs the official `@hyperframes/lint` (lazy chunk) on
the sources `video_get` returns. Errors block the export and can be sent to
the assistant ("Ask the assistant to fix it"). Why the lint is not in the
core: it is JavaScript and the app ships no JS engine in the core; the tool
loop runs in Rust, so the core's own rules give the model synchronous
feedback, and the lint adds the format checks before an export is paid for.
Every bundled template and the generated root pass the lint with zero
warnings in CI (`src/video/templates.lint.test.ts`).

## Model tools

`create_video` (title, aspect, fps, scenes with html, variables, theme_css,
voiceover, images) and `edit_video` (send only what changes; with ONLY
`project_id` it returns the current version, because the user may have edited
it). Both are always offered (the library is the app's own storage, like
generated images), need no approval card, and emit `video://changed` so the
side panel opens the video; the reply records a `video` artifact (its id).

- Variables: `text` (`data-var-text`), `color` and `number` (both written
  by the core as `:root` custom properties, validated, so `var(--id)` works
  in CSS and `calc()` without relying on the runtime binding; numbers drive
  chart bars), `image` (`data-var-src`).
- Voice-over: kokoro (`/audio/speech`, the same request as read-aloud), WAV
  saved as `assets/voiceover.wav`; its length goes back to the model.
- Images: the model calls `generate_image` first and passes the returned
  path; the core accepts only a regular file DIRECTLY inside
  `app_data/images` (`images::verify_generated_image`). No other path the
  model sends is ever read.

## Preview isolation

`video_preview` assembles ONE document: the generated `index.html`, the
pinned runtime inlined as the first script of `<head>` (the player cannot
inject it from its CDN: no network, opaque frame), every scene appended as
its inline `<template>` (the runtime mounts inline templates instead of
fetching `data-composition-src`), and every `assets/...` reference replaced
by a `data:` URI. Scenes are re-validated on the way in. The document is
registered in the site registry's video class (ring of 3, released by the
renderer when the player unmounts) and served from `nan-site://` with the
same `SITE_CSP` header + `sandbox allow-scripts` as websites.

The player (`<hyperframes-player>`, our pinned bundle code in the app
renderer) loads that URL with `sandbox-origin="opaque"`, so the composition
runs in an opaque-origin frame: no app DOM, no storage, no Tauri bridge, no
network; the player talks to it only through `postMessage`. Before the
first load the inner frame's `allow` is narrowed to `autoplay` (no
`fullscreen`: a hostile composition cannot take the whole screen and imitate
the app) and the player's fullscreen button is hidden. The app CSP is
unchanged (`frame-src nan-site:` already existed).

Our own "Full screen" button (`VideoPlayer`) enlarges the PLAYER element in
the app document, never the composition frame: the `<figure>` gets a fixed
full-window overlay class (pure CSS, so it works in WKWebView, WebView2 and
WebKitGTK alike) and, best effort, `requestFullscreen()` (or
`webkitRequestFullscreen()`) on that same element, which takes the whole
screen where the webview grants the Fullscreen API to app elements and is
simply ignored where it does not. No Tauri window permission is needed. The
element is never moved in the DOM (moving the iframe would reload it).
Escape (an escape layer: the side panel behind it does not close on the
same key), the button again, the webview's own exit, or a tool approval
request (its card would be hidden under the layer) leaves it. It is not
modal: the keyboard lands on the exit button and the player's controls stay
reachable. The side panel keeps it full screen when an assistant edit
reloads the player (the new element fills the window; the webview's own
full screen would need a fresh click).

## Following the assistant

`create_video` / `edit_video` emit `video://changed` after every write
(the editor's own saves do not: they already show their result).
`useVideoRevision(projectId)` folds a burst of them into one bump after
400 ms of quiet. The side panel then loads a fresh preview while the old
one stays on screen, swaps it in at the same playhead and releases the old
token (a failed reload keeps the last good preview). The editor reloads the
project the same way; a field the user is in (title, texts, numbers, hex
codes) is never re-synced while focused, and a save in flight finishes
before the reload, so neither typing nor a save's answer is lost.

## Editor

`video_get` / `video_update` (title, aspect, values, scene order and
durations, voice/music volume or removal) / `video_pick_asset` (a SLOT:
image variable, music, voice; the core opens the native dialog, applies the
chat-attachment refusals: app data, credential stores, key files; checks
type and magic; names the asset itself) / `video_delete` (after a
confirmation in the app's own dialog: the macOS webview has no JavaScript
confirm panel). The renderer never sends a path or HTML. A color has its swatch
plus its code typed by hand (`#0a0a0a`, `#FFF`, `fff`): normalized to
lowercase `#rrggbb`, applied on Enter or on leaving the box when valid; an
invalid code shows a short error and changes nothing. A change reloads
the preview at the same playhead (or at the start of the scene that was
edited).

"Ask for a change in this scene" adds a plain request to the composer
(never replacing what the user typed), e.g. `Escena «Mensaje» (0:07 a
0:11): `, for the user to finish in their own words. "Ask the assistant to
fix it" (the automatic check) is a complete request, so it is SENT right
away as if the user had typed it, without touching the composer's draft or
its video chip; when it cannot go out (a reply is still streaming, or the
send fails) it falls back to the composer. While a reply runs (or
messages already wait) it joins the conversation's send queue with its
hidden context instead. It goes to the conversation on screen (a video
opened from the library has none of its own) and never with the active
skill (an app-made request, not the user's). Both attach the technical details (project
id, scene id and window, playhead, check findings) as `chat_send`'s
`videoContext`. The core validates it (`video/context.rs`) and, for that
reply only (never stored or shown), adds ONE system note holding ONLY
values it generated or validated (the 32-hex project id, a scene id that
passed `valid_id`, seconds) and appends the free text (video and scene
titles, check findings: model-written or derived from the composition, so
possibly hostile) to the user's message as an escaped
`<video_context untrusted="true">` data block the system note says is
data, never instructions. A chip
above the composer says a video is attached and can drop it.

## Templates

`src-tauri/video-templates/<id>/` (template.json with es/en copy, theme.css,
compositions, tiny SVG assets) plus a shared OFL font set in `_fonts/`
(Inter, Montserrat, Playfair Display, JetBrains Mono, Libre Baskerville,
Libre Franklin; Latin subsets, licenses alongside). `build.rs` embeds the
folder; "Use this template" materializes it in the user's language and the
chosen aspect and writes it as a new project. Posters for the gallery are
`public/video-templates/<id>.webp`; hovering a card plays the live preview.
`decision-tree` and `editorial-chart` are conversions of HyperFrames
examples (Apache-2.0, HeyGen) from GSAP to CSS, with `NOTICE.md` and the
credit shown in the gallery. Authoring helper: `VIDEO_TEMPLATE_DUMP=<dir>
cargo test --lib dump_template_previews -- --ignored` writes every assembled
preview for a browser check.

Layout check (run it after touching any template): `node
test/template-layout-check.mjs [--shots <dir>]` dumps the previews, opens
each one in headless Chrome at its real size (1920x1080, 1080x1920,
1080x1080) and runs the app's own layout probe in it (see "Layout check in
every format" below: one script for CI and the app), which seeks every scene
and fails if visible text or an image touches the frame edge, or is
off-frame when the scene settles. `--shots` writes a
mid and an end frame per template and aspect to look at. Layouts must be
relative to the composition (`vmin`, `%`, flex/grid) with per-aspect rules
in media queries (`max-aspect-ratio: 3/4` portrait, `min-aspect-ratio: 3/4)
and (max-aspect-ratio: 5/4` square): the preview frame's viewport is the
composition size. Separately, the player stage keeps the composition's
ratio (`.video-stage` max-width tied to `--video-ratio`, the player pinned
with `inset: 0`; `src/video/videoStage.css.test.ts`): without it WebKit
crops the lower half of a 9:16 preview.

## Layout check in every format (round 25)

An export in a format other than the project's own only resizes the canvas
(`render::with_aspect`), so a layout written for one shape can come out cut
off in another. Every format the user downloads is checked first, and the
assistant's videos are checked as they are made.

- **The probe**: `src-tauri/src/video/layout_probe.js`, ONE classic script
  shared by the app, CI (`test/template-layout-check.mjs` evaluates it in
  headless Chrome) and the unit tests (`src/video/layoutProbe.test.ts`). It
  seeks the HyperFrames runtime to three moments per scene plus the settled
  end (at most 48 samples, 8 s budget), and on every visible text run and
  image reports `clipped` (partly in frame and within 2% of the short side
  of an edge: cut off) or `offframe` (entirely outside once the scene
  settled; mid-scene that is an entrance). Elements hidden by opacity,
  display, visibility or a smaller overflow-clipping ancestor are ignored.
  Findings: `{scene, time, kind, element}` with `element` = `#id "text"`,
  once per element, kind and scene.
- **The document**: `video_layout_probe(profile, project, aspect)` assembles
  the project AT THAT ASPECT exactly like the export variant (root canvases
  resized, index regenerated), appends the probe plus a `run(config)` call
  (config: scene ids, starts and durations only, `<` escaped), and registers
  it in the site registry's own `probes` ring (`MAX_PROBES = 2`), so a check
  never evicts the document a player shows. Same scheme, CSP header and
  `sandbox allow-scripts` as every preview; nothing is written.
- **The renderer** (`src/video/layoutCheck.ts`): loads it in a hidden
  `<iframe sandbox="allow-scripts">` sized to the canvas, inside a
  viewport-sized, clipped, `opacity: 0`, `aria-hidden`, `inert` box (it can
  never take focus, keys or clicks; in the viewport
  so the webview keeps laying it out; the probe also falls back to timers
  when a hidden frame gets no animation frames). Only a `nan-layout-probe`
  message whose `source` is that frame counts; it is re-validated (kinds,
  numbers, 40 issues, 120 characters, control and bidi characters out).
  One aspect at a time, one check in the whole app at a time, 15 s per
  aspect and 20 s for the whole check counted from the call
  (`CHECK_BUDGET_MS`: formats not reached in time are `null`); an
  `AbortSignal` ends it at once (the frame goes, the rest is `null`) and
  `onAspect` reports the format being checked. A timeout, an error or a cut-short check that found nothing is
  `null` = "could not check", which never holds or triggers anything. The
  token is released as soon as the frame answers.
- **Export gate** (`ExportPanel`): "Export" first checks every selected
  format (verdicts are remembered per version of the video, keyed on meta,
  sources and assets, not on the exports list; a `null` "could not check"
  is NOT remembered, so the next export tries again). One check at a time:
  while it runs Export is disabled and a second start is ignored. If the
  video changes while it is checked, the check stays on screen, its
  verdict is dropped (nothing queued, nothing shown) and the same formats
  are checked again for the new version, so a format is never queued twice
  nor judged on an old version. While it runs the panel
  says which format it is checking ("Checking the vertical (9:16) format…")
  with **Cancel export**: it aborts the check and exports NOTHING (a
  canceled check is never a pass). The formats that fit are
  queued right away; a format that would come out cut off is held and named
  (`role="alert"`, a line per format with how many elements are cut and in
  which scenes), with **Fix with the assistant** (primary, focused: sends
  the fix request directly with the findings as hidden context, the same
  path as the check's other fix button) and **Export anyway**. The list
  uses the same format labels as the sentence and names scenes by title
  ("Scene N" by position when untitled). When a gate button goes away the
  keyboard lands on the Export button, or (while it is disabled) a queue
  control, or the section heading, never on `<body>`; a fix sent from the
  Videos surface takes the keyboard to the chat composer.
- **While the assistant makes the video** (`src/video/layoutAutoFix.ts`,
  wired in `App.tsx`): `video://changed` marks the video for its
  conversation; when that turn completes (`chat://done` `completed`; a cut
  turn passes it on to its continuation, a stopped or failed one forgets
  it) the app checks all three formats and, if one is cut off, queues ONE
  automatic message for that conversation ("Automatic check of this
  video: ...", the findings as hidden video context, no skill). The
  visible text never quotes the video title: it is model-written, so it
  travels only in the hidden context, which the core cleans
  (`project::clean_title` and `context::clean` drop controls and invisible
  bidi/format characters) and escapes as untrusted data. Only the
  conversation on screen gets a message: when the turn ends elsewhere (or
  the user leaves while it is checked) the videos are held and checked
  AGAIN when the conversation comes back, so a video fixed or changed
  meanwhile is judged as it is now. It goes out through the
  composer queue when the conversation is idle and on screen, so the fix is
  part of making the video. Bounded: at most 2 automatic messages in a row
  per conversation; only a message the user sends renews the allowance (an
  automatic continuation does not). Once the allowance is used up no check
  is run at all (checks share one queue with the export gate). A check
  overtaken by a new turn is redone when that turn ends; if that turn has
  already ended, it is dropped (never left for a later, unrelated turn).
- **Authoring rules** (`video::tool::GUIDANCE`): every video must work in
  all three formats: content centered with flex/grid and a 6% safe area,
  type and spacing in `vmin`/`clamp()`, no fixed pixel positions or widths
  that assume one shape, nothing wider than 1080 px, and the model is told
  the app will send it findings to fix.

Why a renderer check and not a core tool the model calls: the check needs
real layout, which only a webview has; a tool would have to round-trip to
the renderer and wait mid-turn, and the model could skip it. Checking when
the turn ends costs the model nothing and cannot be skipped.

## Smooth motion (round 26)

How scenes move, measured by seeking the pinned runtime frame by frame in
headless Chrome (what the render service does; the preview seeks the same
way on every tick, so the MP4 and the preview show the same motion):

- The CSS adapter pauses every CSS animation and sets its `currentTime` to
  `time - start of its closest [data-start]` on each frame. Animations are
  therefore deterministic: `animation-delay` counts from the clip's
  `data-start` and `animation-fill-mode` behaves as in a browser. Repaint
  cost cannot make the MP4 stutter; only the composition's design can.
- Outside its window the runtime hides a `.clip` that is in the normal flow
  (position static, relative or sticky) and holds no timed descendant with
  `display: none`; an absolutely positioned clip only gets `visibility:
  hidden`. A scene that wraps each staggered line of a flex/grid layout in
  its own `.clip` therefore re-lays out when each one appears or ends, and
  every visible sibling jumps in ONE frame. A tester's 6-scene video had 76
  such one-frame jumps, all at clip boundaries; the same scenes with one
  stage and `animation-delay` had none, and no bundled template has any.

Rules (`video::tool::GUIDANCE`): ONE stage `.clip` per scene
(`position:absolute; inset:0`, covering the scene) holding the layout;
entrances staggered with `animation-delay` on its children; more `.clip`
elements only for absolute overlays; animations on the element that moves,
never on the `.clip`; `animation-fill-mode: both`; only `transform` and
`opacity`; entrances of 0.4 to 0.8 s finished 0.5 s before the scene ends.

The motion lint (`video::motion::lint_scene`) checks every scene a
`create_video` / `edit_video` call writes or retimes and adds WARNINGS to the
result (the scene is still written; GUIDANCE tells the model to fix them):
an in-flow `.clip` with siblings that appears or ends mid-scene, keyframes
on layout properties (width, height, margin, padding, font-size...), an
animation that ends after its scene, and a fill mode that pops (delayed
without a backwards fill, or hidden at rest without a forwards fill). It is
conservative: selectors it does not understand count as "not animated" and
as "maybe absolutely positioned", and every bundled template passes it
(`templates::tests::every_template_passes_the_motion_lint`).

## Export (contract §2)

1. `video_export_start`: the core validates the project, builds a
   deterministic STORED zip (no `exports/`), refuses it over 90 MiB, and
   POSTs `meta` + `bundle` to `{platform_base}/v1/desktop/renders` with the
   session JWT read in the core.
2. `video_export_status` (every 2 s): the renderer gets status/progress/error
   and `ready`, NEVER the presigned URL.
3. `video_export_download`: the core asks for a fresh status, streams the
   presigned MP4 (https on `*.r2.cloudflarestorage.com` only; the debug mock
   may use loopback http; no credentials, redirects re-checked, 2 GiB
   cap, `ftyp` magic) to `exports/<slug>.mp4` (temp + rename), emitting
   `video://download` progress. Then Open / Show in folder / Save a copy.
4. `video_export_cancel` (a running render), `video_export_abort` (an
   upload still in flight: the request is aborted, the server never admits
   it; once every byte is sent the upload can no longer be aborted, since
   the server may already have admitted and charged it: the panel shows
   "Preparando…" and the render id that comes back can be canceled, which
   refunds), `video_export_quota` ("Te quedan 84 min de exportación este mes").
   The panel refuses to start when the balance does not cover the video
   ("Este vídeo usa 1 min 30 s y te quedan 42 s"), offers "Ver planes" after
   a subscription/quota refusal and "Volver a iniciar sesión" after an
   expired session, and checks the session before calling a render gone on
   a 404 (the enterprise "no credential").

Several formats (round 24): the panel lists 16:9, 9:16 and 1:1 as
checkboxes (the project's own preselected) and shows what they cost before
starting (ceil(duration) per format, against the remaining balance; it
refuses to start when they do not fit). `video_export_start` and
`video_export_download` take an optional `aspect`: another format than the
project's is built IN MEMORY by `render::with_aspect`, which applies what
the editor's format switch writes (`video.json` aspect, regenerated
`index.html`, every scene root fitted with `with_root_canvas`; a test
checks it equals a real switch byte for byte) and never touches the project
on disk; the variant passes the same project checks again
(`render::check_bundle`: `validate_meta` plus the preview assembly) before
it is zipped. Files are named after the format (`promo-vertical.mp4`,
`-horizontal`, `-square`), from the format the core recorded when it
started that render (`RenderAspects`); only a render resumed after a
restart uses the renderer's value (a closed set, it only picks the suffix). The formats run through ONE queue per project
(`src/video/exportQueue.ts`, shared by the editor and the side panel and
kept while the panel is closed): strictly one after another, so we never
hold more than one active render or burst creates; a 429
(`too_many_active`, `rate_limited`) or 503 `busy` anyway waits
`Retry-After` (30 s without it, at most 10 waits; the row counts down
with the same first sentence as the matching error) and tries again; a
cancel wakes it at once. A cancel during the upload is a cancel even if the
server then answers 429/503 (nothing was admitted). Each format has its
own row (progress, Cancel, Open / Show in folder / Save a copy); "Cancel
the rest" cancels the formats not started yet (the one rendering keeps its
own Cancel); a refusal that
applies to all (quota, subscription, session, size, invalid project) skips
the remaining ones. Only the render in flight is remembered across a reopen
(with its format), not the formats still waiting.

The side panel's "Export" button opens the same `ExportPanel` under the
player (lazy `PreviewExport`: it loads the project and runs the lint, so a
video with check errors cannot be exported from there either).

The routes are a closed set (`render::Route`); render ids are validated
(`[A-Za-z0-9_-]{1,64}`); every API code maps to a typed error with plain
copy: 402 quota (remaining + renewal date) / subscription, 413, 422,
429 too-many-active / rate-limited (Retry-After), 409 canceled, 503 busy /
storage_unavailable / unavailable (retryable, Retry-After), no credential
(NaN 401, enterprise 404 on create/quota) as "sign in again", failed/timeout
renders, offline, expired link. The job status carries `charge_seconds`.
The upload window is 10 minutes (the platform proxy's read timeout): the
bundle streams in chunks with `video://upload` progress, and the panel warns
when the pace projects past ~9 minutes.
An export in flight is remembered per project in `localStorage` (a
convenience: reopening the editor resumes the progress).

Mock: `node test/mock-device.mjs` serves the render routes too
(`test/mock-renders.mjs`; standalone on port 14330). With
`NAN_DESKTOP_MOCK_PLATFORM=http://127.0.0.1:14322 pnpm tauri dev` a debug
build exports against it (loopback http download allowed only then).
`VIDEO_MOCK_RENDERS=http://127.0.0.1:14330 cargo test --lib
export_round_trip_against_the_mock -- --ignored` runs the whole flow.

## Telemetry

Only the tool names `create_video` / `edit_video` with outcome and duration
(the existing tool-call events). No titles, texts, scenes, paths or render
ids.

## Release checklist (real app, every OS)

1. Template gallery: posters show; hovering plays; "Use this template" in
   9:16 opens the editor with a vertical player.
2. Preview isolation: a scene script that tries `window.parent.document`,
   `fetch("https://example.com")`, `localStorage` fails (SecurityError / CSP)
   and nothing leaves the machine.
3. Audio: a project with music plays sound in the preview after pressing
   play (WebKit autoplay policy inside the sealed frame).
4. Editor: change a text, a color, the logo, reorder and retime scenes,
   switch to 1:1; the preview follows each change.
5. Export against staging: quota line, progress, download, Open, Show in
   folder; a 402 and a 413 show their messages.
6. Full screen: the player's button fills the screen (macOS and Windows);
   Escape leaves it and the side panel stays open.
7. Several formats: export 16:9 + 9:16 from a 16:9 project; they run one
   after another, the project stays 16:9, the files are
   `<title>-horizontal.mp4` / `<title>-vertical.mp4`.
8. Ask the assistant to change an open video: the side panel (and the
   editor, if open) shows the new version by itself, at the same playhead.
