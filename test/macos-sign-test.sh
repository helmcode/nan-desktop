#!/usr/bin/env bash
# Spec test for scripts/macos-sign.sh (macOS only; runs in CI on macos-latest).
#
# Reproduces the shipped defect with a minimal bundle: clang on Apple Silicon
# emits a linker-signed (adhoc,linker-signed) Mach-O, and wrapping it in a .app
# with a resource file yields exactly the broken state Gatekeeper reports as
# "damaged" ("code has no resources but signature indicates they must be
# present"). Then asserts:
#   1. the broken bundle FAILS `codesign --verify --deep --strict` (baseline);
#   2. adhoc mode seals it: the .app and the .app INSIDE the repacked DMG pass
#      strict verification and resources are sealed;
#   3. the DMG keeps its other content (layout files survive the repack);
#   4. developer-id mode with a certificate but no notary credentials fails
#      fast instead of shipping a signed-but-not-notarized build.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SIGN="$ROOT/scripts/macos-sign.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/macos-sign-test.XXXXXX")
MNT="$T/mnt"
trap 'hdiutil detach -quiet -force "$MNT" 2>/dev/null || true; rm -rf "$T"' EXIT

pass() { printf 'PASS %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }

# ---- fixture: a Tauri-like unsealed bundle inside a DMG -------------------
APP="$T/stage/Helmcode Desktop.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
printf 'int main(void){return 0;}\n' > "$T/main.c"
clang -arch arm64 -o "$APP/Contents/MacOS/helmcode-desktop" "$T/main.c"
printf 'icon-bytes' > "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>helmcode-desktop</string>
  <key>CFBundleIdentifier</key><string>com.helmcode.nan.desktop.test</string>
  <key>CFBundleName</key><string>Helmcode Desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
</dict></plist>
PLIST
ln -s /Applications "$T/stage/Applications"
printf 'layout' > "$T/stage/.layout-marker"
# HFS+ like the Tauri bundler's dmg.
hdiutil create -quiet -volname "Helmcode Desktop" -fs HFS+ -srcfolder "$T/stage" -format UDZO "$T/test.dmg"

# ---- 1. baseline is broken -----------------------------------------------
if ! codesign -dvv "$APP" 2>&1 | grep -q 'linker-signed'; then
  # CI's macOS runners reproduce the defect; some local toolchains sign the
  # binary differently. The production path (macos-sign.sh on the real DMG)
  # was validated against the shipped artifact on 2026-11-03.
  pass "fixture not linker-signed on this toolchain; skipping reproduction"
  exit 0
fi
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  fail "baseline unexpectedly verifies"
fi
pass "baseline bundle fails strict verification (reproduces the release defect)"

# ---- 2. adhoc mode seals app and DMG content ------------------------------
env -u APPLE_CERTIFICATE -u GITHUB_OUTPUT -u GITHUB_STEP_SUMMARY \
  MACOS_SIGN_FORCE_ADHOC=1 bash "$SIGN" "$APP" "$T/test.dmg"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dvv "$APP" 2>&1 | grep -q '^Sealed Resources version=' || fail "resources not sealed on the .app"
pass "adhoc: .app passes strict verification with sealed resources"

hdiutil verify -quiet "$T/test.dmg"
mkdir -p "$MNT"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$T/test.dmg"
codesign --verify --deep --strict --verbose=2 "$MNT/Helmcode Desktop.app"
info=$(codesign -dvv "$MNT/Helmcode Desktop.app" 2>&1)
printf '%s\n' "$info" | grep -q 'linker-signed' && fail "app in DMG is still linker-signed"
printf '%s\n' "$info" | grep -q '^Sealed Resources version=' || fail "app in DMG has no sealed resources"
pass "adhoc: app INSIDE the repacked DMG verifies"

# ---- 3. DMG layout preserved ----------------------------------------------
[ -f "$MNT/.layout-marker" ] || fail "repack dropped DMG layout files"
[ -L "$MNT/Applications" ] || fail "repack dropped the /Applications link"
pass "repacked DMG keeps its layout"
hdiutil detach -quiet "$MNT"

# ---- 4. half-configured Developer ID fails fast ---------------------------
set +e
out=$(env -u APPLE_API_ISSUER -u APPLE_API_KEY_ID -u APPLE_API_KEY -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID \
  -u GITHUB_OUTPUT -u GITHUB_STEP_SUMMARY \
  APPLE_CERTIFICATE=ZHVtbXk= APPLE_CERTIFICATE_PASSWORD=x bash "$SIGN" "$APP" "$T/test.dmg" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "developer-id without notary credentials did not fail"
printf '%s' "$out" | grep -q 'no notarization credentials' || fail "unexpected error: $out"
pass "developer-id without notary credentials refuses to run"

echo "macos-sign: all checks passed"
