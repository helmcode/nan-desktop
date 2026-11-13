# Contributing to nan-desktop

Thanks for helping build the NaN/Helmcode desktop app. This is a **proprietary,
community-built** product: the source is public for review and contribution, and
every contribution is licensed to Helmcode S.L. (see `LICENSE`, section 3b).

## Ground rules (read first)

1. **No secrets, ever.** API keys, tokens and credentials live ONLY in the OS
   keychain at runtime. Never commit, hardcode, log or paste them. `.env` files
   are ignored and must stay ignored. If you leak a secret, rotate it first and
   tell us immediately.
2. **Zero telemetry.** The app sends nothing anywhere except calls to the two
   configured inference services. PRs that add analytics, tracking, crash
   reporting or "phone home" behavior of any kind will be rejected (spec S8).
3. **Locked endpoints.** The app talks to exactly two services (NaN community
   and Helmcode enterprise). Do not add user-configurable base URLs or generic
   OpenAI-compatible support (spec S2/S12).
4. **Credentials never enter the renderer.** All HTTP with credentials happens
   in the Rust core; the web layer only receives non-sensitive payloads
   (spec S4). New IPC surfaces must keep that boundary.

## Development setup

Requirements on every OS: Node 24+ and pnpm 10, Rust stable via rustup.

Per-OS prerequisites (the Tauri v2 system dependencies):

- **Linux (Debian/Ubuntu)**: the same packages CI installs (`.github/workflows/ci.yml`):

  ```bash
  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf libasound2-dev
  ```

  Signing in stores the session in the OS keyring through the Secret Service
  API, so a provider (GNOME Keyring or KWallet) must be running in your
  desktop session. Release builds have the same requirement for end users
  until the keyring fallback lands; minimal window managers and headless
  sessions cannot log in today.
- **Windows**: Microsoft C++ Build Tools (Visual Studio Build Tools with the
  "Desktop development with C++" workload, MSVC + Windows SDK) and the
  WebView2 runtime (preinstalled on Windows 10 1803+ and Windows 11; install
  the Evergreen runtime otherwise). Use the `x86_64-pc-windows-msvc` Rust
  toolchain.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`). Add
  `rustup target add x86_64-apple-darwin` to build or test the Intel
  target on Apple Silicon (tests run under Rosetta 2).

```bash
pnpm install
pnpm tauri dev          # run the app with hot reload
pnpm build              # frontend build (typecheck + vite)
cd src-tauri && cargo fmt && cargo clippy -- -D warnings && cargo test
```

Local end-to-end checks (no real backend needed):

```bash
node test/mock-device.mjs   # device-flow mock   (port 14322)
node test/mock-chat.mjs     # chat completions mock (port 14323)
node test/t13-check.mjs && node test/t4-check.mjs
```

## Pull requests

- Never push directly to `main`; open a PR (CI runs the full 3-OS matrix).
- Keep PRs reviewable (~400 changed lines or less when possible; atomic auth
  units are the exception and go through security review).
- Conventional Commits (`feat:`, `fix:`, `chore:`, ...), English.

Every PR must include in its description:

```markdown
- [ ] cargo fmt --check / clippy -D warnings / cargo test all green
- [ ] pnpm build green
- [ ] relevant node test/t*-check.mjs green
- [ ] no secrets, no telemetry, no new network endpoints
- [ ] credentials still never cross to the renderer
- [ ] docs (README) updated when behavior changed
```

## Releasing (maintainers)

Releases are cut from `main` by tag; `.github/workflows/release.yml` does the
rest (details and job graph in `SIGNING.md`, "Release pipeline at a glance").

1. **Bump the version in the 3 manifests** to the same `X.Y.Z` (patch by
   default): `package.json`, `src-tauri/tauri.conf.json`, and the
   `[package]` version of `src-tauri/Cargo.toml` (then `cargo check` so
   `Cargo.lock` follows). Add the `## X.Y.Z - <title>` section to
   `CHANGELOG.md`.
2. **Merge** the bump through a PR (CI green).
3. **Tag from `main`** (strict `vX.Y.Z`; anything else never triggers a
   release, and the guard fails if a manifest disagrees with the tag):

   ```bash
   git fetch origin && git checkout origin/main
   git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
   ```

4. **Watch the run** (Actions -> Release): `prepare`, the 4 `build` legs,
   `rename-assets` (stable names + signed `latest.json`) and `smoke`
   (msi silent install, deb on Ubuntu 22.04/24.04, AppImage start, macOS
   Gatekeeper checks) must all be green. Read the signing summary.
5. **Smoke it yourself** from the draft release: install on at least one
   real machine per OS you can reach, sign in, send a chat.
6. **Approve the `release` environment** on the waiting `publish` job. That
   approval is the publish decision: the job sets `draft=false` and
   `make_latest=true`, which also makes `latest.json` live for the
   auto-updater. If macOS is not Developer ID signed + notarized, `publish`
   refuses; to ship anyway, re-run the workflow on the tag via "Run
   workflow" with `allow_unsigned` checked (a recorded decision).

One-time setup: Settings -> Environments -> `release` with at least one
required reviewer (and "Prevent self-review" if the team allows it).
`publish` refuses to run without that protection.

**No downgrades. Fix forward.** Never delete a published release or re-point
a tag: installed apps only update to a HIGHER semver, and the stable
`releases/latest/download/` links must not move backwards. If a release is
bad, ship `X.Y.(Z+1)` with the fix through the same procedure. A failed run
before `publish` can be re-run on the same tag (assets are replaced).

## Committing tests

Behavior changes require tests that pin the behavior (Spec-Driven: write the
failing test first where practical). The repo's Rust suites are pure and run
everywhere; integration scripts under `test/` use dependency-free Node mocks.

## Code of conduct

See `CODE_OF_CONDUCT.md`. Be excellent to each other.
