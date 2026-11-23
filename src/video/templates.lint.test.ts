// R-V1: every bundled template passes the official HyperFrames lint
// (@hyperframes/lint, the pinned version) with no errors and no warnings,
// and so does the composition root the core generates (golden file kept in
// step by the Rust test `video::project::tests::the_golden_index_is_current`).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lintHyperframeHtml } from "@hyperframes/lint/browser";

const ROOT = "src-tauri/video-templates";
const templates = readdirSync(ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
  .map((entry) => entry.name);

function findings(result: Awaited<ReturnType<typeof lintHyperframeHtml>>): string[] {
  return result.findings
    .filter((f) => f.severity !== "info")
    .map((f) => `${f.severity} ${f.code}: ${f.message.slice(0, 200)}`);
}

describe("templates pass @hyperframes/lint", () => {
  it("finds the templates", () => {
    expect(templates.length).toBeGreaterThanOrEqual(1);
  });

  it.each(templates)("%s", async (id) => {
    const dir = join(ROOT, id, "compositions");
    expect(existsSync(dir)).toBe(true);
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".html"))) {
      const html = readFileSync(join(dir, file), "utf8");
      const result = await lintHyperframeHtml(html, { filePath: `compositions/${file}`, isSubComposition: true, distributed: true });
      expect(findings(result), `${id}/${file}`).toEqual([]);
    }
  });

  it("the generated composition root", async () => {
    const html = readFileSync("src-tauri/src/video/testdata/index.golden.html", "utf8");
    const result = await lintHyperframeHtml(html, { filePath: "index.html", distributed: true });
    expect(findings(result)).toEqual([]);
  });
});
