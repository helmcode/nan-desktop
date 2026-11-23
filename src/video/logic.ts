// R-V1: the editor's pure logic (scene timing and order, the chat prompt
// for "Ask for a change", quota and export error copy). Kept out of the
// components so it is tested directly.

import type { Strings } from "../i18n";
import { formatTime, type ExportError, type VideoScene } from "./api";

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

/// The composer text for "Ask for a change in this scene".
export function changeRequest(
  t: Strings,
  video: { id: string; title: string },
  scenes: VideoScene[],
  index: number,
  currentTime: number | null,
): string {
  const windows = sceneWindows(scenes);
  const w = windows[index];
  if (!w) return "";
  const title = w.scene.title || t.video.sceneUntitled(index + 1);
  const at = currentTime !== null && currentTime >= w.start && currentTime < w.end ? formatTime(currentTime) : null;
  return t.video.askChangeText(video.title, video.id, title, formatTime(w.start), formatTime(w.end), at);
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

function waitText(seconds: number | undefined, locale: string): string | null {
  if (!seconds || seconds <= 0) return null;
  if (seconds < 90) return locale === "en" ? `${seconds} s` : `${seconds} s`;
  return `${Math.ceil(seconds / 60)} min`;
}

/// The plain-language message for a failed export step.
export function exportErrorMessage(t: Strings, locale: string, err: ExportError): string {
  const e = t.video.errors;
  switch (err.kind) {
    case "quota_exhausted":
      return e.quota_exhausted(formatTime(err.remaining_seconds ?? 0), shortDate(err.period_end, locale));
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
      return e[err.kind];
    case "rate_limited":
      return e.rate_limited(waitText(err.retry_after, locale));
    default:
      return e.generic;
  }
}

/// Render ids of exports in flight, per project, so reopening the editor
/// (or the app) picks the progress back up. A per-viewer convenience:
/// storage may be unavailable, and then nothing is remembered.
const RENDER_KEY = (projectId: string) => `video.render.${projectId}`;

export function rememberRender(projectId: string, renderId: string | null): void {
  try {
    if (renderId) localStorage.setItem(RENDER_KEY(projectId), renderId);
    else localStorage.removeItem(RENDER_KEY(projectId));
  } catch {
    /* storage unavailable: nothing to remember */
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
