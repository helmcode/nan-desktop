// Round 4: the preview pane opens what the assistant (or the composer's
// image mode) just produced, so the user never has to guess among chips.
//
// Rules:
// - only the reply that JUST finished counts (the newest assistant row);
//   switching conversations never re-opens anything by itself;
// - within that reply the FINAL DELIVERABLE wins (round 15): a turn that
//   builds a PDF also leaves scratch files behind (measure.js, debug.html,
//   preview-p1.png), and following the last touched file opened those
//   instead of the requested document. The order is:
//     1. a produced artifact the final message names (path or file name),
//        when it is not a scratch file (the last such one);
//     2. the last produced artifact that is not a scratch file;
//     3. a scratch artifact the final message names (the user asked for it);
//     4. nothing: pure intermediates never steal the pane (they stay chips);
// - a generated image (composer image row `media_path`, or an `image`
//   artifact from the generate_image tool) opens as a `media` target ,
//   it lives under app_data/images and is shown through the asset
//   protocol; a produced file opens as a `file` target (grant-checked read);
// - the user can still close the pane: a reply that produced nothing new
//   leaves the pane as the user left it.

import type { Artifact, ChatMessageRow } from "../types";
import type { PreviewTarget } from "../preview/kind";

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
  // Helper scripts and throwaway pages written along the way.
  /^(debug|measure|scratch|tmp|temp|test|check|probe)[-_.]/i,
  /[-_](debug|tmp|temp|scratch)\.[a-z0-9]+$/i,
  /\.(js|mjs|cjs|ts|py|sh|log|tmp)$/i,
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

/** The artifact a finished reply should open (see the rules above). */
export function finalDeliverable(content: string, artifacts: Artifact[]): Artifact | null {
  const usable = artifacts.filter((a) => typeof a.path === "string" && a.path.length > 0);
  const last = (list: Artifact[]): Artifact | null => list[list.length - 1] ?? null;
  const named = usable.filter((a) => mentionsFile(content, a.path));
  const real = usable.filter((a) => !isScratchFile(a.path));
  return last(named.filter((a) => !isScratchFile(a.path))) ?? last(real) ?? last(named);
}

export function lastProducedTarget(rows: ChatMessageRow[]): PreviewTarget | null {
  const last = [...rows].reverse().find((row) => row.role === "assistant");
  if (!last) return null;
  if (last.media_path) return { kind: "media", ref: last.media_path };
  const artifact = finalDeliverable(last.content ?? "", last.artifacts ?? []);
  if (!artifact) return null;
  return { kind: artifact.kind === "image" ? "media" : "file", ref: artifact.path };
}
