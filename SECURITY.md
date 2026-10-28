# Security policy

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability), or contact the maintainers through the
Helmcode organization. We aim to acknowledge reports within 2 business days.

## Scope

In scope:
- The nan-desktop desktop application (this repository): credential storage and
  handling (OS keychain, Rust core), Tauri IPC boundaries, the device login
  flow, markdown/sanitization of model output, the tool executor and its
  permission model, the auto-update pipeline.
- Anything that would exfiltrate data, keys or conversations outside the two
  owned services (NaN community, Helmcode enterprise).

Out of scope (report to those teams instead): the inference services
themselves, the web portals, LiteLLM.

## Security model (what we promise)

- **Zero telemetry.** The app makes network calls ONLY to
  `api.nan.builders` / `cloud-api.nan.builders` and `api.helmcode.com`
  (mock overrides exist solely in debug builds).
- **Credentials live in the OS keychain**, read only by the Rust core. They
  never enter the web renderer process and are never logged.
- **Model output is sanitized** (rehype-sanitize last) before rendering; raw
  HTML is never rendered.
- **Tool executor (when enabled) asks per action**: model proposes, user
  approves; file access is granted per folder.

## Supported versions

| Version | Supported |
|---------|-----------|
| latest tag + `main` | yes |
| older tags | best effort |

## Known limitations

- CI/nightly installers are **not code-signed yet** (macOS notarization and
  Windows Authenticode are on the roadmap — tracked in the repository).
  Verify installer hashes against the GitHub release notes.
