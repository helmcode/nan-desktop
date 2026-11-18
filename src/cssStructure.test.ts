// Guard against broken stylesheets (a merge once left a rule unclosed, so
// every later rule became nested and silently stopped applying): braces
// must balance and only at-rules (@media, @supports, @keyframes...) may
// contain blocks. No native CSS nesting is used in this app.
import { describe, expect, it } from "vitest";
import { cssStructureProblems } from "./cssStructure";

const sheets = import.meta.glob(["./**/*.css"], { query: "?raw", import: "default", eager: true }) as Record<
  string,
  string
>;

describe("stylesheet structure", () => {
  it("finds the app stylesheets", () => {
    expect(Object.keys(sheets).some((f) => f.endsWith("App.css"))).toBe(true);
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
