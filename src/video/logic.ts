// R-V1: the editor's pure logic (scene timing and order, the chat prompt
// for "Ask for a change", quota and export error copy). Kept out of the
// components so it is tested directly.

import type { Strings } from "../i18n";
import { ASPECTS, formatDuration, formatTime, type Aspect, type ExportError, type VideoAskContext, type VideoScene } from "./api";

export interface SceneWindow {
  scene: VideoScene;
  start: number;
  end: number;
}

/// Each scene's [start, end) in the film, in order.
export function sceneWindows(scenes: VideoScene[]): SceneWindow[] {
  let at = 0;
  return scenes.map((scene) => {
    const window = { scene, start: at, end: at + scene.duration };
    at += scene.duration;
    return window;
  });
}

/// The scene showing at `time` (the last one at or past the end).
export function sceneAt(scenes: VideoScene[], time: number): number {
  const windows = sceneWindows(scenes);
  const index = windows.findIndex((w) => time >= w.start && time < w.end);
  return index >= 0 ? index : Math.max(0, windows.length - 1);
}

/// The scene list with one scene moved by `delta` places (clamped).
export function moveScene(scenes: VideoScene[], index: number, delta: number): VideoScene[] {
  const target = Math.min(scenes.length - 1, Math.max(0, index + delta));
  if (target === index || index < 0 || index >= scenes.length) return scenes;
  const next = [...scenes];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

export const MIN_SCENE_S = 0.5;
export const MAX_SCENE_S = 120;

/// A typed-in duration, clamped to the scene limits; `null` when not a number.
export function parseDuration(raw: string): number | null {
  const value = Number(raw.replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.min(MAX_SCENE_S, Math.max(MIN_SCENE_S, value)) * 100) / 100;
}

/// "Ask for a change in this scene": the short request the composer shows
/// (scene name and window, in the user's words) and the technical context
/// attached to the message for the model only.
export function changeRequest(
  t: Strings,
  video: { id: string; title: string },
  scenes: VideoScene[],
  index: number,
  currentTime: number | null,
): { text: string; context: VideoAskContext } | null {
  const windows = sceneWindows(scenes);
  const w = windows[index];
  if (!w) return null;
  const title = w.scene.title || t.video.sceneUntitled(index + 1);
  const at = currentTime !== null && currentTime >= w.start && currentTime < w.end ? currentTime : null;
  return {
    text: t.video.askChangeText(title, formatTime(w.start), formatTime(w.end)),
    context: {
      project_id: video.id,
      title: video.title,
      scene_id: w.scene.id,
      scene_title: title,
      from: Math.round(w.start * 1000) / 1000,
      to: Math.round(w.end * 1000) / 1000,
      ...(at !== null ? { at: Math.round(at * 1000) / 1000 } : {}),
    },
  };
}

/// Where a variable is used: the scenes whose file binds it
/// (`data-var-text`, `data-var-src` or `var(--id)`).
export function variableScenes(variableId: string, scenes: { id: string; html: string }[]): string[] {
  const escaped = variableId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const binding = new RegExp(`data-var-(?:text|src)=["']${escaped}["']|var\\(--${escaped}[,)\\s]`);
  return scenes.filter((scene) => binding.test(scene.html)).map((scene) => scene.id);
}

/// The variables grouped for the form: one group per scene (in scene
/// order) holding the fields only that scene uses, then "General" for the
/// ones used by several scenes or none (palette, logo...).
export function groupVariables<V extends { id: string }>(
  variables: V[],
  scenes: { id: string; title: string }[],
  sources: { id: string; html: string }[],
): { sceneId: string | null; title: string | null; variables: V[] }[] {
  const general: V[] = [];
  const byScene = new Map<string, V[]>();
  for (const variable of variables) {
    const used = variableScenes(variable.id, sources);
    if (used.length === 1) byScene.set(used[0], [...(byScene.get(used[0]) ?? []), variable]);
    else general.push(variable);
  }
  const groups: { sceneId: string | null; title: string | null; variables: V[] }[] = scenes
    .filter((scene) => byScene.has(scene.id))
    .map((scene) => ({ sceneId: scene.id, title: scene.title, variables: byScene.get(scene.id)! }));
  if (general.length > 0) groups.push({ sceneId: null, title: null, variables: general });
  return groups;
}

/// Seconds an export of `durationS` costs (the server charges whole seconds).
export function exportCharge(durationS: number): number {
  return Math.ceil(durationS);
}

/// Seconds a queue of `formats` exports of the same video costs (each
/// render is charged on its own).
export function queueCharge(durationS: number, formats: number): number {
  return exportCharge(durationS) * Math.max(0, formats);
}

/// A color typed by hand: `#rgb` or `#rrggbb` (any case, `#` optional) as
/// lowercase `#rrggbb`; `null` when it is not one.
export function normalizeHex(raw: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
  if (!match) return null;
  const hex = match[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex}`;
}

/// "You have N min of export time left this month" (whole minutes, never
/// rounded up; under a minute, seconds).
export function quotaLine(t: Strings, remainingSeconds: number): string {
  const seconds = Math.max(0, Math.floor(remainingSeconds));
  return seconds >= 60 || seconds === 0 ? t.video.quotaLeft(Math.floor(seconds / 60)) : t.video.quotaLeftShort(seconds);
}

/// A date for the copy, in the user's language (`period_end` is RFC 3339).
export function shortDate(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "es-ES", { day: "numeric", month: "long" }).format(date);
}

function waitText(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  return formatDuration(seconds < 90 ? seconds : Math.ceil(seconds / 60) * 60);
}

/// The plain-language message for a failed export step.
export function exportErrorMessage(t: Strings, locale: string, err: ExportError): string {
  const e = t.video.errors;
  switch (err.kind) {
    case "quota_exhausted":
      return e.quota_exhausted(formatDuration(err.remaining_seconds ?? 0), shortDate(err.period_end, locale));
    case "subscription_required":
    case "too_large":
    case "invalid_project":
    case "too_many_active":
    case "canceled":
    case "upload_failed":
    case "render_failed":
    case "timeout":
    case "not_found":
    case "no_session":
    case "offline":
    case "expired":
    case "busy":
    case "unavailable":
      return e[err.kind];
    case "rate_limited":
      return e.rate_limited(waitText(err.retry_after));
    default:
      return e.generic;
  }
}

/// The upload window the platform allows (its proxy read timeout).
export const UPLOAD_WINDOW_S = 600;

/// Whether an upload at its current pace will not finish in the window
/// (judged after a few seconds, with a 10% margin).
export function uploadTooSlow(sent: number, total: number, elapsedS: number): boolean {
  if (elapsedS < 5 || sent <= 0 || total <= 0 || sent >= total) return false;
  return (total / sent) * elapsedS > UPLOAD_WINDOW_S * 0.9;
}

/// Render ids of exports in flight, per project, so reopening the editor
/// (or the app) picks the progress back up. A per-viewer convenience:
/// storage may be unavailable, and then nothing is remembered.
const RENDER_KEY = (projectId: string) => `video.render.${projectId}`;

const ASPECT_KEY = (projectId: string) => `video.render.${projectId}.aspect`;

/// `aspect`: the format the render was asked in (so a resumed download
/// gets the right file name).
export function rememberRender(projectId: string, renderId: string | null, aspect?: Aspect): void {
  try {
    if (renderId) {
      localStorage.setItem(RENDER_KEY(projectId), renderId);
      if (aspect) localStorage.setItem(ASPECT_KEY(projectId), aspect);
      else localStorage.removeItem(ASPECT_KEY(projectId));
    } else {
      localStorage.removeItem(RENDER_KEY(projectId));
      localStorage.removeItem(ASPECT_KEY(projectId));
    }
  } catch {
    /* storage unavailable: nothing to remember */
  }
}

export function rememberedAspect(projectId: string): Aspect | null {
  try {
    const value = localStorage.getItem(ASPECT_KEY(projectId));
    return ASPECTS.find((a) => a === value) ?? null;
  } catch {
    return null;
  }
}

export function rememberedRender(projectId: string): string | null {
  try {
    const value = localStorage.getItem(RENDER_KEY(projectId));
    return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}
