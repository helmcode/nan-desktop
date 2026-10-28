<!-- Describe WHAT changed and WHY. Link related issues. -->

## Checklist

- [ ] `cargo fmt --check` / `cargo clippy -- -D warnings` / `cargo test` green
- [ ] `pnpm build` green
- [ ] relevant `node test/t*-check.mjs` green
- [ ] No secrets committed; credentials still never cross to the renderer
- [ ] Zero telemetry preserved; no new network endpoints
- [ ] README/docs updated when behavior changed
- [ ] Conventional Commit title; ~400 changed lines or less where practical
