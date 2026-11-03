#!/usr/bin/env bash
# macOS bundle signing for Helmcode Desktop (CI + local).
#
#   scripts/macos-sign.sh <path/to/Helmcode Desktop.app> <path/to/installer.dmg>
#
# Why this exists: the Tauri bundler, with no signing identity configured,
# ships a .app whose main binary only carries the linker's ad-hoc signature
# (flags=adhoc,linker-signed). The bundle itself is never sealed, so
# `codesign --verify` fails with "code has no resources but signature
# indicates they must be present" and Gatekeeper reports the downloaded app as
# "damaged and can't be opened" on Apple Silicon.
#
# Two modes, chosen automatically from the environment:
#
#   developer-id  APPLE_CERTIFICATE (base64 .p12) + APPLE_CERTIFICATE_PASSWORD
#                 are set. Imports the certificate into a throwaway keychain,
#                 signs inside-out with the "Developer ID Application" identity
#                 + hardened runtime + secure timestamp, notarizes with
#                 `xcrun notarytool` (App Store Connect API key OR Apple ID),
#                 staples the .app AND the .dmg and checks them with spctl.
#                 Notary credentials are REQUIRED in this mode: a Developer ID
#                 signature without a notarization ticket is still rejected by
#                 Gatekeeper, so a half-configured setup fails loudly instead
#                 of shipping something that looks signed but is not usable.
#
#   adhoc         No certificate. Seals the whole bundle with an ad-hoc
#                 signature (`codesign --force --deep --sign -`). This repairs
#                 the broken signature (the bundle verifies and runs when not
#                 quarantined) but is NOT trusted by Gatekeeper for browser
#                 downloads: users must clear the quarantine flag (SIGNING.md).
#
# In both modes the signed .app is put back into the DMG (preserving the
# Tauri DMG layout: background, icon positions, /Applications link) and the
# app INSIDE the final DMG is re-verified, because that is what users get.
#
# Environment (all optional; see SIGNING.md):
#   APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY
#   APPLE_API_ISSUER, APPLE_API_KEY_ID, APPLE_API_KEY (.p8 contents)
#   APPLE_ID, APPLE_PASSWORD (app-specific password), APPLE_TEAM_ID
#   MACOS_SIGN_FORCE_ADHOC=1   ignore any certificate (local testing)
#
# Outputs: `mode=<developer-id|adhoc>` to $GITHUB_OUTPUT and a summary line to
# $GITHUB_STEP_SUMMARY when running in GitHub Actions.

set -euo pipefail

APP=${1:?usage: macos-sign.sh <app> <dmg>}
DMG=${2:?usage: macos-sign.sh <app> <dmg>}
APP=${APP%/}

log() { printf '[macos-sign] %s\n' "$*" >&2; }
die() { printf '[macos-sign] ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$APP" ] || die "app bundle not found: $APP"
[ -f "$DMG" ] || die "dmg not found: $DMG"
APP_NAME=$(basename "$APP")

WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/macos-sign.XXXXXX")
KEYCHAIN=""
ORIG_KEYCHAINS=""
MOUNTS=()
cleanup() {
  local m
  for m in "${MOUNTS[@]+"${MOUNTS[@]}"}"; do hdiutil detach -quiet -force "$m" 2>/dev/null || true; done
  if [ -n "$ORIG_KEYCHAINS" ]; then
    # shellcheck disable=SC2086
    security list-keychains -d user -s $ORIG_KEYCHAINS 2>/dev/null || true
  fi
  if [ -n "$KEYCHAIN" ]; then security delete-keychain "$KEYCHAIN" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------- mode -----
MODE=adhoc
if [ -n "${APPLE_CERTIFICATE:-}" ] && [ "${MACOS_SIGN_FORCE_ADHOC:-0}" != "1" ]; then
  MODE=developer-id
  [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ] || die "APPLE_CERTIFICATE is set but APPLE_CERTIFICATE_PASSWORD is empty"
  if [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_KEY:-}" ]; then
    NOTARY=api-key
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    NOTARY=apple-id
  else
    die "Developer ID certificate present but no notarization credentials: set APPLE_API_ISSUER + APPLE_API_KEY_ID + APPLE_API_KEY (preferred) or APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID. Refusing to ship a signed-but-not-notarized build."
  fi
fi
log "mode: $MODE"

# ----------------------------------------------------------- keychain -----
IDENTITY="-"
if [ "$MODE" = developer-id ]; then
  KEYCHAIN="$WORK/signing.keychain-db"
  KC_PASS=$(openssl rand -hex 24)
  printf '%s' "$APPLE_CERTIFICATE" | base64 --decode > "$WORK/cert.p12"
  security create-keychain -p "$KC_PASS" "$KEYCHAIN"
  security set-keychain-settings -lut 3600 "$KEYCHAIN"
  security unlock-keychain -p "$KC_PASS" "$KEYCHAIN"
  security import "$WORK/cert.p12" -k "$KEYCHAIN" -P "$APPLE_CERTIFICATE_PASSWORD" \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  rm -f "$WORK/cert.p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KEYCHAIN" >/dev/null
  # Make the temp keychain searchable (keep the existing ones after it); the
  # original search list is restored on exit.
  ORIG_KEYCHAINS=$(security list-keychains -d user | tr -d '"')
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$KEYCHAIN" $ORIG_KEYCHAINS
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    IDENTITY=$APPLE_SIGNING_IDENTITY
  else
    IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN" \
      | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n1)
  fi
  [ -n "$IDENTITY" ] || die "no 'Developer ID Application' identity found in APPLE_CERTIFICATE (exported the wrong certificate type?)"
  log "identity: $IDENTITY"
fi

# -------------------------------------------------------------- sign ------
sign_app() {
  local app=$1
  if [ "$MODE" = adhoc ]; then
    # Seals every nested binary and the bundle resources in one pass.
    codesign --force --deep --sign - "$app"
  else
    # Inside-out: nested Mach-O code (sidecars, dylibs) first, then nested
    # frameworks, the bundle last. Hardened runtime + secure timestamp are
    # mandatory for notarization.
    local main f
    local cs=(codesign --force --options runtime --timestamp --keychain "$KEYCHAIN" --sign "$IDENTITY")
    main="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
    while IFS= read -r -d '' f; do
      [ "$f" = "$main" ] && continue
      if file -b "$f" | grep -q 'Mach-O'; then "${cs[@]}" "$f"; fi
    done < <(find "$app/Contents" -type f -print0)
    while IFS= read -r -d '' f; do
      "${cs[@]}" "$f"
    done < <(find "$app/Contents" -type d -name '*.framework' -print0)
    "${cs[@]}" "$app"
  fi
}

# Fails unless the bundle is fully sealed (not just linker-signed) and, in
# developer-id mode, carries a Team ID + hardened runtime.
verify_app() {
  local app=$1 info
  codesign --verify --deep --strict --verbose=2 "$app"
  info=$(codesign -dvv "$app" 2>&1)
  printf '%s\n' "$info" | grep -E '^(Identifier|Format|CodeDirectory|Signature|Authority|TeamIdentifier|Sealed Resources)' >&2 || true
  # A linker-only signature prints "Sealed Resources=none".
  printf '%s\n' "$info" | grep -q '^Sealed Resources version=' || die "$app: resources are not sealed"
  if printf '%s\n' "$info" | grep -q 'linker-signed'; then die "$app: still only linker-signed"; fi
  if [ "$MODE" = developer-id ]; then
    printf '%s\n' "$info" | grep -q 'TeamIdentifier=not set' && die "$app: TeamIdentifier not set"
    printf '%s\n' "$info" | grep -q 'flags=.*runtime' || die "$app: hardened runtime missing"
  fi
}

notarize() {
  local target=$1
  log "notarizing $(basename "$target") (this can take a few minutes)"
  local creds
  if [ "$NOTARY" = api-key ]; then
    printf '%s' "$APPLE_API_KEY" > "$WORK/AuthKey.p8"
    chmod 600 "$WORK/AuthKey.p8"
    creds=(--key "$WORK/AuthKey.p8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
  else
    creds=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
  fi
  local out status id
  out=$(xcrun notarytool submit "$target" --wait --timeout 30m --output-format json "${creds[@]}") || true
  printf '%s\n' "$out" >&2
  status=$(printf '%s' "$out" | /usr/bin/plutil -extract status raw -o - - 2>/dev/null || true)
  if [ "$status" != "Accepted" ]; then
    id=$(printf '%s' "$out" | /usr/bin/plutil -extract id raw -o - - 2>/dev/null || true)
    if [ -n "$id" ]; then xcrun notarytool log "$id" "${creds[@]}" >&2 || true; fi
    rm -f "$WORK/AuthKey.p8"
    die "notarization of $(basename "$target") failed (status: ${status:-unknown})"
  fi
  rm -f "$WORK/AuthKey.p8"
}

log "signing $APP_NAME"
sign_app "$APP"
verify_app "$APP"

if [ "$MODE" = developer-id ]; then
  ditto -c -k --keepParent "$APP" "$WORK/app.zip"
  notarize "$WORK/app.zip"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl --assess --type exec --verbose=2 "$APP"
fi

# ------------------------------------------------ put the app in the DMG ---
# Convert the Tauri DMG to read-write, swap the .app, compress it back. This
# keeps the bundler's layout instead of re-implementing it.
log "repacking $(basename "$DMG") with the signed app"
hdiutil convert -quiet "$DMG" -format UDRW -o "$WORK/rw.dmg"
# Headroom for the signature files; free space compresses away in UDZO.
hdiutil resize -quiet -size 2g "$WORK/rw.dmg" || log "resize skipped (continuing with the original size)"
RW_MNT="$WORK/rw-mnt"
mkdir -p "$RW_MNT"
hdiutil attach -quiet -nobrowse -noverify -noautoopen -mountpoint "$RW_MNT" "$WORK/rw.dmg"
MOUNTS+=("$RW_MNT")
[ -d "$RW_MNT/$APP_NAME" ] || die "DMG does not contain $APP_NAME (found: $(ls "$RW_MNT"))"
rm -rf "${RW_MNT:?}/$APP_NAME"
ditto "$APP" "$RW_MNT/$APP_NAME"
sync
hdiutil detach -quiet "$RW_MNT"
MOUNTS=()
hdiutil convert -quiet "$WORK/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$WORK/final.dmg"
mv -f "$WORK/final.dmg" "$DMG"

if [ "$MODE" = developer-id ]; then
  codesign --force --timestamp --keychain "$KEYCHAIN" --sign "$IDENTITY" "$DMG"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
fi

# --------------------------------------- verify what users will install ---
hdiutil verify -quiet "$DMG"
RO_MNT="$WORK/ro-mnt"
mkdir -p "$RO_MNT"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$RO_MNT" "$DMG"
MOUNTS+=("$RO_MNT")
log "verifying the app inside the final DMG"
verify_app "$RO_MNT/$APP_NAME"
if [ "$MODE" = developer-id ]; then
  spctl --assess --type exec --verbose=2 "$RO_MNT/$APP_NAME"
fi
hdiutil detach -quiet "$RO_MNT"
MOUNTS=()

if [ "$MODE" = developer-id ]; then
  SUMMARY="macOS ($(basename "$DMG")): **signed with Developer ID + notarized + stapled** (Gatekeeper accepts it)."
else
  SUMMARY="macOS ($(basename "$DMG")): **ad-hoc fallback** — bundle sealed and verified, but NOT Developer ID signed or notarized. Gatekeeper blocks quarantined downloads; see SIGNING.md."
fi
log "$SUMMARY"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf -- '- %s\n' "$SUMMARY" >> "$GITHUB_STEP_SUMMARY"; fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then printf 'mode=%s\n' "$MODE" >> "$GITHUB_OUTPUT"; fi
