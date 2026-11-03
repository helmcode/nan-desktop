#!/usr/bin/env node
// Builds the signed auto-update feed (latest.json) for a release.
//
// The release workflow renames every asset to a STABLE name (rename-assets
// job) and the updater signatures (<asset>.sig, minisign, produced with the
// TAURI_SIGNING_PRIVATE_KEY) are renamed alongside. This script maps those
// stable names to the updater's platform keys and inlines each signature.
// Download URLs point at the release TAG (not /latest/), so an app that
// checked a moment before a newer release still downloads what it verified.
//
// The app fetches this file from
//   https://github.com/helmcode/nan-desktop/releases/latest/download/latest.json
// (tauri.conf.json > plugins.updater.endpoints), which only resolves once the
// draft release is PUBLISHED.
//
// Usage:
//   node scripts/updater-manifest.mjs --tag v0.3.0 --repo owner/name \
//        --sigs <dir with the downloaded .sig files> --out latest.json [--notes "..."]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/// Stable asset names (see rename-assets in .github/workflows/release.yml)
/// and the updater platform keys each one serves. The plugin first looks for
/// `<os>-<arch>-<installer>` and falls back to `<os>-<arch>`, so an msi
/// install updates through the msi and an nsis install through the setup exe.
export const UPDATER_TARGETS = [
  {
    asset: "Helmcode.Desktop-macOS-AppleSilicon.app.tar.gz",
    platforms: ["darwin-aarch64", "darwin-aarch64-app"],
    required: true,
  },
  {
    asset: "Helmcode.Desktop-macOS-Intel.app.tar.gz",
    platforms: ["darwin-x86_64", "darwin-x86_64-app"],
    required: true,
  },
  {
    asset: "Helmcode.Desktop-Windows-x64-setup.exe",
    platforms: ["windows-x86_64", "windows-x86_64-nsis"],
    required: true,
  },
  { asset: "Helmcode.Desktop-Windows-x64.msi", platforms: ["windows-x86_64-msi"], required: true },
  {
    asset: "Helmcode.Desktop-Linux-amd64.AppImage",
    platforms: ["linux-x86_64", "linux-x86_64-appimage"],
    required: true,
  },
  // Newer bundlers also sign deb/rpm; offered when present.
  { asset: "Helmcode.Desktop-Linux-amd64.deb", platforms: ["linux-x86_64-deb"], required: false },
  { asset: "Helmcode.Desktop-Linux-x86_64.rpm", platforms: ["linux-x86_64-rpm"], required: false },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/// `signatures`: stable asset name -> contents of its .sig file.
export function buildManifest({ tag, repo, notes = "", pubDate, signatures }) {
  const version = String(tag).replace(/^v/, "");
  if (!SEMVER.test(version)) throw new Error(`tag ${tag} is not a vX.Y.Z version`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) throw new Error(`bad repo ${repo}`);
  const platforms = {};
  const missing = [];
  for (const target of UPDATER_TARGETS) {
    const signature = signatures.get(target.asset)?.trim();
    if (!signature) {
      if (target.required) missing.push(`${target.asset}.sig`);
      continue;
    }
    const url = `https://github.com/${repo}/releases/download/${tag}/${target.asset}`;
    for (const key of target.platforms) platforms[key] = { signature, url };
  }
  if (missing.length > 0) throw new Error(`missing updater signatures: ${missing.join(", ")}`);
  return {
    version,
    notes,
    pub_date: pubDate ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms,
  };
}

/// Reads <dir>/<asset>.sig for every target that has one.
export function readSignatures(dir) {
  const signatures = new Map();
  for (const { asset } of UPDATER_TARGETS) {
    const path = join(dir, `${asset}.sig`);
    if (existsSync(path)) signatures.set(asset, readFileSync(path, "utf8"));
  }
  return signatures;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--") || i + 1 >= argv.length) throw new Error(`bad argument ${key}`);
    args[key.slice(2)] = argv[i + 1];
  }
  for (const required of ["tag", "repo", "sigs", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = buildManifest({
      tag: args.tag,
      repo: args.repo,
      notes: args.notes ?? "",
      signatures: readSignatures(args.sigs),
    });
    writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`wrote ${args.out}: ${manifest.version}, platforms ${Object.keys(manifest.platforms).join(" ")}`);
  } catch (err) {
    console.error(`updater-manifest: ${err.message}`);
    process.exit(1);
  }
}
