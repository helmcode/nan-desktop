// R-V1 (round 24): "Export MP4" from the side panel. The same export as the
// editor (ExportPanel, the same per-project queue: a render started here
// shows in the editor too and the other way round), with the project and
// its automatic check loaded here. Lazy: the panel's chunk stays small.

import { useCallback, useEffect, useState } from "react";
import { useT } from "../i18n";
import { videoGet, type VideoProject } from "./api";
import { ExportPanel } from "./ExportPanel";
import { lintProject } from "./lint";

export default function PreviewExport({
  profileId,
  projectId,
  revision,
  onSignIn,
}: {
  profileId: string;
  projectId: string;
  /// Bumps when the assistant changed the video (reload it).
  revision: number;
  onSignIn?: () => void;
}) {
  const t = useT();
  const [project, setProject] = useState<VideoProject | null | "failed">(null);
  const [blocked, setBlocked] = useState<boolean | null>(null);

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

  if (project === null) return <p className="preview-note">{t.video.loading}</p>;
  if (project === "failed") return <p className="preview-note">{t.video.editorFailed}</p>;
  return (
    <>
      {blocked && (
        <p className="video-warn" role="status">
          {t.video.previewCheckFailed}
        </p>
      )}
      <ExportPanel profileId={profileId} project={project} blocked={blocked !== false} onExported={onExported} onSignIn={onSignIn} />
    </>
  );
}
