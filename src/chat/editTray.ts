// Image edit tray (composer edit mode): the 1..3 source images an edit
// starts from. Pure helpers so the rules are unit-tested apart from the
// App wiring. The core re-validates everything (count, size, format,
// ownership); these only keep the UI honest.

/// Most source images per edit (platform contract, mirrored by the core).
export const MAX_EDIT_IMAGES = 3;

/// Longest instruction the platform accepts, in characters.
export const MAX_EDIT_INSTRUCTION = 2000;

export interface EditSource {
  /// Absolute path of an app-owned image (a chat image or a staged pick).
  path: string;
  /// What the thumbnail shows as alt text (prompt or picked file name).
  label: string;
  /// The chat message the image came from; null for picked files.
  messageId: number | null;
}

/// Add a source: ignored when it is already in the tray or the tray is full.
export function addSource(list: readonly EditSource[], source: EditSource): EditSource[] {
  if (list.length >= MAX_EDIT_IMAGES || list.some((item) => item.path === source.path)) return [...list];
  return [...list, source];
}

export function removeSource(list: readonly EditSource[], path: string): EditSource[] {
  return list.filter((item) => item.path !== path);
}

/// The lineage parent of the edit: the first chat image in the tray.
export function parentMessageId(list: readonly EditSource[]): number | null {
  return list.find((item) => item.messageId !== null)?.messageId ?? null;
}

/// Submit is possible with 1..3 images, a non-blank instruction within the
/// cap, and nothing running.
export function canSubmitEdit(list: readonly EditSource[], instruction: string, busy: boolean): boolean {
  const text = instruction.trim();
  return (
    !busy &&
    list.length > 0 &&
    list.length <= MAX_EDIT_IMAGES &&
    text.length > 0 &&
    [...text].length <= MAX_EDIT_INSTRUCTION
  );
}
