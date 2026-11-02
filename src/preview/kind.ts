// S21: what the preview pane can show, decided by target type/extension.

export type PreviewKind =
  | "image"
  | "pdf"
  | "markdown"
  | "html"
  | "text"
  | "sheet"
  | "docx"
  | "web"
  | "unsupported";

export interface PreviewTarget {
  kind: "file" | "web";
  /// Absolute local path or https URL.
  ref: string;
}

const EXTENSIONS: Record<string, PreviewKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  bmp: "image",
  avif: "image",
  pdf: "pdf",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  xlsx: "sheet",
  xls: "sheet",
  ods: "sheet",
  csv: "sheet",
  docx: "docx",
};

const TEXT_EXTENSIONS = new Set([
  "txt", "log", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "svg", "tsv",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "css", "scss", "env",
]);

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewKind(target: PreviewTarget): PreviewKind {
  if (target.kind === "web") return /^https?:\/\//i.test(target.ref) ? "web" : "unsupported";
  const ext = extensionOf(target.ref);
  if (EXTENSIONS[ext]) return EXTENSIONS[ext];
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "unsupported";
}

/// Code fence language for text previews (highlighting hint).
export function codeLanguage(path: string): string {
  const ext = extensionOf(path);
  return ext === "yml" ? "yaml" : ext === "svg" ? "xml" : ext;
}

export function targetKey(target: PreviewTarget): string {
  return `${target.kind}:${target.ref}`;
}
