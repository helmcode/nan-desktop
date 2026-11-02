import { describe, expect, it } from "vitest";
import { extractFilePaths, isInsideRoots, messageFiles } from "./filePaths";

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

describe("messageFiles (round 3: produced files always get a chip)", () => {
  const DL = "/Users/ana/Downloads";

  it("shows a produced .html as a chip even when the reply never names it", () => {
    const files = messageFiles("Listo, he creado la web.", [DL], [
      { path: `${DL}/informe-bbva/index.html`, kind: "file" },
    ]);
    expect(files.chips).toEqual([`${DL}/informe-bbva/index.html`]);
    expect(files.images).toEqual([]);
  });

  it("merges produced files with mentioned ones, produced first, deduplicated", () => {
    const files = messageFiles(`Abre ${DL}/informe-bbva/index.html y ${DL}/notas.md`, [DL], [
      { path: `${DL}/informe-bbva/index.html`, kind: "file" },
      { path: `${DL}/informe-bbva/informe.pdf`, kind: "file" },
    ]);
    expect(files.chips).toEqual([
      `${DL}/informe-bbva/index.html`,
      `${DL}/informe-bbva/informe.pdf`,
      `${DL}/notas.md`,
    ]);
  });

  it("keeps produced files after the folder selection changed (the core re-checks on open)", () => {
    expect(messageFiles("", [], [{ path: `${DL}/a.html`, kind: "file" }]).chips).toEqual([`${DL}/a.html`]);
  });

  it("splits generated images out to render inline", () => {
    const files = messageFiles("Aquí tienes la imagen.", [DL], [
      { path: "/data/images/1.png", kind: "image" },
    ]);
    expect(files.images).toEqual(["/data/images/1.png"]);
    expect(files.chips).toEqual([]);
  });

  it("tolerates rows without artifacts (older app versions)", () => {
    expect(messageFiles(`${DL}/a.txt`, [DL], undefined)).toEqual({ chips: [`${DL}/a.txt`], images: [] });
  });
});

describe("isInsideRoots", () => {
  it("requires a separator after the root", () => {
    expect(isInsideRoots(`${ROOT}/a.txt`, [ROOT])).toBe(true);
    expect(isInsideRoots(`${ROOT}x/a.txt`, [ROOT])).toBe(false);
    expect(isInsideRoots(`${ROOT}/a.txt`, [`${ROOT}/`])).toBe(true);
  });
});
