import { describe, expect, it } from "vitest";
import { extractFilePaths, isInsideRoots } from "./filePaths";

const ROOT = "/Users/ana/Proyecto";

describe("extractFilePaths (S21 chips)", () => {
  it("finds absolute paths in prose and inline code", () => {
    const text = `I created ${ROOT}/report.pdf and \`${ROOT}/data/sales.xlsx\`.`;
    expect(extractFilePaths(text, [ROOT])).toEqual([`${ROOT}/data/sales.xlsx`, `${ROOT}/report.pdf`]);
  });

  it("keeps paths with spaces when quoted in inline code", () => {
    expect(extractFilePaths(`Saved \`${ROOT}/Q3 summary.docx\``, [ROOT])).toEqual([`${ROOT}/Q3 summary.docx`]);
  });

  it("drops paths outside the working folders", () => {
    expect(extractFilePaths("See /etc/passwd.txt and /Users/ana/Proyecto2/x.md", [ROOT])).toEqual([]);
  });

  it("drops traversal attempts", () => {
    expect(extractFilePaths(`${ROOT}/../secret.txt`, [ROOT])).toEqual([]);
  });

  it("accepts anything with computer-wide access", () => {
    expect(extractFilePaths("Open /tmp/out.png now.", "any")).toEqual(["/tmp/out.png"]);
  });

  it("ignores paths without an extension and dedupes", () => {
    expect(extractFilePaths(`${ROOT}/folder and ${ROOT}/a.txt ${ROOT}/a.txt`, [ROOT])).toEqual([`${ROOT}/a.txt`]);
  });

  it("supports Windows paths", () => {
    expect(extractFilePaths("Saved C:\\Users\\ana\\Docs\\a.csv.", ["C:\\Users\\ana\\Docs"])).toEqual([
      "C:\\Users\\ana\\Docs\\a.csv",
    ]);
  });

  it("does not treat URLs as files", () => {
    expect(extractFilePaths("https://example.com/a/b.pdf", "any")).toEqual([]);
  });
});

describe("isInsideRoots", () => {
  it("requires a separator after the root", () => {
    expect(isInsideRoots(`${ROOT}/a.txt`, [ROOT])).toBe(true);
    expect(isInsideRoots(`${ROOT}x/a.txt`, [ROOT])).toBe(false);
    expect(isInsideRoots(`${ROOT}/a.txt`, [`${ROOT}/`])).toBe(true);
  });
});
