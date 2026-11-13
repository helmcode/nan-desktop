# Code signing and notarization

Current state, what users see, and the one-time setup that turns on fully
trusted installers. The release pipeline (`.github/workflows/release.yml`)
**enables signing automatically when the secrets below exist**. No workflow
edit is needed.

| Platform | Without secrets (today) | With secrets |
|----------|------------------------|--------------|
| macOS | Ad-hoc bundle seal. The app verifies (`codesign --verify --deep --strict`) but is not trusted by Gatekeeper | Developer ID signature, hardened runtime, notarized and stapled (app **and** dmg). Opens with no warning |
| Windows | Unsigned. SmartScreen shows "Windows protected your PC" | Authenticode on the app exe, the setup exe and the msi. SmartScreen can still warn until the certificate builds reputation |
| Linux | Unsigned (normal for AppImage/deb/rpm on GitHub releases) | Unchanged |

Each release run states which path it took: the job summary of every build
job, and the **Code signing status** section of the draft release body.

## Release pipeline at a glance

```
prepare -> build (macOS arm64, macOS x64, Windows, Linux) -> rename-assets -+
                                                       \-> smoke ----------+-> publish
                                                                              (environment: release)
```

- **prepare**: strict `vX.Y.Z` tag guard (the version of `tauri.conf.json`,
  `package.json` and the `[package]` table of `Cargo.toml` must equal the
  tag), draft release, honest signing statement.
- **build**: compiles with **no signing secret in the environment**, then
  signs in dedicated steps (see "Secret scoping" below), uploads to the
  draft and as a workflow artifact.
- **rename-assets**: stable asset names + signed `latest.json`.
- **smoke**: installs the exact artifacts of the run on clean runners.
  Windows: silent `msiexec /qn` install + uninstall of the msi. Linux: the
  deb installs (and its binary links cleanly) in `ubuntu:22.04` and
  `ubuntu:24.04` containers, and the AppImage starts under Xvfb
  (`--appimage-extract-and-run`, still alive after 30 s). macOS:
  `codesign --verify` on both apps; with Developer ID also
  `spctl --assess`, `stapler validate` and the dmg Gatekeeper check (an
  ad-hoc build must be rejected by `spctl`).
- **publish**: waits for a required reviewer of the GitHub environment
  `release` (this approval replaces the old manual "Publish release" click),
  then sets `draft=false` and `make_latest=true`. It **refuses** when macOS
  is not Developer ID signed + notarized, unless the run was started with
  the `allow_unsigned` input (Actions -> Release -> Run workflow on the tag).
  It also refuses when the `release` environment has no required reviewer
  (GitHub silently creates a missing environment unprotected) or when a
  stable asset is missing.

`release-dryrun.yml` rehearses build -> naming -> `latest.json` every night
with no secret at all (throwaway minisign key, ad-hoc macOS seal).

### Secret scoping

No signing secret is present while third-party code runs (`pnpm install`,
vite, cargo build scripts, proc macros):

| Secret | Only visible to |
|--------|-----------------|
| `WINDOWS_CERTIFICATE[_PASSWORD]` | *Bundle and Authenticode-sign (Windows)*: `pnpm tauri bundle` after a secret-free `pnpm tauri build --no-bundle` |
| `TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]` | *Sign updater bundles (Windows / Linux)* and *Stage and sign updater payload (macOS)* |
| `APPLE_*` | *Sign, notarize and verify (macOS)* |

## Why v0.2.0 shows "damaged and can't be opened" on macOS

The Tauri bundler had no signing identity configured, so the only signature
on the app was the one the **linker** puts on the main binary on Apple
Silicon (`flags=0x20002(adhoc,linker-signed)`, `TeamIdentifier=not set`). The
bundle was never sealed: `codesign -vv` reports *"code has no resources but
signature indicates they must be present"*. A browser download gets the
quarantine flag, Gatekeeper checks the signature, finds it broken, and says
the app is **damaged**. This is not a corrupted download. The dmg is fine.

Fixed in the pipeline in two layers:

1. **Always:** `scripts/macos-sign.sh` re-signs the bundle (ad-hoc when there
   is no certificate), repacks the signed app into the Tauri dmg (keeping its
   layout), and verifies the app **inside the final dmg** before upload. This
   removes the "damaged" state. Quarantined downloads are still blocked,
   because Apple only trusts Developer ID + notarization, but the message
   becomes "cannot be verified" and the workaround below works.
2. **When the Apple secrets exist:** the same script signs with Developer ID,
   notarizes with `xcrun notarytool`, staples, and checks with `spctl`. The
   app then opens with no warning.

`test/macos-sign-test.sh` (run by CI on macOS) reproduces the defect with a
linker-signed bundle and asserts the fix.

## Workaround for users while builds are unsigned

### macOS

1. Open the dmg and drag **Helmcode Desktop** to **Applications**.
2. Run this once in Terminal:

   ```sh
   xattr -cr "/Applications/Helmcode Desktop.app"
   ```

   This removes the download quarantine flag from this one app only. Nothing
   else on the system changes.
3. Open the app normally.

On Intel Macs and older macOS versions, **right-click the app → Open → Open**
can also work for an ad-hoc build. On recent macOS on Apple Silicon, use
`xattr` (or System Settings → Privacy & Security → "Open Anyway" after the
first blocked launch).

Builds fetched without a browser (`curl`, `gh release download`) carry no
quarantine flag and open directly. Example:
`curl -L -o hcd.tar.gz https://github.com/helmcode/nan-desktop/releases/latest/download/Helmcode.Desktop-macOS-AppleSilicon.app.tar.gz && tar -xzf hcd.tar.gz -C /Applications`.

### Windows

SmartScreen shows "Windows protected your PC". Click **More info → Run
anyway**. Signed builds can still show this warning for a while: SmartScreen
reputation builds up per certificate as downloads accumulate. EV certificates
and Azure Trusted Signing build reputation faster.

Whatever the platform, compare the SHA-256 of the download with the digest
GitHub shows next to the release asset.

## Owner checklist (one-time)

### macOS: Developer ID + notarization

1. **Join the Apple Developer Program** as the Helmcode organization
   (developer.apple.com/programs, 99 USD/year; an organization account needs a
   D-U-N-S number). Note the **Team ID** (Membership details).
2. **Create a "Developer ID Application" certificate.** In Xcode: Settings →
   Accounts → Manage Certificates → + → *Developer ID Application*. Or create
   a CSR in Keychain Access and upload it at Certificates, IDs & Profiles.
   Only the Account Holder can create Developer ID certificates.
3. **Export it as .p12.** In Keychain Access → login → My Certificates, select
   *Developer ID Application: Helmcode … (TEAMID)* **with its private key**,
   choose Export, save as `.p12`, and set a strong password. Then:

   ```sh
   base64 -i DeveloperID.p12 | pbcopy   # value for APPLE_CERTIFICATE
   ```

4. **Create an App Store Connect API key** for notarization: App Store Connect
   → Users and Access → Integrations → App Store Connect API → Team Keys → +.
   Role **Developer**. Download `AuthKey_<KEYID>.p8` (it can only be downloaded
   once) and note the **Key ID** and the **Issuer ID** shown above the table.
5. **Add the GitHub secrets** (repository → Settings → Secrets and variables →
   Actions → New repository secret):

   | Secret | Value |
   |--------|-------|
   | `APPLE_CERTIFICATE` | base64 of the `.p12` (step 3) |
   | `APPLE_CERTIFICATE_PASSWORD` | the `.p12` export password |
   | `APPLE_API_ISSUER` | Issuer ID (UUID) |
   | `APPLE_API_KEY_ID` | Key ID (10 characters) |
   | `APPLE_API_KEY` | the full contents of `AuthKey_<KEYID>.p8`, including the `BEGIN/END PRIVATE KEY` lines |

   Optional:
   - `APPLE_SIGNING_IDENTITY`: the exact identity name. Without it, the
     script uses the first "Developer ID Application" identity in the `.p12`.
   - Apple ID notarization instead of an API key: `APPLE_ID`,
     `APPLE_PASSWORD` (an app-specific password from account.apple.com),
     `APPLE_TEAM_ID`.

6. **Re-run the release.** Push a new patch tag (for example `v0.2.1`). The
   draft release body and the job summaries should read
   *"signed with Developer ID + notarized"*. The smoke job runs `spctl` on
   both apps; before approving the `release` environment you can also check
   a downloaded dmg on a Mac:

   ```sh
   spctl -a -t open --context context:primary-signature -vv Helmcode.Desktop-macOS-AppleSilicon.dmg
   xcrun stapler validate Helmcode.Desktop-macOS-AppleSilicon.dmg
   spctl -a -t exec -vv "/Applications/Helmcode Desktop.app"   # after installing
   ```

If the certificate is set but the notarization credentials are incomplete,
the macOS jobs **fail on purpose**. A build that is signed but not notarized
is still blocked by Gatekeeper and would only look fixed.

### Windows: Authenticode

1. Get an **OV or EV code-signing certificate** from a CA.
   **Caveat:** since June 2023, CAs must issue code-signing keys on hardware
   (HSM/token), so most new certificates **cannot** be exported as `.pfx`. The
   `.pfx` path below only works with a certificate you can export.
   For a new purchase, **Azure Trusted Signing** is the simplest CI-friendly
   option. Wire it by replacing the `signCommand` in the *Configure
   Authenticode signing (Windows)* step of `release.yml` with
   `trusted-signing-cli -e <endpoint> -a <account> -c <profile> -d "Helmcode Desktop" %1`
   (Azure credentials as `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` /
   `AZURE_TENANT_ID` secrets, passed ONLY to the *Bundle and
   Authenticode-sign (Windows)* step).
2. With an exportable certificate, add the secrets:

   | Secret | Value |
   |--------|-------|
   | `WINDOWS_CERTIFICATE` | base64 of the `.pfx` (`base64 -i cert.pfx`, or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`) |
   | `WINDOWS_CERTIFICATE_PASSWORD` | the `.pfx` password |

3. Re-run the release. The *Bundle and Authenticode-sign (Windows)* step
   signs through `scripts/windows-sign.ps1` (SHA-256, RFC 3161 timestamp),
   and a verification step fails the job if any exe or msi is not validly
   signed.

### Auto-update: updater signing key

The in-app "update available" banner (round 7) installs only packages signed
with the minisign key whose PUBLIC half is embedded in the app
(`src-tauri/tauri.conf.json` > `plugins.updater.pubkey`). This key is
independent of Apple/Windows code signing: both apply.

1. Generate the keypair once (refuses to overwrite an existing key):

   ```sh
   bash scripts/updater-keygen.sh
   ```

   It writes `scripts/brand/updater.key` (private, gitignored),
   `scripts/brand/updater.key.password` (gitignored) and
   `scripts/brand/updater.key.pub`, and embeds the public key in
   `tauri.conf.json`. Commit `tauri.conf.json`; never commit the private
   key or its password. **Back up the private key**: lose it and every
   installed app can never be updated again.
2. Add two repository secrets:

   | Secret | Value |
   |---|---|
   | `TAURI_SIGNING_PRIVATE_KEY` | contents of `scripts/brand/updater.key` |
   | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | contents of `scripts/brand/updater.key.password` |

3. CI (`node test/updater-check.mjs`) fails while the pubkey is still the
   placeholder, so the wiring cannot ship half-configured.

How the release pipeline uses it:

- Windows/Linux: the build no longer sets `bundle.createUpdaterArtifacts`
  (that needs the private key for the whole build). After the installers
  are built (and, on Windows, Authenticode-signed) and staged, the separate
  *Sign updater bundles (Windows / Linux)* step runs
  `pnpm tauri signer sign <installer> --app-version <X.Y.Z>` on the msi,
  the setup exe, the AppImage, the deb and the rpm. It writes
  `<installer>.sig` next to each, the same file the bundler used to write,
  so the uploaded names (and the rename-assets table) are unchanged.
- macOS: after the Apple signature/notarization, the re-packed
  `.app.tar.gz` (the updater payload) is signed the same way in *Stage and
  sign updater payload (macOS)*.
- `--app-version` binds each signature to the release version (minisign
  trusted comment), like the bundler's own signatures.
- `rename-assets` renames the `.sig` files to the stable names, then builds
  `latest.json` with `scripts/updater-manifest.mjs` (each platform: tag URL
  + inlined signature) and uploads it. A missing required signature fails
  the job instead of publishing a partial feed.

Without the two secrets the release still builds; it just has no
`latest.json` and installed apps see no update.

**Going live.** The feed goes live when the *publish* job (after the
`release` environment approval) marks the release as latest. Apps check
`https://github.com/helmcode/nan-desktop/releases/latest/download/latest.json`
on startup and every 6 hours (debug builds skip the check unless
`HELMCODE_DESKTOP_UPDATER_IN_DEV=1`). That URL resolves only for the latest
PUBLISHED release, so:

- The first release that can be AUTO-installed is the second one after the
  key exists: users must first install, by hand, a build that embeds the
  pubkey (call it vN). When vN+1 is published with a signed `latest.json`,
  vN shows the banner.
- That first signed release (and every later one) must contain:
  `latest.json`, the five stable updater payloads
  `Helmcode.Desktop-macOS-AppleSilicon.app.tar.gz`,
  `Helmcode.Desktop-macOS-Intel.app.tar.gz`,
  `Helmcode.Desktop-Windows-x64-setup.exe`, `Helmcode.Desktop-Windows-x64.msi`,
  `Helmcode.Desktop-Linux-amd64.AppImage`, and the `.sig` of each.
- Its version (tag `vX.Y.Z`, `tauri.conf.json`, `Cargo.toml`,
  `package.json`) must be higher than the installed one: the updater only
  offers newer semver versions.
- End-to-end update test for vN+1: install vN, publish vN+1, start vN, see
  the banner, click Update, the app relaunches as vN+1. A tampered or
  wrongly-signed package is rejected by the updater (the install fails and
  the banner says so).

## Where things live

- `scripts/macos-sign.sh`: macOS seal, sign, notarize, staple, dmg repack and
  verification. Usable locally:
  `MACOS_SIGN_FORCE_ADHOC=1 bash scripts/macos-sign.sh "<app>" "<dmg>"`.
- `scripts/windows-sign.ps1`: Tauri `signCommand` hook (Authenticode).
- `test/macos-sign-test.sh`: spec test (CI, macOS).
- `scripts/updater-keygen.sh`: one-time updater keypair + pubkey embedding.
- `scripts/updater-manifest.mjs`: builds the signed `latest.json`.
- `test/updater-check.mjs`: auto-update wiring check (CI).
- `src-tauri/src/updater.rs`: `update_check` / `update_install` commands.
- `.github/workflows/release.yml`: `prepare` (tag guard, draft release +
  honest body), `build` (per-OS build, scoped signing steps, upload),
  `rename-assets` (stable download names + `latest.json`), `smoke`
  (install/launch checks), `publish` (environment-gated `draft=false`,
  `make_latest=true`).
- `.github/workflows/release-dryrun.yml`: nightly secret-free rehearsal.

Secrets are only exposed to the signing steps (table in "Secret scoping"). The certificate lives in a
throwaway keychain or temp file that is deleted when the step ends, and the
notary key file is removed right after each submission.
