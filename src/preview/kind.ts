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
  /// `file`: a file inside the user's folders (read by the core, grant-checked).
  /// `web`: an https page. `media`: an image the app generated under
  /// `app_data/images`, shown through the asset protocol (the same scoped
  /// path the inline chat image uses; never read through the grant API).
  kind: "file" | "web" | "media";
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

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt", "log", "json", "jsonl", "yaml", "yml", "toml", "ini", "xml", "svg", "tsv",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql", "css", "scss", "env",
]);

/// Every file extension the pane can preview (lowercase).
export const PREVIEWABLE_EXTENSIONS: readonly string[] = [...Object.keys(EXTENSIONS), ...TEXT_EXTENSIONS];

export function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function previewKind(target: PreviewTarget): PreviewKind {
  if (target.kind === "web") return /^https?:\/\//i.test(target.ref) ? "web" : "unsupported";
  if (target.kind === "media") return "image";
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

/// Issue #57: a share link of one of the two tenants' artifact hosts
/// (https, exact host, exact `/a/<token>` path; query and fragment
/// ignored). Mirrors `artifact_link::parse_share_url` in the core, which
/// re-checks it; every other URL keeps the generic web preview.
const ARTIFACT_SHARE_URL =
  /^https:\/\/(?:artifacts\.nan\.builders|artifacts\.helmcode\.com)\/a\/[A-Za-z0-9_-]{16,128}(?:[?#][^\s]*)?$/i;

export function isArtifactShareUrl(url: string): boolean {
  return url.length <= 2048 && ARTIFACT_SHARE_URL.test(url.trim());
}

export function targetKey(target: PreviewTarget): string {
  return `${target.kind}:${target.ref}`;
}
