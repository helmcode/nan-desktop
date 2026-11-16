# Security policy

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for security
reports.**

1. **Preferred:** GitHub private vulnerability reporting on this repository:
   [Security → Report a vulnerability](https://github.com/helmcode/nan-desktop/security/advisories/new).
2. **If that is unavailable to you:** email **support@helmcode.com** with the
   subject `[security] nan-desktop` and ask for a private channel. Do not
   include exploit details in that first email.

Please include the app version, OS, the affected component and steps to
reproduce. Never send real credentials or other people's data; redact
tokens.

What to expect: we acknowledge reports within 2 business days, keep you
updated while we work on a fix, and credit you in the release notes if you
wish. Please give us a reasonable time to ship a fix before any public
disclosure, and do not test against other users' accounts or data.

## Scope

In scope:
- The nan-desktop desktop application (this repository): credential storage and
  handling (encrypted vault + OS keychain master key, Rust core), Tauri IPC
  boundaries, the device login
  flow, markdown/sanitization of model output, the tool executor and its
  permission model, per-user data realms, artifact sharing, the sandboxed
  website preview, the auto-update pipeline.
- Anything that would exfiltrate data, keys or conversations outside the two
  owned services (NaN community, Helmcode enterprise).

Out of scope here: the inference platforms themselves (`api.nan.builders`,
`api.helmcode.com`), the web portals and the artifact pages. Report those
through the same private channel; we route them to the right team.

## Security model (what we promise)

- **Zero telemetry.** The app makes network calls ONLY to
  `api.nan.builders` / `cloud-api.nan.builders` and `api.helmcode.com`
  (mock overrides exist solely in debug builds).
- **Credentials live in an encrypted vault**, read only by the Rust core. They
  never enter the web renderer process and are never logged (see
  [Credential storage](#credential-storage) below).
- **Model output is sanitized** (rehype-sanitize last) before rendering; raw
  HTML is never rendered.
- **Tool executor (when enabled) asks per action**: model proposes, user
  approves; file access is granted per folder.
- **Local data is isolated per signed-in user** (see
  [Per-user data realms](#per-user-data-realms) below): another account on the
  same device, even of the same tenant, sees nothing of yours.
- **Websites built by the assistant are isolated.** A site written by the
  `write_website` tool is previewed from its own `nan-site:` scheme inside an
  `<iframe sandbox="allow-scripts">` (opaque origin, no `allow-same-origin`)
  with a CSP header of `default-src 'none'; connect-src 'none'`: its scripts
  reach neither the app, nor storage, nor the Tauri bridge, nor the network.
  Implementation: `src-tauri/src/site_preview.rs`.
- **Sharing is explicit and scoped.** Artifacts are uploaded only when the
  user presses Share and confirms; requests go through a closed route
  allowlist in the Rust core (`src-tauri/src/artifacts.rs`). Helmcode links
  are limited to org members or the whole org; NaN links to NaN members, who
  must sign in to open them. A detected secret needs its own confirmation.
- **Crash logs are redacted.** Errors reaching the recovery screen are logged
  with tokens (`sk-`, `hke_`, `nan_`, `Bearer`, JWTs) redacted.

## Credential storage

Implementation: `src-tauri/src/credentials.rs`.

All secrets (per-user inference API keys and login session tokens) live in
ONE file, `vault.bin` in the app data directory. Since the per-user realms,
each secret is stored under the signed-in user's realm key
(`<profile>:<user-id>` and `<profile>:<user-id>.session`):

- **Encryption:** AES-256-GCM, a fresh random 96-bit nonce on every write, a
  versioned envelope (`HCDVAULT | version | nonce | ciphertext+tag`) whose
  header is authenticated as associated data.
- **Master key:** 32 random bytes from the OS CSPRNG.
  - Release builds: stored as the app's **single** OS keychain item
    (service `com.helmcode.nan.desktop`, account `vault-master-key`) and
    cached in memory after the first read — at most one keychain access per
    launch, and with "Always Allow" on a stable signed binary, none at all.
  - Debug builds: a `0600` file next to the vault (`vault.key`) so developers
    never see keychain prompts. Development builds therefore only get the
    file-permission guarantee, not encryption-at-rest separation.
- **Files:** created with mode `0600`; written atomically (temp file +
  `fsync` + `rename`) under a process-wide lock.
- **Failure mode:** a vault that is missing, truncated, tampered with, of an
  unknown version, or sealed with a different master key reads as **empty**:
  the user is signed out and the next sign-in writes a clean vault. Nothing
  panics. A master key that cannot be read (e.g. keychain access denied) is
  never silently replaced, so a valid vault is never orphaned.
- **Migration:** pre-vault versions kept one keychain item per secret. On the
  first launch with the vault, those items are copied into the vault and then
  deleted from the keychain (once, best-effort, silent — any failure simply
  means signing in again).

### What this protects against

- Other local users and processes running as a different user (file mode
  `0600`; in release builds the master key is not on disk at all).
- Leakage of the app data directory through backups, cloud sync or a copied
  home folder: the vault is ciphertext and its key stays in the keychain,
  which is not part of that data.
- Torn or half-written credential files (atomic writes) and tampering that
  would otherwise yield attacker-chosen credentials (authenticated
  encryption).

### What it does NOT protect against

- **Root, or malware running as the same user.** Such code can request the
  master key from the keychain under the app's identity, read the debug key
  file, or read the process memory. This is the same tradeoff mainstream
  desktop AI clients make. The previous design (one keychain item per secret)
  did not materially change this threat model but prompted users repeatedly,
  so we chose one well-protected key over many prompts.
- Unsigned or ad-hoc signed builds (older macOS releases, local builds from
  source): macOS binds "Always Allow" to the code signature, so on such a
  build an update may ask for the keychain password once more. Developer ID
  signed releases keep a stable identity.

The storage backend sits behind a `CredentialStore` trait; a per-item
keychain backend (`KeyringStore`) remains available behind the same seam if a
platform needs it.

## Per-user data realms

Implementation: `src-tauri/src/realm.rs` (plus `profile.rs` bindings and the
login boundary in `device_flow.rs`).

Up to v0.2.6 local data was keyed by the tenant (`nan` / `helmcode`), so two
accounts of the same tenant on one device shared conversations, skills and
folder grants. Every user-identifying store now lives in a per-user realm:

- **Realm key:** `<profile>:<user-id>`, where the user id is what the platform
  answers to `GET /api/auth/me` called with the NEW session right after the
  device-flow approval. No verified user id means no login: nothing is
  stored and the previously open realm does not change.
- **Realm folder:** `<app data>/realms/<hex(sha256(realm key))[0..16 bytes]>`
  (mode `0700`) holds `chat.db`, local skills, the org skills cache,
  `tools.json` (folder grants, approval modes, run_command switch), the tools
  audit log and `memory.json`.
- **Binding:** `profiles.json` (schema v3) records the user bound to each
  profile (id, email, realm hash). It lives outside the vault on purpose: a
  vault reset signs you out but never forgets whose data is whose. A binding
  whose realm hash does not match its user id is dropped, never followed.
- **Resolution:** commands reach a realm only for the ACTIVE, BOUND profile.
  Signed out, nothing is readable. Sign-out deletes the session and keeps the
  binding and the realm data, so the same user gets everything back.
- **Switching users:** a login of another user id opens a fresh, empty realm
  and deletes the previous user's credentials (their data stays on disk,
  unreachable). Every login and sign-out aborts running replies and image
  jobs and resets per-conversation tool state.
- **Shared on purpose:** generated images under `images/` (the asset
  protocol scope). Their names are random v4 uuids that no command lists;
  an image is only reachable through the `chat.db` row of the realm that
  made it.
- **Tool sandbox:** the protected area is still the WHOLE app data folder
  (vault, profiles, every realm), not only the open realm.

**One-time migration:** data written before realms has no owner. It is
assigned to whoever signs in to that profile FIRST after the update (moved,
not copied; `chat.db` is split per profile and vacuumed so no other
profile's text remains). Local skills, which had no profile at all, go to
the first sign-in on the device. Any later user gets a fresh realm.

**Not covered:** other people using the SAME OS account can still open the
app data folder directly (the realms are not encrypted at rest; use separate
OS accounts for real separation), and conversations that a previous version
already synced to another account's memory cannot be recalled from the
device.

## Supported versions

| Version | Supported |
|---------|-----------|
| latest tag + `main` | yes |
| older tags | best effort |

## Known limitations

- **Code signing** (state as of v0.2.10, stated in every release body):
  - macOS: signed with an Apple **Developer ID** and **notarized**.
  - Windows: **not Authenticode signed yet**; SmartScreen warns on first
    run. The pipeline enables signing automatically once the certificate
    secrets are configured.
  - Linux: packages are unsigned (standard for AppImage/deb/rpm on GitHub
    releases).

  Updates delivered by the auto-updater are always verified against the
  updater public key embedded in the app (`src-tauri/tauri.conf.json`).
  Verify installer hashes against the values shown on the GitHub release.
  Details and the owner setup checklist: [SIGNING.md](SIGNING.md).
- **Linux sign-in** needs a Secret Service provider (GNOME Keyring or
  KWallet) for the keychain.
- **Same OS account:** realms are not encrypted at rest; anyone using the
  same OS account can read the app data folder. Use separate OS accounts.
