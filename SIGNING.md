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
   *"signed with Developer ID + notarized"*. Before publishing, check a
   downloaded dmg on a Mac:

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
   Authenticode signing* step of `release.yml` with
   `trusted-signing-cli -e <endpoint> -a <account> -c <profile> -d "Helmcode Desktop" %1`
   (Azure credentials as `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` /
   `AZURE_TENANT_ID` secrets).
2. With an exportable certificate, add the secrets:

   | Secret | Value |
   |--------|-------|
   | `WINDOWS_CERTIFICATE` | base64 of the `.pfx` (`base64 -i cert.pfx`, or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.pfx"))`) |
   | `WINDOWS_CERTIFICATE_PASSWORD` | the `.pfx` password |

3. Re-run the release. The build step signs through
   `scripts/windows-sign.ps1` (SHA-256, RFC 3161 timestamp), and a verification
   step fails the job if any exe or msi is not validly signed.

## Where things live

- `scripts/macos-sign.sh`: macOS seal, sign, notarize, staple, dmg repack and
  verification. Usable locally:
  `MACOS_SIGN_FORCE_ADHOC=1 bash scripts/macos-sign.sh "<app>" "<dmg>"`.
- `scripts/windows-sign.ps1`: Tauri `signCommand` hook (Authenticode).
- `test/macos-sign-test.sh`: spec test (CI, macOS).
- `.github/workflows/release.yml`: `prepare` (draft release + honest body),
  `build` (per-OS build and signing), `rename-assets` (stable download names).

Secrets are only exposed to the signing steps. The certificate lives in a
throwaway keychain or temp file that is deleted when the step ends, and the
notary key file is removed right after each submission.
