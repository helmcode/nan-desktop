# Helmcode Desktop (nan-desktop)

[![CI](https://github.com/helmcode/nan-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/helmcode/nan-desktop/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/helmcode/nan-desktop)](https://github.com/helmcode/nan-desktop/releases/latest)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-proprietary%20(source--available)-red)
![Telemetry](https://img.shields.io/badge/telemetry-technical%20only%2C%20no%20content-informational)

Native desktop app for two AI inference platforms that share one product:

- **NaN community** ([nan.builders](https://nan.builders)): a paid community
  of Spanish-speaking builders working with AI and agents.
- **Helmcode enterprise** ([helmcode.com](https://helmcode.com)): a
  self-service inference platform for companies.

You need an account on one of them to use the app. Built with Tauri v2
(Rust core) + React 19 + Vite. No Docker, no external runtime, and **no
third parties**: the app only talks to the two platforms' own APIs.

**Telemetry (always on, technical only).** To fix bugs and understand how
the app is used, it sends technical usage and error data (app start, how a
reply ended, which built-in tool ran and whether it worked, which kind of
error was shown, where a crash happened) to the signed-in platform's own API.
It never sends your conversations, prompts, files, file names, paths, URLs,
commands, searches, emails or anything you write. It cannot be turned off.
The exact events and fields are listed in
[SECURITY.md](SECURITY.md#telemetry-what-the-app-sends).

**Source-available, community-built.** The source is public so the
community can review, audit and contribute to it; the product is
proprietary to Helmcode S.L. (see [LICENSE](LICENSE)). Contributions are
very welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- Screenshots: add images under docs/images/ and reference them here. -->

## Features

- **AI chat with your local files and workspaces**: streaming replies with
  markdown and code, a curated model picker, and conversation memory. Grant
  folders and the assistant can work with the files in them, with a native
  confirmation for every action.
- **Artifacts sharing**: share what the assistant produces as links. Access
  is sign-in-gated, so only the people you share with can open them, and you
  can revoke a link at any time.
- **Assistant browser**: the assistant can open web pages in a browser
  window inside the app, read them, click and type, while you watch, take
  over or stop it. It never types passwords or card details, and sign-ins
  and payments always ask you first.
- **Mini-sites**: the `write_website` tool builds small self-contained static
  websites you can preview and share.
- **Skills**: save reusable instructions as skills; Helmcode organizations
  can share approved skills with their team.
- **Per-account data privacy**: conversations, skills, folder permissions and
  settings are kept separate per signed-in account.
- **Sandboxed previews** of documents, spreadsheets, images, code and
  websites, rendered in an isolated frame with no access to the app.
- **Crash recovery**: a recovery screen instead of a blank window if
  something breaks; your conversations are never lost.
- **Cross-platform**: macOS, Windows and Linux, with signed auto-updates.
- **Browser sign-in** to a NaN community or Helmcode enterprise account. No
  API keys to paste.

## Download

Get the installer for your system at
**[helmcode.com/es/download](https://helmcode.com/es/download)**, or from the
[latest GitHub release](https://github.com/helmcode/nan-desktop/releases/latest).

| Platform | Packages |
|----------|----------|
| macOS (Apple silicon and Intel) | `.dmg` |
| Windows x64 | `.msi` / setup `.exe` |
| Linux x64 | AppImage / `.deb` / `.rpm` |

Verify the SHA-256 shown next to each asset on the GitHub release before
installing. Code-signing status per platform: [SIGNING.md](SIGNING.md). On Linux,
signing in needs a Secret Service provider (GNOME Keyring or KWallet).

## Build from source

Requirements: **Node 24+**, **pnpm 10** (`corepack enable` picks the pinned
version from `package.json`), **Rust stable** via [rustup](https://rustup.rs),
and the Tauri v2 system dependencies for your OS (listed in
[CONTRIBUTING.md](CONTRIBUTING.md#development-setup)).

```bash
git clone https://github.com/helmcode/nan-desktop.git
cd nan-desktop
pnpm install
pnpm tauri dev      # run the app with hot reload
pnpm tauri build    # local release bundle (unsigned) in src-tauri/target/release/bundle/
```

Run the same checks CI runs:

```bash
pnpm test                 # frontend tests (Vitest)
pnpm exec tsc --noEmit    # typecheck
pnpm build                # typecheck + Vite build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Local builds talk to the real platforms, so you still sign in with your own
account. Debug builds also accept local mocks for end-to-end checks without
an account (see `test/mock-*.mjs` and [CONTRIBUTING.md](CONTRIBUTING.md)).

## Repository layout

| Path | What lives there |
|------|------------------|
| `src/` | React UI (chat, settings, previews, artifacts, skills, image studio, i18n) and its Vitest tests (`*.test.ts[x]`) |
| `src-tauri/src/` | Rust core: auth (device flow), encrypted credential vault, chat streaming, tools and approvals, realms, memory sync, artifacts, site preview, updater |
| `test/` | Dependency-free Node mocks of the platforms and acceptance checks (`t*-check.mjs`) |
| `scripts/` | Release signing, icon and updater-manifest helpers |
| `.github/workflows/` | `ci.yml` (3-OS checks), `release.yml` and `release-dryrun.yml` |
| `docs/` | Engineering notes ([ARCHITECTURE.md](docs/ARCHITECTURE.md)) and how data and memory are handled ([MEMORY.md](docs/MEMORY.md)) |

## Privacy and security

- No analytics, tracking or crash reporting. Network calls go only to the
  NaN community and Helmcode enterprise APIs.
- Credentials live in an encrypted vault read only by the Rust core; they
  never reach the web layer and are never logged.
- File access is per folder, and every action needs your approval.
- The assistant's browser is isolated from the app (no access to its
  commands, credentials or files, a private data store, downloads blocked)
  and asks before using each website.

Details in [SECURITY.md](SECURITY.md) and [docs/MEMORY.md](docs/MEMORY.md).
**Found a vulnerability? Do not open a public issue:** follow
[SECURITY.md](SECURITY.md).

## Community

- Questions and ideas: [GitHub Discussions](https://github.com/helmcode/nan-desktop/discussions)
- Bugs and feature requests: [Issues](https://github.com/helmcode/nan-desktop/issues/new/choose)
- Where to get help with your account: [SUPPORT.md](SUPPORT.md)
- Release notes: [CHANGELOG.md](CHANGELOG.md)
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## License

Proprietary, source-available. See [LICENSE](LICENSE). "NaN" and "Helmcode"
are trademarks of Helmcode S.L.
