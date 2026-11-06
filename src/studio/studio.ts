// Image Studio: the rules of an editing session, as pure helpers so they
// are unit-tested apart from the component. The core re-validates every
// edit (count, size, format, ownership); these only keep the UI honest.
//
// A session has one BASE image (always the first image sent, locked in the
// reference tray), up to `maxReferences(model)` extra reference images
// (none for FLUX), and a lineage history: the image the session started
// from, then one node per edit result. Clicking a history node makes it the
// new base.
//
// The region tools (see `annotate.ts`) mark an area on an overlay; an
// annotated edit sends the base, then the marked copy, then the references
// that still fit the model's cap.

/// Most images per edit for any model (qwen; mirrored by the core).
export const MAX_EDIT_IMAGES = 3;

/// Longest instruction the platform accepts, in characters.
export const MAX_EDIT_INSTRUCTION = 2000;

export const QWEN_EDIT_MODEL = "qwen-image-3.0-pro";
export const FLUX_MODEL = "flux-3-image-klein";

/// The model each tenant's edit route runs (the server picks it; the app
/// never sends it). Mirrors `profile::image_edit_model` in the core.
export function editModelFor(profileId: string): string {
  return profileId === "nan" ? QWEN_EDIT_MODEL : FLUX_MODEL;
}

/// Most images one edit on `model` accepts (the bridge's model registry):
/// qwen 1..3, FLUX exactly one (the base). Unknown models get the strictest
/// cap. Mirrors `image_edit::max_edit_images_for` in the core, which
/// re-validates every edit.
export function maxEditImages(model: string): number {
  return model === QWEN_EDIT_MODEL ? MAX_EDIT_IMAGES : 1;
}

/// Extra references next to the base: 2 for qwen, 0 for FLUX.
export function maxReferences(model: string): number {
  return maxEditImages(model) - 1;
}

export interface StudioImage {
  /// Absolute path of an app-owned image: a chat image under the images
  /// folder, or a staged copy of a user file.
  path: string;
  /// Alt text / tooltip (the prompt, the instruction or the file name).
  label: string;
  /// The chat message holding this image; null for staged files.
  messageId: number | null;
  /// A staged copy of a user file. Staged copies stay on disk for the whole
  /// Studio session (any history node or reference can be reused); the
  /// core's startup sweep removes them once they are older than 24 h.
  staged: boolean;
}

export interface HistoryNode {
  image: StudioImage;
}

/// Where the Studio opens from. `base` is ready to edit; `stagePath` is a
/// user file (shown in the preview pane) the Studio stages first; neither
/// means an empty Studio that asks for a file.
export interface StudioSeed {
  /// The conversation the results land in; null creates one on first edit.
  conversationId: number | null;
  base: StudioImage | null;
  stagePath: string | null;
}

/// Add a reference: ignored when it is the base, already there, or the
/// tray is full (`max` from `maxReferences`).
export function addReference(
  refs: readonly StudioImage[],
  base: StudioImage | null,
  image: StudioImage,
  max: number,
): StudioImage[] {
  if (refs.length >= max) return [...refs];
  if (base?.path === image.path || refs.some((ref) => ref.path === image.path)) return [...refs];
  return [...refs, image];
}

export function removeReference(refs: readonly StudioImage[], path: string): StudioImage[] {
  return refs.filter((ref) => ref.path !== path);
}

/// Submit needs a base, a non-blank instruction within the cap (minus the
/// `reserved` characters an annotated edit appends), and no edit running.
export function canSubmit(base: StudioImage | null, instruction: string, running: boolean, reserved = 0): boolean {
  const text = instruction.trim();
  return !running && base !== null && text.length > 0 && [...text].length <= MAX_EDIT_INSTRUCTION - reserved;
}

/// The region tools (brush, rectangle) send the marked copy as a SECOND
/// image next to the base, so they need a model that takes at least two.
export function regionToolsAvailable(model: string): boolean {
  return maxEditImages(model) >= 2;
}

/// References an edit can send: the marked copy takes one reference slot.
export function sendableReferences(maxRefs: number, annotated: boolean): number {
  return Math.max(0, maxRefs - (annotated ? 1 : 0));
}

/// The images an edit sends, base first, never more references than `max`
/// (a FLUX edit sends the base alone: extra images are a 400 server-side).
export function editSources(base: StudioImage, refs: readonly StudioImage[], max: number): string[] {
  return [base.path, ...refs.slice(0, Math.max(0, max)).map((ref) => ref.path)];
}

/// After a successful edit: the result joins the history and becomes the
/// new base. Every image the edit sent (staged copies included) stays
/// usable, so the references stay in the tray for the next iteration and
/// every earlier history node can become the base again.
export function afterEdit(
  history: readonly HistoryNode[],
  refs: readonly StudioImage[],
  result: StudioImage,
): { history: HistoryNode[]; refs: StudioImage[]; base: StudioImage } {
  return {
    history: [...history, { image: result }],
    refs: removeReference(refs, result.path),
    base: result,
  };
}

/// Instruction length as the platform counts it (code points).
export function instructionLength(text: string): number {
  return [...text].length;
}

/// The core only accepts PNG, JPEG and WebP sources.
export function isEditableImagePath(path: string): boolean {
  return /\.(png|jpe?g|webp)$/i.test(path);
}
