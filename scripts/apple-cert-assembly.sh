#!/usr/bin/env bash
# apple-cert-assembly.sh
#
# Assembles the "Developer ID Application" signing identity for Team
# 28544XX5K2 into the artifacts the release pipeline consumes
# (APPLE_CERTIFICATE + APPLE_CERTIFICATE_PASSWORD, see
# .github/workflows/release.yml and scripts/macos-sign.sh).
#
# This is the CSR route: the private key (devid.key) was generated locally,
# devid.csr was uploaded at developer.apple.com, and Apple returned devid.cer.
#
# Usage:
#   scripts/apple-cert-assembly.sh [SECRETS_DIR]
#   SECRETS_DIR defaults to "$HOME/Desktop/apple-secrets".
#
# Required files in SECRETS_DIR:
#   devid.key            RSA private key used to create the CSR
#   devid.csr            the CSR uploaded to Apple
#   devid.cer            the certificate issued by Apple (DER or PEM)
#   DeveloperIDG2CA.cer  Developer ID Certification Authority (G2)
#   AppleWWDRCAG2.cer    Apple Worldwide Developer Relations CA (G2)
#
# Outputs in SECRETS_DIR (all chmod 600):
#   DeveloperID.p12        key + full chain
#   devid.p12.password     random p12 password (no trailing newline)
#   devid.p12.b64          single-line base64 of DeveloperID.p12
#
# Side effects: creates a throwaway keychain in a temp dir, temporarily adds
# it to the user keychain search list (so find-identity can build the chain),
# then restores the original search list and deletes the keychain on exit.
#
# Tools: openssl + security only. macOS only.

set -euo pipefail

# Everything we write is secret material.
umask 077

TEAM_ID="28544XX5K2"
CN_PREFIX="Developer ID Application"

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script must run on macOS (needs the security CLI)"
command -v openssl >/dev/null 2>&1 || die "openssl not found"
command -v security >/dev/null 2>&1 || die "security CLI not found"

SECRETS_DIR="${1:-$HOME/Desktop/apple-secrets}"
[ -d "$SECRETS_DIR" ] || die "secrets dir not found: $SECRETS_DIR"
SECRETS_DIR="$(cd "$SECRETS_DIR" && pwd)"

KEY="$SECRETS_DIR/devid.key"
CSR="$SECRETS_DIR/devid.csr"
CER="$SECRETS_DIR/devid.cer"
INT_CA="$SECRETS_DIR/DeveloperIDG2CA.cer"
WWDR_CA="$SECRETS_DIR/AppleWWDRCAG2.cer"

P12="$SECRETS_DIR/DeveloperID.p12"
P12_PASS_FILE="$SECRETS_DIR/devid.p12.password"
P12_B64="$SECRETS_DIR/devid.p12.b64"

# ---------------------------------------------------------------------------
# Temp workspace + cleanup (throwaway keychain, search list restore).
# ---------------------------------------------------------------------------
WORK="$(mktemp -d "${TMPDIR:-/tmp}/apple-cert-assembly.XXXXXX")"
KEYCHAIN=""
ORIG_KEYCHAINS=()
SEARCH_LIST_CHANGED=0

cleanup() {
  if [ "$SEARCH_LIST_CHANGED" -eq 1 ]; then
    security list-keychains -d user -s ${ORIG_KEYCHAINS[@]+"${ORIG_KEYCHAINS[@]}"} 2>/dev/null || true
  fi
  if [ -n "$KEYCHAIN" ]; then
    security delete-keychain "$KEYCHAIN" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# (1) All five inputs must exist.
# ---------------------------------------------------------------------------
log "checking inputs in $SECRETS_DIR"
missing=0
for f in "$KEY" "$CSR" "$CER" "$WWDR_CA" "$INT_CA"; do
  if [ ! -s "$f" ]; then
    printf 'ERROR: missing or empty: %s\n' "$f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  die "all 5 files are required (devid.key, devid.csr, devid.cer, AppleWWDRCAG2.cer, DeveloperIDG2CA.cer). Download devid.cer from developer.apple.com first."
fi

# Normalize a certificate (Apple ships DER, accept PEM too) to PEM.
to_pem() {
  local in="$1" out="$2"
  if openssl x509 -inform DER -in "$in" -out "$out" 2>/dev/null; then
    return 0
  fi
  if openssl x509 -inform PEM -in "$in" -out "$out" 2>/dev/null; then
    return 0
  fi
  die "not a readable X.509 certificate (DER or PEM): $in"
}

CER_PEM="$WORK/devid.pem"
INT_PEM="$WORK/devid-g2-ca.pem"
WWDR_PEM="$WORK/wwdr-g2-ca.pem"
to_pem "$CER" "$CER_PEM"
to_pem "$INT_CA" "$INT_PEM"
to_pem "$WWDR_CA" "$WWDR_PEM"

# ---------------------------------------------------------------------------
# (2) The issued certificate must match the local private key.
# ---------------------------------------------------------------------------
log "verifying devid.cer public key matches devid.key"
CERT_PUB="$(openssl x509 -in "$CER_PEM" -noout -pubkey)" \
  || die "could not extract the public key from devid.cer"
KEY_PUB="$(openssl pkey -in "$KEY" -pubout)" \
  || die "could not derive the public key from devid.key"
if [ "$CERT_PUB" != "$KEY_PUB" ]; then
  die "devid.cer does NOT match devid.key (public keys differ). The certificate was issued for a different CSR/key. Re-upload devid.csr and download the new certificate."
fi
log "public keys match"

# Informational: the CSR should carry the same key too.
CSR_PUB="$(openssl req -in "$CSR" -noout -pubkey 2>/dev/null || true)"
if [ -n "$CSR_PUB" ] && [ "$CSR_PUB" != "$KEY_PUB" ]; then
  printf 'WARNING: devid.csr public key differs from devid.key (cert still matches the key, continuing)\n' >&2
fi

# ---------------------------------------------------------------------------
# (3) Subject must be a Developer ID Application cert for our team.
# ---------------------------------------------------------------------------
log "verifying certificate subject"
SUBJECT_ML="$(openssl x509 -in "$CER_PEM" -noout -subject -nameopt multiline,utf8,-esc_msb)"
SUBJECT_ONELINE="$(openssl x509 -in "$CER_PEM" -noout -subject -nameopt RFC2253,utf8,-esc_msb)"

field() {
  # Extract a field value from the multiline subject (first match).
  printf '%s\n' "$SUBJECT_ML" \
    | sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" \
    | head -n 1
}

CERT_CN="$(field commonName)"
CERT_OU="$(field organizationalUnitName)"

case "$CERT_CN" in
  "$CN_PREFIX"*) ;;
  *) die "certificate CN does not start with '$CN_PREFIX' (got: '${CERT_CN:-<none>}'). Wrong certificate type downloaded?" ;;
esac
[ "$CERT_OU" = "$TEAM_ID" ] \
  || die "certificate OU is not $TEAM_ID (got: '${CERT_OU:-<none>}'). Wrong team?"

log "subject: $SUBJECT_ONELINE"
log "expires: $(openssl x509 -in "$CER_PEM" -noout -enddate | sed 's/^notAfter=//')"

# ---------------------------------------------------------------------------
# (4) Build the p12 with the full chain and a strong random password.
# ---------------------------------------------------------------------------
log "building DeveloperID.p12 (cert + DeveloperIDG2CA + AppleWWDRCAG2)"
cat "$INT_PEM" "$WWDR_PEM" > "$WORK/chain.pem"

P12_PASS="$(openssl rand -base64 24)"
# No trailing newline so 'gh secret set < file' stores the exact password.
printf '%s' "$P12_PASS" > "$P12_PASS_FILE"
chmod 600 "$P12_PASS_FILE"

# OpenSSL 3 defaults to AES-256/PBKDF2 PKCS#12, which older macOS 'security
# import' rejects. Force the SHA1/3DES profile that every macOS accepts.
# LibreSSL (/usr/bin/openssl) already defaults to a compatible profile.
P12_COMPAT=()
if openssl version | grep -q '^OpenSSL 3'; then
  P12_COMPAT=(-keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1)
fi

openssl pkcs12 -export \
  -inkey "$KEY" \
  -in "$CER_PEM" \
  -certfile "$WORK/chain.pem" \
  -name "$CERT_CN" \
  ${P12_COMPAT[@]+"${P12_COMPAT[@]}"} \
  -passout "file:$P12_PASS_FILE" \
  -out "$P12"
chmod 600 "$P12"

# ---------------------------------------------------------------------------
# (5) Sanity-check the p12 is readable with the saved password.
# ---------------------------------------------------------------------------
log "sanity-checking DeveloperID.p12"
P12_INFO="$(openssl pkcs12 -info -nokeys -nomacver -in "$P12" -passin "file:$P12_PASS_FILE" 2>/dev/null)" \
  || die "openssl could not read the generated p12"
printf '%s\n' "$P12_INFO" | grep -E '^subject=' | sed 's/^/    /'
CERT_COUNT="$(printf '%s\n' "$P12_INFO" | grep -c -- '-----BEGIN CERTIFICATE-----' || true)"
[ "$CERT_COUNT" -ge 3 ] || die "p12 contains $CERT_COUNT certificate(s), expected 3 (leaf + 2 CAs)"
log "p12 contains $CERT_COUNT certificates"

# ---------------------------------------------------------------------------
# (6) Prove macOS sees a valid codesigning identity (throwaway keychain).
# Mirrors what scripts/macos-sign.sh does in CI.
# ---------------------------------------------------------------------------
log "importing into a throwaway keychain"
KC_PASS="$(openssl rand -base64 24)"
KEYCHAIN="$WORK/throwaway.keychain-db"
security create-keychain -p "$KC_PASS" "$KEYCHAIN"
security set-keychain-settings -lut 600 "$KEYCHAIN"
security unlock-keychain -p "$KC_PASS" "$KEYCHAIN"
security import "$P12" -k "$KEYCHAIN" -P "$P12_PASS" -f pkcs12 \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null \
  || die "security import rejected DeveloperID.p12"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PASS" "$KEYCHAIN" >/dev/null

# Put the throwaway keychain on the search list so trust evaluation can find
# the intermediates; the original list is restored by the EXIT trap.
while IFS= read -r kc; do
  kc="${kc#"${kc%%[![:space:]]*}"}"
  kc="${kc#\"}"
  kc="${kc%\"}"
  [ -n "$kc" ] && ORIG_KEYCHAINS+=("$kc")
done < <(security list-keychains -d user)
SEARCH_LIST_CHANGED=1
security list-keychains -d user -s "$KEYCHAIN" ${ORIG_KEYCHAINS[@]+"${ORIG_KEYCHAINS[@]}"}

IDENTITIES="$(security find-identity -v -p codesigning "$KEYCHAIN")"
printf '%s\n' "$IDENTITIES" | sed 's/^/    /'
IDENTITY_LINE="$(printf '%s\n' "$IDENTITIES" | grep -F "\"$CN_PREFIX" | head -n 1 || true)"
[ -n "$IDENTITY_LINE" ] \
  || die "no valid '$CN_PREFIX' identity found in the throwaway keychain (chain not trusted or key not paired)"
IDENTITY_NAME="$(printf '%s\n' "$IDENTITY_LINE" | sed -E 's/^[^"]*"(.*)"[^"]*$/\1/')"
IDENTITY_HASH="$(printf '%s\n' "$IDENTITY_LINE" | awk '{print $2}')"
log "valid identity: $IDENTITY_NAME ($IDENTITY_HASH)"

# Restore the search list and delete the keychain now (trap is the fallback).
security list-keychains -d user -s ${ORIG_KEYCHAINS[@]+"${ORIG_KEYCHAINS[@]}"}
SEARCH_LIST_CHANGED=0
security delete-keychain "$KEYCHAIN"
KEYCHAIN=""
log "throwaway keychain deleted, search list restored"

# ---------------------------------------------------------------------------
# (7) Single-line base64 for the GitHub secret + next steps.
# ---------------------------------------------------------------------------
openssl base64 -A -in "$P12" | tr -d '\n' > "$P12_B64"
chmod 600 "$P12_B64"
log "wrote $P12_B64"

cat <<EOF

Done. Artifacts in $SECRETS_DIR:
  DeveloperID.p12       (chmod 600)
  devid.p12.password    (chmod 600)
  devid.p12.b64         (chmod 600)

Next steps (run from the nan-desktop repo checkout):
  gh secret set APPLE_CERTIFICATE < "$P12_B64"
  gh secret set APPLE_CERTIFICATE_PASSWORD < "$P12_PASS_FILE"

Optional (macos-sign.sh auto-detects the identity if unset):
  gh secret set APPLE_SIGNING_IDENTITY --body "$IDENTITY_NAME"

Keep devid.key and DeveloperID.p12 offline and backed up; never commit them.
EOF
