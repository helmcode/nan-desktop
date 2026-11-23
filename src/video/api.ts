// R-V1: the renderer's side of the video commands. Every call names a
// project by its id; the core resolves it inside the signed-in user's
// library (src-tauri/src/video). The renderer never holds a filesystem
// path, a session token or a presigned URL.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Aspect = "16:9" | "9:16" | "1:1";

/// `video_preview`: the sandboxed document's URL and the canvas.
export interface VideoPreviewInfo {
  url: string;
  title: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  aspect: Aspect;
}

/// One project in the library list.
export interface VideoSummary {
  id: string;
  title: string;
  aspect: Aspect;
  width: number;
  height: number;
  duration: number;
  scenes: number;
  template: string | null;
  updated_ms: number;
  exports: number;
}

/// `video://changed`: the assistant created or changed a video.
export interface VideoChanged {
  conversation_id: number;
  project_id: string;
  title: string;
}

export const VIDEO_CHANGED_EVENT = "video://changed";

export function videoPreview(profileId: string, projectId: string): Promise<VideoPreviewInfo> {
  return invoke<VideoPreviewInfo>("video_preview", { profileId, projectId });
}

export function videoList(profileId: string): Promise<VideoSummary[]> {
  return invoke<VideoSummary[]>("video_list", { profileId });
}

export function onVideoChanged(handler: (payload: VideoChanged) => void): Promise<UnlistenFn> {
  return listen<VideoChanged>(VIDEO_CHANGED_EVENT, (event) => handler(event.payload));
}

/// `m:ss` for a number of seconds (`1:05`), `h:mm:ss` past an hour.
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ------------------------------------------------------------- editor --

export type VariableKind = "text" | "color" | "image";

export interface VideoVariable {
  id: string;
  type: VariableKind;
  label: string;
  value: string;
}

export interface VideoScene {
  id: string;
  title: string;
  duration: number;
}

export interface AudioTrack {
  file: string;
  volume: number;
  duration?: number;
}

export interface VideoMeta {
  format: number;
  hyperframes: string;
  title: string;
  aspect: Aspect;
  fps: number;
  template?: string;
  scenes: VideoScene[];
  variables: VideoVariable[];
  audio: { voice?: AudioTrack; music?: AudioTrack };
}

export interface VideoProject {
  id: string;
  meta: VideoMeta;
  duration: number;
  width: number;
  height: number;
  assets: { path: string; kind: "image" | "audio" | "video" | "font"; size: number }[];
  exports: VideoExport[];
  size: number;
  sources: { index: string; scenes: { id: string; html: string }[] };
}

export interface VideoExport {
  name: string;
  size: number;
}

export interface EditorPatch {
  title?: string;
  aspect?: Aspect;
  values?: Record<string, string>;
  scenes?: { id: string; duration: number }[];
  voice_volume?: number;
  music_volume?: number;
  remove_voice?: boolean;
  remove_music?: boolean;
}

export type AssetSlot = { kind: "image"; variable: string } | { kind: "music" } | { kind: "voice" };

export function videoGet(profileId: string, projectId: string): Promise<VideoProject> {
  return invoke<VideoProject>("video_get", { profileId, projectId });
}

export function videoUpdate(profileId: string, projectId: string, patch: EditorPatch): Promise<VideoProject> {
  return invoke<VideoProject>("video_update", { profileId, projectId, patch });
}

export function videoPickAsset(profileId: string, projectId: string, slot: AssetSlot): Promise<VideoProject | null> {
  return invoke<VideoProject | null>("video_pick_asset", { profileId, projectId, slot });
}

export function videoDelete(profileId: string, projectId: string): Promise<void> {
  return invoke<void>("video_delete", { profileId, projectId });
}

// ---------------------------------------------------------- templates --

export interface VideoTemplate {
  id: string;
  title: string;
  description: string;
  category: string;
  aspect: Aspect;
  duration: number;
  scenes: number;
  attribution: string | null;
}

export function videoTemplates(locale: string): Promise<VideoTemplate[]> {
  return invoke<VideoTemplate[]>("video_templates", { locale });
}

export function videoTemplatePreview(templateId: string, aspect: Aspect | null, locale: string): Promise<VideoPreviewInfo> {
  return invoke<VideoPreviewInfo>("video_template_preview", { templateId, aspect, locale });
}

export function videoCreateFromTemplate(
  profileId: string,
  templateId: string,
  aspect: Aspect | null,
  locale: string,
): Promise<string> {
  return invoke<string>("video_create_from_template", { profileId, templateId, aspect, locale });
}

/// The poster image the app bundles for a template (public/video-templates).
export function templatePoster(id: string): string {
  return `/video-templates/${id}.webp`;
}

// ------------------------------------------------------------- export --

export interface ExportError {
  kind: string;
  retry_after?: number;
  remaining_seconds?: number;
  period_end?: string;
}

export interface RenderStarted {
  render_id: string;
  charge_seconds: number;
}

export interface RenderStatus {
  status: "queued" | "rendering" | "done" | "failed" | "canceled";
  progress: number;
  error: "render_failed" | "timeout" | "invalid_project" | null;
  ready: boolean;
  size_bytes: number | null;
  expires_at: string | null;
}

export interface RenderQuota {
  included_seconds: number;
  used_seconds: number;
  remaining_seconds: number;
  period_end: string | null;
}

export interface DownloadProgress {
  project_id: string;
  received: number;
  total: number | null;
}

export const DOWNLOAD_EVENT = "video://download";

export function exportStart(profileId: string, projectId: string, quality: "standard" | "draft"): Promise<RenderStarted> {
  return invoke<RenderStarted>("video_export_start", { profileId, projectId, quality });
}

export function exportStatus(profileId: string, renderId: string): Promise<RenderStatus> {
  return invoke<RenderStatus>("video_export_status", { profileId, renderId });
}

export function exportCancel(profileId: string, renderId: string): Promise<void> {
  return invoke<void>("video_export_cancel", { profileId, renderId });
}

export function exportQuota(profileId: string): Promise<RenderQuota> {
  return invoke<RenderQuota>("video_export_quota", { profileId });
}

export function exportDownload(profileId: string, projectId: string, renderId: string): Promise<VideoExport> {
  return invoke<VideoExport>("video_export_download", { profileId, projectId, renderId });
}

export function exportOpen(profileId: string, projectId: string, name: string): Promise<void> {
  return invoke<void>("video_export_open", { profileId, projectId, name });
}

export function exportReveal(profileId: string, projectId: string, name: string): Promise<void> {
  return invoke<void>("video_export_reveal", { profileId, projectId, name });
}

export function exportSaveAs(profileId: string, projectId: string, name: string): Promise<boolean> {
  return invoke<boolean>("video_export_save_as", { profileId, projectId, name });
}

export function onDownloadProgress(handler: (payload: DownloadProgress) => void): Promise<UnlistenFn> {
  return listen<DownloadProgress>(DOWNLOAD_EVENT, (event) => handler(event.payload));
}

/// The typed error of a failed export call (anything else is `io`).
export function exportErrorOf(err: unknown): ExportError {
  if (err && typeof err === "object" && typeof (err as { kind?: unknown }).kind === "string") {
    return err as ExportError;
  }
  return { kind: "io" };
}
