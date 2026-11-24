// R-V1 (round 24): a video open on screen follows the assistant's changes.
//
// `create_video` / `edit_video` emit `video://changed` after every write
// (never for the editor's own saves, which already show their result).
// The open side panel and the editor count those changes for their
// project: a bump means "reload the project and the preview". A burst of
// edits (the assistant fixing three scenes in a row) is folded into ONE
// reload after the last one, so the player never reloads in a loop.

import { useEffect, useState } from "react";
import { onVideoChanged } from "./api";

/// Quiet time after the last change before reloading.
export const VIDEO_REFRESH_MS = 400;

/// How many times the assistant changed `projectId` since this mounted
/// (debounced). 0 until the first change.
export function useVideoRevision(projectId: string): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const unlisten = onVideoChanged((changed) => {
      if (!alive || changed.project_id !== projectId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (alive) setRevision((r) => r + 1);
      }, VIDEO_REFRESH_MS);
    });
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      void unlisten.then((fn) => fn()).catch(() => undefined);
    };
  }, [projectId]);
  return revision;
}
