// Round 4: the preview pane opens what the assistant (or the composer's
// image mode) just produced, so the user never has to guess among chips.
//
// Rules:
// - only the reply that JUST finished counts (the newest assistant row);
//   switching conversations never re-opens anything by itself;
// - a reply that produced exactly ONE file opens it, whatever its name
//   (D2): the user asked for that one artifact (a script, a test page) and
//   there is nothing else it could be scratch FOR. Scripts and render
//   checks are treated as scratch only when other files exist;
// - otherwise, within that reply the FINAL DELIVERABLE wins (round 15): a turn that
//   builds a PDF also leaves scratch files behind (measure.js, debug.html,
//   preview-p1.png, p1.png..p9.png), and following the last touched file
//   opened those instead of the requested document. The order (round 16) is:
//     1. a produced artifact the final message names (path or file name),
//        when it is not a scratch file (the last such one);
//     2. a produced non-scratch artifact whose extension matches the kind
//        the USER asked for in the turn's message ("hazme un PDF", "an Excel
//        sheet", "unas diapositivas"); specific kinds (pdf, xlsx, pptx, docx,
//        png) are tried before generic ones (documento, imagen);
//     3. the last produced artifact that is not a scratch file;
//     4. a scratch artifact the final message names (the user asked for it);
//     5. nothing: pure intermediates never steal the pane (they stay chips);
// - round 17: tools DECLARE what they produced (`chat://output`): a render
//   command declares its document the DELIVERABLE and what it left behind
//   (page and cover rasterisations, fonts, helper scripts) a BYPRODUCT; the
//   image tool declares the image a deliverable. The priority is now:
//     1. a single produced file (D2, unchanged);
//     2. the LAST tool-declared deliverable of the turn;
//     3. a file the final message names (not scratch, not a byproduct);
//     4. the round 15/16 name heuristics above (2..5), last resort, with
//        declared byproducts treated as scratch;
// - a generated image (composer image row `media_path`, or an `image`
//   artifact from the generate_image tool) opens as a `media` target ,
//   it lives under app_data/images and is shown through the asset
//   protocol; a produced file opens as a `file` target (grant-checked read);
// - the user can still close the pane: a reply that produced nothing new
//   leaves the pane as the user left it.

import type { Artifact, ChatMessageRow } from "../types";
import type { PreviewTarget } from "../preview/kind";

/** A file a tool produced, with the role it declared (`chat://output`). */
export interface DeclaredOutput {
  path: string;
  role: "deliverable" | "byproduct";
  kind: "document" | "image" | null;
}

/** The file name of a POSIX or Windows path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

const SCRATCH_STEMS = new Set(["debug", "measure", "scratch", "tmp", "temp", "test", "check", "probe"]);
const SCRATCH_PATTERNS: RegExp[] = [
  // Render checks of a document: preview-p1.png, page-2.png, render_3.jpg.
  /^(preview|page|render|snapshot|thumb|thumbnail|shot|screenshot)([-_]?p?\d+)?\.(png|jpe?g|webp)$/i,
  /^(preview|render|snapshot|thumb)[-_].*\.(png|jpe?g|webp|html?)$/i,
  // Round 16: bare page renders by NAME shape, whatever the extension:
  // p1.png..p9.png, p12.jpg, pg3.svg, page4.html, slide-2.png. A turn that
  // rasterises a PDF page by page to check it leaves exactly these behind.
  // Caveat: a real deliverable literally named page4.html or slide-2.png also
  // matches and loses priority (it still opens when it is the turn's only
  // file or the final message names it).
  /^(p|pg|page|slide)[-_]?\d+\.[a-z0-9]+$/i,
  // Helper scripts and throwaway pages written along the way, by stem prefix
  // or suffix (probe.html, probe-fonts.html, debug_layout.html, out-tmp.txt).
  /^(debug|measure|scratch|tmp|temp|test|check|probe)[-_.]/i,
  /[-_](debug|tmp|temp|scratch|probe)\.[a-z0-9]+$/i,
  // Code, logs and supporting assets (stylesheets, source maps): they serve
  // the deliverable, they are not it.
  /\.(js|mjs|cjs|ts|py|sh|log|tmp|css|map)$/i,
  // Hidden or underscore-prefixed files.
  /^[._]/,
];
const SCRATCH_DIRS = /[\\/](\.cache|\.scratch|node_modules)[\\/]/i;

/** Whether a produced file looks like an intermediate of the turn. */
export function isScratchFile(path: string): boolean {
  const name = baseName(path);
  const stem = name.replace(/\.[^.]*$/, "").toLowerCase();
  return SCRATCH_STEMS.has(stem) || SCRATCH_PATTERNS.some((re) => re.test(name)) || SCRATCH_DIRS.test(path);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether the message names `path`: the full path, or its file name as a whole token. */
export function mentionsFile(text: string, path: string): boolean {
  if (!text) return false;
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // A stray % in prose: match the raw text only.
  }
  const name = baseName(path);
  if (!name) return false;
  const token = new RegExp(`(^|[^\\w.-])${escapeRegExp(name)}($|[^\\w-]|\\.(?![\\w]))`);
  return [text, decoded].some((body) => body.includes(path) || token.test(body));
}

/** Artifact kinds a user can ask for, specific before generic (rule 2). */
const REQUESTED_KINDS: { words: RegExp; exts: string[] }[] = [
  { words: /\bpdfs?\b/, exts: ["pdf"] },
  {
    words: /\b(excel|xlsx?|spreadsheets?|sheets?|hojas? de calculo|csv)\b/,
    exts: ["xlsx", "xls", "csv", "ods"],
  },
  {
    words: /\b(pptx?|powerpoint|slides?|diapositivas?|presentacion(es)?|presentations?|decks?)\b/,
    exts: ["pptx", "ppt", "odp", "key"],
  },
  { words: /\b(word|docx?)\b/, exts: ["docx", "doc", "odt"] },
  { words: /\b(png|jpe?g|webp|svg)\b/, exts: ["png", "jpg", "jpeg", "webp", "svg"] },
  // Generic nouns: only when no specific kind above matched first.
  { words: /\b(documentos?|documents?)\b/, exts: ["docx", "doc", "odt", "pdf", "md"] },
  {
    words: /\b(imagen(es)?|images?|fotos?|photos?|pictures?|ilustracion(es)?|illustrations?)\b/,
    exts: ["png", "jpg", "jpeg", "webp", "svg", "gif"],
  },
];

/**
 * The extension groups the user's message asks for, in priority order
 * (specific kinds first). Accent- and case-insensitive, Spanish and English.
 */
export function requestedExtensions(request: string): string[][] {
  if (!request) return [];
  const text = request
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return REQUESTED_KINDS.filter((kind) => kind.words.test(text)).map((kind) => kind.exts);
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * A rasterisation of another produced file (deck.pdf.png, report.pdf.jpg):
 * a cover or page render of the document, never the document itself.
 */
function isRenderOfSibling(path: string, paths: ReadonlySet<string>): boolean {
  const stripped = path.replace(/\.(png|jpe?g|webp)$/i, "");
  return stripped !== path && paths.has(stripped);
}

/** The artifact a finished reply should open (see the rules above). */
export function finalDeliverable(
  content: string,
  artifacts: Artifact[],
  request = "",
  declared: DeclaredOutput[] = [],
): Artifact | null {
  const usable = artifacts.filter((a) => typeof a.path === "string" && a.path.length > 0);
  const last = <T>(list: T[]): T | null => list[list.length - 1] ?? null;
  // 1. One file (written once or rewritten): it is the deliverable (D2).
  if (new Set(usable.map((a) => a.path)).size === 1) return last(usable);
  // 2. The last deliverable a tool declared this turn.
  const deliverable = last(declared.filter((d) => d.role === "deliverable" && d.path.length > 0));
  if (deliverable) {
    const produced = last(usable.filter((a) => a.path === deliverable.path));
    return produced ?? { path: deliverable.path, kind: deliverable.kind === "image" ? "image" : "file" };
  }
  const byproducts = new Set(declared.filter((d) => d.role === "byproduct").map((d) => d.path));
  const paths = new Set(usable.map((a) => a.path));
  const scratch = (a: Artifact): boolean =>
    byproducts.has(a.path) || isScratchFile(a.path) || isRenderOfSibling(a.path, paths);
  // 3. A file the final message names.
  const named = usable.filter((a) => mentionsFile(content, a.path));
  const namedReal = last(named.filter((a) => !scratch(a)));
  if (namedReal) return namedReal;
  // 4. Last resort: the name heuristics.
  const real = usable.filter((a) => !scratch(a));
  for (const exts of requestedExtensions(request)) {
    const asked = last(real.filter((a) => exts.includes(extensionOf(a.path))));
    if (asked) return asked;
  }
  return last(real) ?? last(named);
}

export function lastProducedTarget(rows: ChatMessageRow[], declared: DeclaredOutput[] = []): PreviewTarget | null {
  let index = rows.length - 1;
  while (index >= 0 && rows[index].role !== "assistant") index -= 1;
  if (index < 0) return null;
  const last = rows[index];
  if (last.media_path) return { kind: "media", ref: last.media_path };
  // The user's message that started this turn: what kind of file they asked for.
  let ask = index - 1;
  while (ask >= 0 && rows[ask].role !== "user") ask -= 1;
  const request = ask >= 0 ? (rows[ask].content ?? "") : "";
  const artifact = finalDeliverable(last.content ?? "", last.artifacts ?? [], request, declared);
  if (!artifact) return null;
  return { kind: artifact.kind === "image" ? "media" : "file", ref: artifact.path };
}
