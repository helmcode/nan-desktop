#!/usr/bin/env bash
# One-time: generate the auto-update signing keypair (minisign, via the Tauri
# CLI) and embed its PUBLIC key in src-tauri/tauri.conf.json.
#
#   scripts/brand/updater.key           private key   (gitignored, *.key)
#   scripts/brand/updater.key.password  its password  (gitignored)
#   scripts/brand/updater.key.pub       public key    (safe to commit)
#
# Then add to GitHub > Settings > Secrets and variables > Actions:
#   TAURI_SIGNING_PRIVATE_KEY           = contents of scripts/brand/updater.key
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  = contents of scripts/brand/updater.key.password
#
# Losing the private key means installed apps can never be updated again
# (they only accept updates signed by the key they embed): back it up.
set -euo pipefail
cd "$(dirname "$0")/.."

key=scripts/brand/updater.key
pw_file=scripts/brand/updater.key.password
conf=src-tauri/tauri.conf.json
placeholder=REPLACE_WITH_UPDATER_PUBLIC_KEY

if [ -e "$key" ]; then
  echo "refusing to overwrite $key (it signs every update installed apps accept)" >&2
  exit 1
fi
grep -q "$placeholder" "$conf" || {
  echo "$conf already has a pubkey; not replacing it" >&2
  exit 1
}

umask 077
password=$(openssl rand -hex 32)
printf '%s' "$password" > "$pw_file"
pnpm exec tauri signer generate --ci -w "$key" -p "$password"

pub=$(tr -d '\n' < "$key.pub")
PUB="$pub" PLACEHOLDER="$placeholder" CONF="$conf" node -e '
  const fs = require("fs");
  const { PUB, PLACEHOLDER, CONF } = process.env;
  fs.writeFileSync(CONF, fs.readFileSync(CONF, "utf8").replace(PLACEHOLDER, PUB));
'
echo "pubkey embedded in $conf:"
echo "$pub"
echo
echo "Now add the two GitHub secrets listed at the top of this script."
