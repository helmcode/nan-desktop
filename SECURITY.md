# Security policy

## Reporting a vulnerability

**Do not open a public issue for security reports.**

Use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability), or contact the maintainers through the
Helmcode organization. We aim to acknowledge reports within 2 business days.

## Scope

In scope:
- The nan-desktop desktop application (this repository): credential storage and
  handling (encrypted vault + OS keychain master key, Rust core), Tauri IPC
  boundaries, the device login
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
- **Credentials live in an encrypted vault**, read only by the Rust core. They
  never enter the web renderer process and are never logged (see
  [Credential storage](#credential-storage) below).
- **Model output is sanitized** (rehype-sanitize last) before rendering; raw
  HTML is never rendered.
- **Tool executor (when enabled) asks per action**: model proposes, user
  approves; file access is granted per folder.

## Credential storage

Implementation: `src-tauri/src/credentials.rs`.

All secrets (per-profile inference API keys and login session tokens) live in
ONE file, `vault.bin` in the app data directory:

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
- Unsigned builds: macOS binds "Always Allow" to the code signature, so until
  installers are code-signed (see Known limitations) an update may ask for
  the keychain password once more.

The storage backend sits behind a `CredentialStore` trait; a per-item
keychain backend (`KeyringStore`) remains available behind the same seam if a
platform needs it.

## Supported versions

| Version | Supported |
|---------|-----------|
| latest tag + `main` | yes |
| older tags | best effort |

## Known limitations

- Installers are **not Developer ID / Authenticode signed yet**. macOS builds
  carry a verified ad-hoc bundle seal only (not notarized); Windows builds are
  unsigned. The release pipeline switches to Developer ID + notarization and
  Authenticode automatically once the signing secrets are configured; each
  release body states the actual signing status. Current state, user
  workarounds and the owner setup checklist: [SIGNING.md](SIGNING.md).
  Verify installer hashes against the values shown on the GitHub release.
