// S21: find local files the assistant mentions so the chat can offer
// preview chips. Only absolute paths with an extension are considered, and
// only inside the user's working folders (or anywhere with computer-wide
// access). The core re-validates every read; this is presentation only.

const POSIX_PATH = /(?:^|[\s(["'<])(\/(?:[^\s`'"()<>[\]]+\/)+[^\s`'"()<>[\]/]+\.[A-Za-z0-9]{1,8})/g;
const WINDOWS_PATH = /(?:^|[\s(["'<])([A-Za-z]:\\(?:[^\\\s`'"()<>[\]]+\\)*[^\\\s`'"()<>[\]]+\.[A-Za-z0-9]{1,8})/g;
const INLINE_CODE = /`([^`\n]+)`/g;
const ABSOLUTE_WITH_EXT = /^(?:\/|[A-Za-z]:\\)[^\n]*[^\\/]\.[A-Za-z0-9]{1,8}$/;

function trimPunctuation(path: string): string {
  return path.replace(/[.,;:!?]+$/, "");
}

function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+$/, "");
}

export function isInsideRoots(path: string, roots: string[] | "any"): boolean {
  if (roots === "any") return true;
  return roots.some((raw) => {
    const root = normalizeRoot(raw);
    if (!root) return false;
    if (!path.startsWith(root)) return false;
    const next = path.charAt(root.length);
    return next === "/" || next === "\\";
  });
}

/// Paths are rejected when they try to climb out of a root.
function hasTraversal(path: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(path);
}

export function extractFilePaths(text: string, roots: string[] | "any"): string[] {
  const found: string[] = [];
  const add = (candidate: string): void => {
    const path = trimPunctuation(candidate.trim());
    if (!ABSOLUTE_WITH_EXT.test(path) || hasTraversal(path)) return;
    if (!isInsideRoots(path, roots)) return;
    if (!found.includes(path)) found.push(path);
  };

  for (const match of text.matchAll(INLINE_CODE)) add(match[1]);
  for (const match of text.matchAll(POSIX_PATH)) add(match[1]);
  for (const match of text.matchAll(WINDOWS_PATH)) add(match[1]);
  return found;
}
