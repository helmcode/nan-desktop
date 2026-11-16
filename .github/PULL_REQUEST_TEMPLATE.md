<!--
Thanks for contributing! Title: Conventional Commit (e.g. "fix(preview): ...").
Describe WHAT changed and WHY. See CONTRIBUTING.md for the full workflow.
-->

## What and why

Closes #

## How it was tested

<!-- Tests added/updated, commands run, manual checks (OS + app flow). -->

## Checklist

- [ ] Linked issue (or explained why none is needed)
- [ ] Tests added or updated for every behavior change
- [ ] `pnpm test` / `pnpm exec tsc --noEmit` / `pnpm build` green
- [ ] `cargo fmt --check` / `cargo clippy --all-targets -- -D warnings` / `cargo test` green (`--manifest-path src-tauri/Cargo.toml`)
- [ ] Relevant `node test/*-check.mjs` green
- [ ] No secrets committed; credentials still never cross to the renderer
- [ ] Zero telemetry preserved; no new network endpoints
- [ ] UI copy added in both English and Spanish (if any)
- [ ] Docs updated when behavior changed
- [ ] Conventional Commit title; ~400 changed lines or less where practical
