import { describe, expect, it } from "vitest";
import { codeLanguage, extensionOf, previewKind, targetKey } from "./kind";

const file = (ref: string) => previewKind({ kind: "file", ref });

describe("previewKind (S21)", () => {
  it("maps supported local files", () => {
    expect(file("/a/b.PNG")).toBe("image");
    expect(file("/a/b.jpeg")).toBe("image");
    expect(file("/a/b.pdf")).toBe("pdf");
    expect(file("/a/README.md")).toBe("markdown");
    expect(file("/a/index.html")).toBe("html");
    expect(file("/a/s.xlsx")).toBe("sheet");
    expect(file("/a/s.csv")).toBe("sheet");
    expect(file("/a/d.docx")).toBe("docx");
    expect(file("/a/notes.txt")).toBe("text");
    expect(file("/a/main.rs")).toBe("text");
  });

  it("rejects unknown types", () => {
    expect(file("/a/b.exe")).toBe("unsupported");
    expect(file("/a/noext")).toBe("unsupported");
  });

  it("only previews http(s) web links", () => {
    expect(previewKind({ kind: "web", ref: "https://helmcode.com" })).toBe("web");
    expect(previewKind({ kind: "web", ref: "javascript:alert(1)" })).toBe("unsupported");
  });

  it("helpers", () => {
    expect(extensionOf("/a/.env")).toBe("");
    expect(extensionOf("C:\\x\\y.TXT")).toBe("txt");
    expect(codeLanguage("/a/b.yml")).toBe("yaml");
    expect(targetKey({ kind: "file", ref: "/a" })).toBe("file:/a");
  });
});
