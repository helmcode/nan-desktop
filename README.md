# Helmcode Desktop (nan-desktop)

[![CI](https://github.com/helmcode/nan-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/helmcode/nan-desktop/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/helmcode/nan-desktop)](https://github.com/helmcode/nan-desktop/releases/latest)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-proprietary%20(source--available)-red)
![Telemetry](https://img.shields.io/badge/telemetry-none-success)

Native desktop app for two AI inference platforms that share one product:

- **NaN community** ([nan.builders](https://nan.builders)): a paid community
  of Spanish-speaking builders working with AI and agents.
- **Helmcode enterprise** ([helmcode.com](https://helmcode.com)): a
  self-service inference platform for companies.

You need an account on one of them to use the app. Built with Tauri v2
(Rust core) + React 19 + Vite. No Docker, no external runtime, **zero
telemetry**: the app only talks to the two platforms' own APIs.

**Source-available, community-built.** The source is public so the
community can review, audit and contribute to it; the product is
proprietary to Helmcode S.L. (see [LICENSE](LICENSE)). Contributions are
very welcome: start with [CONTRIBUTING.md](CONTRIBUTING.md).

<!-- Screenshots: add images under docs/images/ and reference them here. -->

## Features (v0.2.10)

- **Chat** with streaming replies, markdown and highlighted code, a curated
  model picker, a stop button and crash-safe persistence of partial replies.
- **Sign in through the browser** (device flow) to a NaN community or a
  Helmcode enterprise account. No API keys to paste.
- **Conversation memory** synced to your account across devices, or kept
  only on this device (Settings → Memory).
- **Per-account private data**: conversations, skills, folder permissions
  and tool settings live in a separate realm per signed-in account, so
  another account on the same computer sees none of it.
- **Work with your files**: grant folders and the assistant can list, read,
  write, move and delete files there, with a native confirmation for every
  single action. Running commands is experimental and off by default.
- **Websites**: the `write_website` tool builds small self-contained static
  sites, previewed in an isolated frame (no network, no access to the app).
- **Previews** of what the assistant produces: PDF, Word, spreadsheets,
  images, code, JSON/YAML, logs and websites, with "show in folder".
- **Share artifacts as links**: on Helmcode, with members of your
  organization or the whole organization; on NaN, with other NaN members by
  email (they sign in to open it). "Shared links" lists and revokes them.
- **Skills**: save reusable instructions as skills; Helmcode organizations
  can share approved skills with their team.
- **Images**: generate images in the chat and edit them in the Image Studio
  (where the platform offers it).
- **Voice**: read replies aloud and dictate messages.
- **Web search** the model can call on its own, where the platform offers it.
- **Recovery screen** instead of a blank window if something breaks; your
  conversations are never lost.
- **Signed auto-updates**, checked every 2 hours and when you come back to
  the app.
- **English and Spanish** interface.

## Download

Get the installer for your system at
**[helmcode.com/es/download](https://helmcode.com/es/download)**, or from the
[latest GitHub release](https://github.com/helmcode/nan-desktop/releases/latest).

| Platform | Package | Status |
|----------|---------|--------|
| macOS (Apple silicon and Intel) | `.dmg` | Validated. Signed with Apple Developer ID and notarized |
| Windows x64 | `.msi` / setup `.exe` | Pending validation. Not code-signed yet: SmartScreen shows "Windows protected your PC" → "More info" → "Run anyway" |
| Linux x64 | AppImage / `.deb` / `.rpm` | Built and smoke-tested in CI. Unsigned. Signing in needs a Secret Service provider (GNOME Keyring or KWallet) |

Verify the SHA-256 shown next to each asset on the GitHub release before
installing. Signing details: [SIGNING.md](SIGNING.md).

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
