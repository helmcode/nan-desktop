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
