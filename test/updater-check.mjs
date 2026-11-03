#!/usr/bin/env node
// Round 7 acceptance check for the signed auto-update wiring. Static: no
// network, no keys. Asserts that
//   1. tauri.conf.json embeds a REAL minisign public key and the permanent
//      latest.json endpoint, with the private-key-only build option kept
//      out of the base config (local builds never need the key);
//   2. the core registers the plugin and ONLY its own two commands drive it
//      (no updater permission reaches the renderer);
//   3. the latest.json builder maps the stable asset names to the updater
//      platform keys, inlines signatures, refuses a partial feed;
//   4. release.yml renames every updater asset AND its .sig to those stable
//      names, signs the macOS payload, and publishes the feed;
//   5. the private key and its password can never be committed.
//
// Exit 0 = pass. Any failure exits non-zero.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UPDATER_TARGETS, buildManifest } from "../scripts/updater-manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// CRLF-safe (Windows checkouts).
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function assertThrows(fn, pattern) {
  try {
    fn();
  } catch (err) {
    assert(pattern.test(err.message), `threw "${err.message}", expected ${pattern}`);
    return;
  }
  throw new Error(`did not throw (expected ${pattern})`);
}

const ENDPOINT = "https://github.com/helmcode/nan-desktop/releases/latest/download/latest.json";
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const updater = conf.plugins?.updater ?? {};

// ------------------------------------------------------------- 1. config --
check("updater endpoint is the permanent latest.json URL (https only)", () => {
  assert(JSON.stringify(updater.endpoints) === JSON.stringify([ENDPOINT]), `endpoints = ${JSON.stringify(updater.endpoints)}`);
  assert(!updater.dangerousInsecureTransportProtocol, "insecure transport must stay off");
});

check("pubkey is a real minisign public key (not the placeholder)", () => {
  const pubkey = String(updater.pubkey ?? "");
  assert(
    !/REPLACE/.test(pubkey),
    "pubkey is still the placeholder: run `bash scripts/updater-keygen.sh` (see SIGNING.md, Auto-update)",
  );
  const text = Buffer.from(pubkey, "base64").toString("utf8");
  const lines = text.trim().split("\n");
  assert(lines.length === 2, "decoded pubkey must be a 2-line minisign key file");
  assert(/^untrusted comment: minisign public key/.test(lines[0]), `unexpected comment line: ${lines[0]}`);
  const raw = Buffer.from(lines[1].trim(), "base64");
  assert(raw.length === 42, `key is ${raw.length} bytes, expected 42`);
  assert(raw.subarray(0, 2).toString("latin1") === "Ed", "key algorithm must be Ed25519 (Ed)");
});

check("Windows updates install passively (progress only, no wizard)", () => {
  assert(updater.windows?.installMode === "passive", `installMode = ${updater.windows?.installMode}`);
});

check("createUpdaterArtifacts is NOT in the base config (release overlay only)", () => {
  assert(conf.bundle?.createUpdaterArtifacts === undefined, "local builds would require the private key");
});

// --------------------------------------------------------------- 2. core --
check("the core depends on and registers the updater plugin + its two commands", () => {
  const cargo = read("src-tauri/Cargo.toml");
  assert(/^tauri-plugin-updater\s*=/m.test(cargo), "Cargo.toml lacks tauri-plugin-updater");
  const lib = read("src-tauri/src/lib.rs");
  assert(lib.includes("tauri_plugin_updater::Builder::new().build()"), "plugin not registered");
  assert(lib.includes("updater::update_check"), "update_check not registered");
  assert(lib.includes("updater::update_install"), "update_install not registered");
  assert(lib.includes(".manage(updater::UpdaterState::default())"), "UpdaterState not managed");
});

check("no updater (or process) permission is granted to the renderer", () => {
  const cap = read("src-tauri/capabilities/default.json");
  assert(!/"updater:/.test(cap), "renderer must not drive the updater plugin directly");
  assert(!/"process:/.test(cap), "relaunch happens in the core");
});

check("the renderer never installs without a click", () => {
  const banner = read("src/components/UpdateBanner.tsx");
  const installs = banner.match(/await install\(\)/g) ?? [];
  assert(installs.length === 1, "install must be called from exactly one place");
  assert(/const onUpdate = async/.test(banner) && /onClick=\{\(\) => void onUpdate\(\)\}/.test(banner), "install must be wired to the Update button only");
});

// ----------------------------------------------------------- 3. manifest --
const SIG = (name) => `dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmb3IgJ${name}'\n`;
const allRequired = () =>
  new Map(UPDATER_TARGETS.filter((t) => t.required).map((t) => [t.asset, SIG(t.asset)]));

check("manifest: version, tag URLs, inlined signatures, every platform key", () => {
  const m = buildManifest({
    tag: "v0.3.0",
    repo: "helmcode/nan-desktop",
    notes: "n",
    pubDate: "2026-11-03T10:00:00Z",
    signatures: allRequired(),
  });
  assert(m.version === "0.3.0", `version ${m.version}`);
  assert(m.pub_date === "2026-11-03T10:00:00Z", "pub_date");
  const keys = Object.keys(m.platforms).sort();
  const expected = [
    "darwin-aarch64",
    "darwin-aarch64-app",
    "darwin-x86_64",
    "darwin-x86_64-app",
    "linux-x86_64",
    "linux-x86_64-appimage",
    "windows-x86_64",
    "windows-x86_64-msi",
    "windows-x86_64-nsis",
  ];
  assert(JSON.stringify(keys) === JSON.stringify(expected), `platforms ${keys.join(",")}`);
  const mac = m.platforms["darwin-aarch64"];
  assert(
    mac.url ===
      "https://github.com/helmcode/nan-desktop/releases/download/v0.3.0/Helmcode.Desktop-macOS-AppleSilicon.app.tar.gz",
    `url ${mac.url}`,
  );
  assert(mac.signature === SIG("Helmcode.Desktop-macOS-AppleSilicon.app.tar.gz").trim(), "signature not trimmed/inlined");
  assert(m.platforms["windows-x86_64"].url.endsWith("/Helmcode.Desktop-Windows-x64-setup.exe"), "nsis is the default windows");
  assert(m.platforms["windows-x86_64-msi"].url.endsWith("/Helmcode.Desktop-Windows-x64.msi"), "msi installs update via msi");
});

check("manifest: optional deb/rpm entries appear only when signed", () => {
  const sigs = allRequired();
  sigs.set("Helmcode.Desktop-Linux-amd64.deb", SIG("deb"));
  const m = buildManifest({ tag: "v1.0.0", repo: "a/b", signatures: sigs });
  assert(m.platforms["linux-x86_64-deb"], "deb missing");
  assert(!m.platforms["linux-x86_64-rpm"], "rpm must be absent without a signature");
});

check("manifest: refuses a partial feed, a bad tag, or a bad repo", () => {
  const sigs = allRequired();
  sigs.delete("Helmcode.Desktop-Windows-x64.msi");
  assertThrows(() => buildManifest({ tag: "v0.3.0", repo: "a/b", signatures: sigs }), /Windows-x64\.msi\.sig/);
  assertThrows(() => buildManifest({ tag: "latest", repo: "a/b", signatures: allRequired() }), /not a vX\.Y\.Z/);
  assertThrows(() => buildManifest({ tag: "v0.3.0", repo: "a/b/../c", signatures: allRequired() }), /bad repo/);
});

// ------------------------------------------------------------ 4. release --
const release = read(".github/workflows/release.yml");
check("release renames every updater asset and its signature to the stable names", () => {
  for (const { asset } of UPDATER_TARGETS) {
    assert(release.includes(`"${asset}"`), `rename-assets lacks ${asset}`);
    assert(release.includes(`"${asset}.sig"`), `rename-assets lacks ${asset}.sig`);
  }
});

check("release signs, builds and publishes the feed", () => {
  for (const needle of [
    "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    "createUpdaterArtifacts",
    "includeUpdaterJson: false",
    'pnpm tauri signer sign "$out/$tar_name"',
    "node scripts/updater-manifest.mjs",
    "assets?name=latest.json",
  ]) {
    assert(release.includes(needle), `release.yml lacks: ${needle}`);
  }
});

// ------------------------------------------------------------ 5. secrets --
check("the updater private key and its password are gitignored", () => {
  const ignore = read(".gitignore");
  assert(/^\*\.key$/m.test(ignore), "*.key not ignored");
  assert(/^scripts\/brand\/updater\.key\.password$/m.test(ignore), "updater.key.password not ignored");
});

if (failures > 0) {
  console.error(`\nupdater-check: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nupdater-check: all passed");
