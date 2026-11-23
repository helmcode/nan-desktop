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

## Editor

`video_get` / `video_update` (title, aspect, values, scene order and
durations, voice/music volume or removal) / `video_pick_asset` (a SLOT:
image variable, music, voice; the core opens the native dialog, applies the
chat-attachment refusals: app data, credential stores, key files; checks
type and magic; names the asset itself) / `video_delete` (after a
confirmation in the app's own dialog: the macOS webview has no JavaScript
confirm panel). The renderer never sends a path or HTML. A change reloads
the preview at the same playhead (or at the start of the scene that was
edited).

"Ask for a change in this scene" and "Ask the assistant to fix it" add a
plain request to the composer (never replacing what the user typed), e.g.
`Escena «Mensaje» (0:07 a 0:11): `, and attach the technical details (project
id, scene id and window, playhead, check findings) as `chat_send`'s
`videoContext`. The core validates it (`video/context.rs`: ids, caps,
control and bidi characters stripped) and adds ONE system note before the
user's message for that reply only; it is never stored or shown. A chip
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
   it), `video_export_quota` ("Te quedan 84 min de exportación este mes").
   The panel refuses to start when the balance does not cover the video
   ("Este vídeo usa 1 min 30 s y te quedan 42 s"), offers "Ver planes" after
   a subscription/quota refusal and "Volver a iniciar sesión" after an
   expired session, and checks the session before calling a render gone on
   a 404 (the enterprise "no credential").

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
