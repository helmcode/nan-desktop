// R-V1 (round 24): "Export MP4" from the side panel. The same export as the
// editor (ExportPanel, the same per-project queue: a render started here
// shows in the editor too and the other way round), with the project and
// its automatic check loaded here. Lazy: the panel's chunk stays small.

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { videoGet, type VideoAskContext, type VideoProject } from "./api";
import { ExportPanel } from "./ExportPanel";
import { lintProject } from "./lint";

/// The id the side panel's "Export" button controls.
export const PREVIEW_EXPORT_ID = "preview-video-export";

export default function PreviewExport({
  profileId,
  projectId,
  revision,
  onSignIn,
  onFixLayout,
}: {
  profileId: string;
  projectId: string;
  /// Bumps when the assistant changed the video (reload it).
  revision: number;
  onSignIn?: () => void;
  /// The export's "Fix it in the chat" (once the automatic fix gave up).
  onFixLayout?: (text: string, context: VideoAskContext) => void;
}) {
  const t = useT();
  const [project, setProject] = useState<VideoProject | null | "failed">(null);
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const loaded = project !== null && project !== "failed";
  // Opened from the header: bring the section into view and put the
  // keyboard on its heading (once, when it first shows).
  useEffect(() => {
    if (!loaded) return;
    const heading = box.current?.querySelector<HTMLElement>("h2");
    heading?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    heading?.focus();
  }, [loaded]);

  const load = useCallback(
    (alive: () => boolean) => {
      videoGet(profileId, projectId)
        .then((next) => {
          if (!alive()) return;
          setProject(next);
          setBlocked(null);
          lintProject(next)
            .then((found) => alive() && setBlocked(found.some((p) => p.severity === "error")))
            .catch(() => alive() && setBlocked(false));
        })
        .catch(() => alive() && setProject("failed"));
    },
    [profileId, projectId],
  );

  useEffect(() => {
    let alive = true;
    load(() => alive);
    return () => {
      alive = false;
    };
  }, [load, revision]);

  // A new MP4: refresh the exports list.
  const onExported = useCallback(() => {
    videoGet(profileId, projectId)
      .then(setProject)
      .catch(() => undefined);
  }, [profileId, projectId]);

  if (project === null)
    return (
      <div id={PREVIEW_EXPORT_ID}>
        <p className="preview-note">{t.video.loading}</p>
      </div>
    );
  if (project === "failed")
    return (
      <div id={PREVIEW_EXPORT_ID}>
        <p className="preview-note">{t.video.editorFailed}</p>
      </div>
    );
  return (
    <div id={PREVIEW_EXPORT_ID} ref={box}>
      {blocked && (
        <p className="video-warn" role="status">
          {t.video.previewCheckFailed}
        </p>
      )}
      <ExportPanel profileId={profileId} project={project} blocked={blocked !== false} onExported={onExported} onSignIn={onSignIn} onFixLayout={onFixLayout} />
    </div>
  );
}
