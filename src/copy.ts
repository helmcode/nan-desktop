// Helpers that turn core error kinds and ids into localized plain language.
// All copy comes from the i18n strings; nothing technical reaches the screen.

import type { Strings } from "./i18n/en";
import type { GrantView } from "./types";

export function profileTitle(t: Strings, id: string, fallback: string): string {
  const entry = (t.profiles as Record<string, { title: string } | undefined>)[id];
  return entry?.title ?? fallback;
}

export function profileDescription(t: Strings, id: string): string {
  const entry = (t.profiles as Record<string, { description: string } | undefined>)[id];
  return entry?.description ?? "";
}

export function signInErrorLabel(t: Strings, kind: string): string {
  return t.signInErrors[kind] ?? t.app.genericError;
}

export function chatErrorLabel(t: Strings, kind: string): string {
  return t.chatErrors[kind] ?? t.app.genericError;
}

/// Image errors: on this surface 429 means the monthly allowance is used up;
/// tenant-specific kinds (not_available, forbidden) get an actionable line.
export function imageErrorLabel(t: Strings, kind: string): string {
  return t.imageErrors[kind] ?? chatErrorLabel(t, kind);
}

/// Image EDIT errors (local validation + the platform's edit statuses);
/// anything else falls back to the image/chat copy.
export function editErrorLabel(t: Strings, kind: string): string {
  return t.editErrors[kind] ?? imageErrorLabel(t, kind);
}

/// Command errors arrive either as a classified kind or a free-form message
/// (never shown raw: free-form text is technical).
export function commandErrorLabel(t: Strings, err: unknown): string {
  const text = String(err);
  return t.chatErrors[text] ?? t.app.genericError;
}

/// Folder-grant rejection kind ({kind, message} from the tools core).
export type GrantErrorKind = "" | "scope" | "generic";

export function grantErrorKind(err: unknown): GrantErrorKind {
  const kind =
    typeof err === "object" && err !== null && "kind" in err
      ? String((err as { kind: unknown }).kind)
      : "";
  return kind === "scope" ? "scope" : "generic";
}

export function grantErrorLabel(t: Strings, kind: GrantErrorKind): string {
  return kind === "" ? "" : t.grantErrors[kind];
}

/// The last path component, for display ("/Users/ana/Proyecto" -> "Proyecto").
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function isComputerWide(grant: GrantView): boolean {
  return grant.scope === "computer_wide";
}

/// Must match src-tauri/src/tts.rs VOICES. Hints are localized via t.voices.
export const VOICES: Array<{ id: string; label: string }> = [
  { id: "ef_dora", label: "Dora" },
  { id: "em_alex", label: "Álex" },
  { id: "af_heart", label: "Heart" },
];
export const DEFAULT_VOICE = VOICES[0].id;
// Storage key kept from round 1 so existing voice choices survive.
export const VOICE_STORAGE_KEY = "nan-desktop-tts-voice";

export function storedVoice(): string {
  const stored = window.localStorage.getItem(VOICE_STORAGE_KEY);
  return VOICES.some((v) => v.id === stored) ? (stored as string) : DEFAULT_VOICE;
}

/// Must match src-tauri/src/images.rs bounds; labels are shapes (t.imageSizes).
export const IMAGE_SIZES: string[] = ["1024x1024", "1280x768", "768x1280", "1152x896", "512x512"];
export const DEFAULT_IMAGE_SIZE = IMAGE_SIZES[0];

/// The host of a web URL, for citation chips.
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/// The avatar initial for an account name ("Comunidad NaN" -> "C").
export function accountInitial(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toLocaleUpperCase() : "?";
}
