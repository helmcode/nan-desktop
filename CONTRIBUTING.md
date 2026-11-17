# Contributing to nan-desktop

Thanks for helping build the NaN / Helmcode desktop app. This is a
**proprietary, community-built** product: the source is public for review
and contribution, and every contribution is licensed to Helmcode S.L.
(see [LICENSE](LICENSE), section 3b). By opening a pull request you confirm
you have the right to contribute that code under those terms.

- Questions: [GitHub Discussions](https://github.com/helmcode/nan-desktop/discussions) (Q&A).
- Bugs and feature requests: [open an issue](https://github.com/helmcode/nan-desktop/issues/new/choose).
- Security problems: **never** in public. Follow [SECURITY.md](SECURITY.md).
- Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules (read first)

These rules come from the product spec (the `S*` ids you will see in code
comments and in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). PRs that break
them are rejected regardless of quality.

1. **No secrets, ever.** API keys, tokens and credentials live ONLY in the
   encrypted vault at runtime. Never commit, hardcode, log or paste them
   (not in issues either). `.env` files are ignored and must stay ignored.
   If you leak a secret, rotate it first and tell us immediately.
2. **No third parties, no user content in telemetry (S8).** The app talks
   only to the two platforms' own APIs. The built-in telemetry
   (`src-tauri/src/telemetry.rs`, documented in
   [SECURITY.md](SECURITY.md#telemetry-what-the-app-sends)) sends technical
   metadata to those same APIs and nothing else. PRs that add third-party
   analytics, tracking or crash reporting, or that put any user content
   (text, prompts, file names, paths, URLs, commands, queries, emails,
   error messages) into a telemetry event, will be rejected. New events
   use props from fixed sets only and extend the builder tests.
3. **Locked endpoints (S2/S12).** The app talks to exactly two services
   (NaN community and Helmcode enterprise). Do not add user-configurable
   base URLs or generic OpenAI-compatible support.
4. **Credentials never enter the renderer (S4).** All HTTP with
   credentials happens in the Rust core; the web layer only receives
   non-sensitive payloads. New IPC commands must keep that boundary.
5. **The user approves every file action.** Tools propose, the Rust core
   asks with a native dialog, and only the exact approved action runs. Do
   not add a path that bypasses the approval or the folder grants.

## Before you start: issue first for big changes

- **Small fixes** (typos, docs, an obvious bug with a test): open the PR
  directly.
- **Anything bigger** (a feature, a new IPC command, a new dependency, UI
  flow changes, a refactor): open an issue or a discussion first and wait
  for a maintainer to agree on the approach. This avoids work that cannot
  be merged because of the ground rules above.
- Look for issues labeled
  [`good first issue`](https://github.com/helmcode/nan-desktop/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/helmcode/nan-desktop/labels/help%20wanted).
  Comment on the issue so nobody duplicates your work.

## Development setup

Requirements on every OS: **Node 24+**, **pnpm 10** (`corepack enable`
uses the version pinned in `package.json`) and **Rust stable** via rustup.

Per-OS prerequisites (the Tauri v2 system dependencies):

- **Linux (Debian/Ubuntu)**: the same packages CI installs
  (`.github/workflows/ci.yml`):

  ```bash
  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev patchelf libasound2-dev
  ```

  Signing in stores the session in the OS keyring through the Secret
  Service API, so a provider (GNOME Keyring or KWallet) must be running in
  your desktop session. Minimal window managers and headless sessions
  cannot sign in today.
- **Windows**: Microsoft C++ Build Tools ("Desktop development with C++"
  workload: MSVC + Windows SDK) and the WebView2 runtime (preinstalled on
  Windows 10 1803+ and Windows 11). Use the `x86_64-pc-windows-msvc` Rust
  toolchain.
- **macOS**: Xcode Command Line Tools (`xcode-select --install`). Add
  `rustup target add x86_64-apple-darwin` to build or test the Intel
  target on Apple Silicon (tests run under Rosetta 2).

## Workflow

1. **Fork** the repository and clone your fork.
2. **Branch** from an up-to-date `main`:

   ```bash
   git remote add upstream https://github.com/helmcode/nan-desktop.git
   git fetch upstream
   git switch -c fix/short-description upstream/main
   ```

3. **Install and run:**

   ```bash
   pnpm install
   pnpm tauri dev
   ```

4. **Write the test first.** Derive the expected behavior from the issue,
   encode it in a test that fails, then implement until it passes (see
   [Tests](#tests-are-mandatory)).
5. **Run the gates** below and make sure all of them are green.
6. **Commit** with [Conventional Commits](#commit-messages) and push to
   your fork.
7. **Open a pull request** against `helmcode/nan-desktop:main` and fill in
   the template checklist. CI runs automatically; a maintainer reviews.

## Local gates (what CI checks)

Run these from the repository root before pushing. They mirror the `checks`
job of [`.github/workflows/ci.yml`](.github/workflows/ci.yml), which runs on
Ubuntu, macOS and Windows for every pull request to `main`.

```bash
# Frontend
pnpm test                 # Vitest suite
pnpm exec tsc --noEmit    # typecheck
pnpm build                # tsc + Vite production build

# Rust core
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml

# Acceptance checks CI also runs (Node, no dependencies)
node test/t8-check.mjs
node test/t14-check.mjs
node test/updater-check.mjs
```

CI additionally runs `pnpm audit --prod --audit-level high` and
`shellcheck` on the signing scripts (Linux), a PowerShell parse of
`scripts/windows-sign.ps1` (Windows), the macOS signing spec
(`test/macos-sign-test.sh`), and the Rust tests for `x86_64-apple-darwin`
under Rosetta (the `rust-macos-x86_64` job). If you touch those files, run
the matching check locally when you can.

### End-to-end checks with local mocks

Debug builds accept local mock platforms, so you can exercise flows without
an account. The mocks are dependency-free Node servers:

```bash
node test/mock-device.mjs   # device-flow sign-in mock (port 14322)
node test/mock-chat.mjs     # chat completions mock     (port 14323)
node test/t13-check.mjs && node test/t4-check.mjs
```

Each `test/t*-check.mjs` documents in its header what it proves and which
mock it needs. Release builds ignore every mock override.

## Tests are mandatory

Every behavior change (feature, fix or refactor) must come with tests that
pin the behavior. PRs without tests are not merged.

- **Frontend**: Vitest + Testing Library, next to the code
  (`src/**/*.test.ts[x]`).
- **Rust**: unit tests in the module (`#[cfg(test)]`). The suites are pure
  and run on every OS; do not depend on the real keychain or network.
- **Wire contracts**: if you change a request the core sends to the
  platform, update the matching mock in `test/` and its `t*-check.mjs`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/), in English:

```
feat(preview): render csv files as a table
fix(updater): keep the notice when a check fails offline
docs: explain folder grants in the README
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `chore`,
`ci`. The PR title follows the same format (it becomes the squash commit).

## Pull requests

- Never push to `main` directly; everything lands through a PR.
- Keep PRs focused and reviewable (around 400 changed lines or less where
  practical). Split large work into several PRs.
- Update the docs when behavior changes: the [README](README.md) for
  user-visible features, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) or
  the module header for internals, [SECURITY.md](SECURITY.md) and
  [docs/MEMORY.md](docs/MEMORY.md) for anything about data, credentials or
  network calls.
- Do not bump versions or edit `CHANGELOG.md` release sections; maintainers
  do that when they cut a release.
- UI text goes through `src/i18n/` in **both** English and Spanish.

The PR template asks you to confirm:

```markdown
- [ ] Linked issue (or explained why none is needed)
- [ ] Tests added or updated for every behavior change
- [ ] pnpm test / pnpm exec tsc --noEmit / pnpm build green
- [ ] cargo fmt --check / clippy -D warnings / cargo test green (--manifest-path src-tauri/Cargo.toml)
- [ ] Relevant node test/*-check.mjs green
- [ ] No secrets committed; credentials still never cross to the renderer
- [ ] No new network endpoints or third parties; telemetry carries no user content
- [ ] UI copy added in both English and Spanish (if any)
- [ ] Docs updated when behavior changed
- [ ] Conventional Commit title; ~400 changed lines or less where practical
```

## Releasing (maintainers)

Releases are cut from `main` by tag; `.github/workflows/release.yml` does the
rest (details and job graph in [SIGNING.md](SIGNING.md), "Release pipeline
at a glance"). `.github/workflows/release-dryrun.yml` rehearses the pipeline
without publishing.

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

4. **Watch the run** (Actions → Release): `prepare`, the 4 `build` legs,
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

One-time setup: Settings → Environments → `release` with at least one
required reviewer (and "Prevent self-review" if the team allows it).
`publish` refuses to run without that protection.

**No downgrades. Fix forward.** Never delete a published release or re-point
a tag: installed apps only update to a HIGHER semver, and the stable
`releases/latest/download/` links must not move backwards. If a release is
bad, ship `X.Y.(Z+1)` with the fix through the same procedure. A failed run
before `publish` can be re-run on the same tag (assets are replaced).
