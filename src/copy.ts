// User-facing copy (Spanish) and the small helpers that turn core error
// kinds into plain language. No technical terms reach the screen.

import type { GrantView } from "./types";

/// Friendly name + one-line description per locked profile (S2).
export const PROFILE_COPY: Record<string, { title: string; description: string }> = {
  nan: {
    title: "Comunidad NaN",
    description: "Para miembros de la comunidad de builders de NaN.",
  },
  helmcode: {
    title: "Helmcode para empresas",
    description: "Para equipos con una cuenta de empresa en Helmcode.",
  },
};

export function profileTitle(id: string, fallback: string): string {
  return PROFILE_COPY[id]?.title ?? fallback;
}

/// Sign-in (device flow) error kinds.
const SIGN_IN_ERRORS: Record<string, string> = {
  network: "No hemos podido conectar. Revisa tu conexión a internet y vuelve a intentarlo.",
  timeout: "El servicio ha tardado demasiado en responder. Vuelve a intentarlo.",
  rate_limited: "Demasiados intentos seguidos. Espera un momento y vuelve a intentarlo.",
  server: "El servicio de acceso ha tenido un problema. Vuelve a intentarlo.",
  protocol: "Algo ha fallado en este equipo. Vuelve a intentarlo.",
};

export function signInErrorLabel(kind: string): string {
  return SIGN_IN_ERRORS[kind] ?? "Algo ha fallado. Vuelve a intentarlo.";
}

/// Chat / voice error kinds (src-tauri/src/chat.rs ErrorKind).
const CHAT_ERRORS: Record<string, string> = {
  missing_key: "Tu sesión no está completa en este equipo. Vuelve a entrar.",
  unauthorized: "Tu sesión ha caducado. Vuelve a entrar.",
  rate_limited: "Has enviado muchas peticiones seguidas. Espera un momento y vuelve a intentarlo.",
  server: "El asistente ha tenido un problema al responder. Vuelve a intentarlo.",
  network: "No hemos podido conectar. Revisa tu conexión a internet y vuelve a intentarlo.",
  protocol: "Algo ha fallado en este equipo. Vuelve a intentarlo.",
  decode: "No hemos podido reproducir el audio. Vuelve a intentarlo.",
};

export const CHAT_ERROR_KINDS = new Set(Object.keys(CHAT_ERRORS));

export function chatErrorLabel(kind: string): string {
  return CHAT_ERRORS[kind] ?? "Algo ha fallado. Vuelve a intentarlo.";
}

/// Image error kinds: on this surface 429 means the monthly image allowance
/// is used up.
export function imageErrorLabel(kind: string): string {
  if (kind === "rate_limited") {
    return "Has llegado al límite de imágenes de este mes. Se renueva el mes que viene.";
  }
  if (kind === "decode") {
    return "No hemos podido abrir la imagen generada. Vuelve a intentarlo.";
  }
  return chatErrorLabel(kind);
}

/// Command errors arrive either as a classified kind or a free-form message
/// (never shown raw: free-form text is technical).
export function commandErrorLabel(err: unknown): string {
  const text = String(err);
  return CHAT_ERROR_KINDS.has(text) ? chatErrorLabel(text) : "Algo ha fallado. Vuelve a intentarlo.";
}

/// Folder-grant rejections ({kind, message} from the tools core).
export function grantErrorLabel(err: unknown): string {
  const kind =
    typeof err === "object" && err !== null && "kind" in err
      ? String((err as { kind: unknown }).kind)
      : "";
  if (kind === "scope") {
    return "Esa carpeta no se puede usar: es demasiado amplia o contiene datos de la aplicación. Elige una carpeta más concreta, por ejemplo una dentro de Documentos.";
  }
  return "No se ha podido completar. Vuelve a intentarlo.";
}

/// The last path component, for display ("/Users/ana/Proyecto" → "Proyecto").
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function isComputerWide(grant: GrantView): boolean {
  return grant.scope === "computer_wide";
}

/// Must match src-tauri/src/tts.rs VOICES.
export const VOICES: Array<{ id: string; label: string; hint: string }> = [
  { id: "ef_dora", label: "Dora", hint: "Español · voz femenina" },
  { id: "em_alex", label: "Álex", hint: "Español · voz masculina" },
  { id: "af_heart", label: "Heart", hint: "Inglés · voz femenina" },
];
export const DEFAULT_VOICE = VOICES[0].id;
export const VOICE_STORAGE_KEY = "nan-desktop-tts-voice";

export function storedVoice(): string {
  const stored = window.localStorage.getItem(VOICE_STORAGE_KEY);
  return VOICES.some((v) => v.id === stored) ? (stored as string) : DEFAULT_VOICE;
}

/// Must match src-tauri/src/images.rs bounds; labels are shapes, not pixels.
export const IMAGE_SIZES: Array<{ id: string; label: string }> = [
  { id: "1024x1024", label: "Cuadrada" },
  { id: "1280x768", label: "Horizontal" },
  { id: "768x1280", label: "Vertical" },
  { id: "1152x896", label: "Horizontal 4:3" },
  { id: "512x512", label: "Cuadrada pequeña" },
];
export const DEFAULT_IMAGE_SIZE = IMAGE_SIZES[0].id;

/// The host of a web URL, for citation chips.
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
