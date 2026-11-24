// R-V1: HyperFrames is ONE pinned version across the player, the lint, the
// runtime the core inlines into the preview, and (out of this repo) the
// server renderer. Bumping it is a coordinated change: this fails when the
// pieces in this repo drift apart.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const VERSION = "0.9.86";
const RUNTIME_SHA256 = "33d00f387cea4763f02c8339022daa3f27004ca8c36ad6b01e8f1afca67d8a2c";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("HyperFrames pin", () => {
  it("package.json pins every @hyperframes package to the exact version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@hyperframes/player"]).toBe(VERSION);
    expect(pkg.dependencies["@hyperframes/lint"]).toBe(VERSION);
    expect(pkg.devDependencies["@hyperframes/core"]).toBe(VERSION);
    for (const name of ["player", "lint", "core"]) {
      const installed = JSON.parse(readFileSync(`node_modules/@hyperframes/${name}/package.json`, "utf8")) as {
        version: string;
      };
      expect(installed.version).toBe(VERSION);
    }
  });

  it("the runtime the core inlines is byte for byte the pinned core build", () => {
    expect(sha256("src-tauri/vendor/hyperframes/hyperframe.runtime.iife.js")).toBe(RUNTIME_SHA256);
    expect(sha256("node_modules/@hyperframes/core/dist/hyperframe.runtime.iife.js")).toBe(RUNTIME_SHA256);
    expect(readFileSync("src-tauri/vendor/hyperframes/NOTICE.md", "utf8")).toContain(RUNTIME_SHA256);
  });

  it("the core's format version names the same release", () => {
    const project = readFileSync("src-tauri/src/video/project.rs", "utf8");
    expect(project).toContain(`pub const HYPERFRAMES_VERSION: &str = "${VERSION}";`);
    const preview = readFileSync("src-tauri/src/video/preview.rs", "utf8");
    expect(preview).toContain(RUNTIME_SHA256);
  });
});
