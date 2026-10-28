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

Requirements: Node 24+ and pnpm 10, Rust stable via rustup.

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

## Committing tests

Behavior changes require tests that pin the behavior (Spec-Driven: write the
failing test first where practical). The repo's Rust suites are pure and run
everywhere; integration scripts under `test/` use dependency-free Node mocks.

## Code of conduct

See `CODE_OF_CONDUCT.md`. Be excellent to each other.
