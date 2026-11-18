// Guard against broken stylesheets (a merge once left a rule unclosed, so
// every later rule became nested and silently stopped applying): braces
// must balance and only at-rules (@media, @supports, @keyframes...) may
// contain blocks. No native CSS nesting is used in this app.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cssStructureProblems } from "./cssStructure";

// Read from disk: under Vitest a `?raw` CSS import comes back EMPTY (CSS is
// not processed in tests), which once made this whole guard vacuous.
function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

const sheets: Record<string, string> = Object.fromEntries(
  cssFiles("src").map((file) => [file, readFileSync(file, "utf8")]),
);

describe("stylesheet structure", () => {
  it("finds the app stylesheets", () => {
    expect(Object.keys(sheets)).toContain(join("src", "App.css"));
    expect(sheets[join("src", "App.css")].length).toBeGreaterThan(1000);
  });

  it.each(Object.entries(sheets))("%s has balanced braces and no nested rules", (_file, css) => {
    expect(cssStructureProblems(css)).toEqual([]);
  });

  it("catches an unclosed rule that swallows the next ones", () => {
    const broken = ".a {\n  color: red;\n.b { color: blue; }\n";
    expect(cssStructureProblems(broken).join(" ")).toMatch(/nested rule "\.b"/);
    expect(cssStructureProblems(broken).join(" ")).toMatch(/unclosed block/);
    expect(cssStructureProblems(".a{}}")).toContain("unbalanced closing brace");
    expect(cssStructureProblems("@media (max-width: 10px) { .a { color: red; } }")).toEqual([]);
    expect(cssStructureProblems("@keyframes x { from { opacity: 0; } to { opacity: 1; } }")).toEqual([]);
  });
});

// Regressions that only show in the real window (jsdom has no layout).
describe("layout guards", () => {
  const app = sheets[join("src", "App.css")] ?? "";
  const rule = (selector: string): string => {
    const start = app.indexOf(`${selector} {`);
    return start < 0 ? "" : app.slice(start, app.indexOf("}", start));
  };

  it("a long account email wraps inside the account menu instead of overflowing it", () => {
    expect(rule(".user-menu-account-text strong")).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule(".user-menu-account-text")).toMatch(/min-width:\s*0/);
  });
});
