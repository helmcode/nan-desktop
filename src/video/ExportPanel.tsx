// R-V1: "Export MP4". The core zips the project, uploads it to the
// platform's render service with the session JWT (the renderer never sees
// it), and later streams the finished MP4 into the project's exports
// folder. Here: the remaining monthly export time in plain words, the
// progress, cancel, every failure in plain words, and what to do with the
// file (open, show in folder, save a copy).

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { IconDownload, IconExternal, IconFolder, IconStop } from "../icons";
import {
  exportCancel,
  exportDownload,
  exportErrorOf,
  exportOpen,
  exportQuota,
  exportReveal,
  exportSaveAs,
  exportStart,
  exportStatus,
  formatTime,
  onDownloadProgress,
  type ExportError,
  type RenderQuota,
  type RenderStatus,
  type VideoExport,
  type VideoProject,
} from "./api";
import { exportErrorMessage, quotaLine, rememberRender, rememberedRender, shortDate } from "./logic";

/// How often a render's status is asked for.
export const POLL_MS = 2000;

type Phase =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "rendering"; renderId: string; status: RenderStatus | null }
  | { kind: "canceling"; renderId: string }
  | { kind: "downloading"; renderId: string; pct: number | null }
  | { kind: "done"; file: VideoExport }
  | { kind: "error"; error: ExportError };

export function ExportPanel({
  profileId,
  project,
  blocked,
  onExported,
}: {
  profileId: string;
  project: VideoProject;
  /// The check found errors: exporting would fail (and cost time).
  blocked: boolean;
  /// A new MP4 landed in the project (refresh its exports list).
  onExported: () => void;
}) {
  const { t, locale } = useI18n();
  const [quality, setQuality] = useState<"standard" | "draft">("standard");
  const [quota, setQuota] = useState<RenderQuota | null | "failed">(null);
  const [phase, setPhase] = useState<Phase>(() => {
    const resumed = rememberedRender(project.id);
    return resumed ? { kind: "rendering", renderId: resumed, status: null } : { kind: "idle" };
  });
  const [fileError, setFileError] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refreshQuota = useCallback(() => {
    exportQuota(profileId)
      .then((q) => alive.current && setQuota(q))
      .catch(() => alive.current && setQuota("failed"));
  }, [profileId]);
  useEffect(refreshQuota, [refreshQuota]);

  const fail = useCallback(
    (error: ExportError) => {
      rememberRender(project.id, null);
      setPhase({ kind: "error", error });
      refreshQuota();
    },
    [project.id, refreshQuota],
  );

  const download = useCallback(
    (renderId: string) => {
      setPhase({ kind: "downloading", renderId, pct: null });
      exportDownload(profileId, project.id, renderId)
        .then((file) => {
          if (!alive.current) return;
          rememberRender(project.id, null);
          setPhase({ kind: "done", file });
          onExported();
          refreshQuota();
        })
        .catch((err: unknown) => alive.current && fail(exportErrorOf(err)));
    },
    [profileId, project.id, onExported, refreshQuota, fail],
  );

  // Poll the render while it runs.
  const renderingId = phase.kind === "rendering" ? phase.renderId : null;
  useEffect(() => {
    if (!renderingId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = () => {
      exportStatus(profileId, renderingId)
        .then((status) => {
          if (stopped || !alive.current) return;
          if (status.status === "done" && status.ready) return download(renderingId);
          if (status.status === "failed") return fail({ kind: status.error ?? "render_failed" });
          if (status.status === "canceled") return fail({ kind: "canceled" });
          setPhase({ kind: "rendering", renderId: renderingId, status });
          timer = setTimeout(tick, POLL_MS);
        })
        .catch((err: unknown) => {
          if (stopped || !alive.current) return;
          const error = exportErrorOf(err);
          // A dropped connection keeps trying; anything else ends the export.
          if (error.kind === "offline") timer = setTimeout(tick, POLL_MS * 2);
          else fail(error);
        });
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [renderingId, profileId, download, fail]);

  // Download progress events for this project.
  useEffect(() => {
    const unlisten = onDownloadProgress((p) => {
      if (p.project_id !== project.id) return;
      setPhase((prev) =>
        prev.kind === "downloading"
          ? { ...prev, pct: p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : null }
          : prev,
      );
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [project.id]);

  const start = () => {
    setFileError(false);
    setPhase({ kind: "uploading" });
    exportStart(profileId, project.id, quality)
      .then((started) => {
        if (!alive.current) return;
        rememberRender(project.id, started.render_id);
        setPhase({ kind: "rendering", renderId: started.render_id, status: null });
        refreshQuota();
      })
      .catch((err: unknown) => alive.current && fail(exportErrorOf(err)));
  };

  const cancel = (renderId: string) => {
    setPhase({ kind: "canceling", renderId });
    exportCancel(profileId, renderId)
      .catch(() => undefined)
      .finally(() => {
        if (!alive.current) return;
        rememberRender(project.id, null);
        setPhase({ kind: "idle" });
        refreshQuota();
      });
  };

  const fileAction = (action: Promise<unknown>) => {
    setFileError(false);
    action.catch(() => alive.current && setFileError(true));
  };

  const busy = phase.kind === "uploading" || phase.kind === "rendering" || phase.kind === "canceling" || phase.kind === "downloading";
  const progress =
    phase.kind === "rendering" && phase.status?.status === "rendering"
      ? Math.round(phase.status.progress * 100)
      : phase.kind === "downloading"
        ? phase.pct
        : null;
  const statusText =
    phase.kind === "uploading"
      ? t.video.uploading
      : phase.kind === "canceling"
        ? t.video.canceling
        : phase.kind === "downloading"
          ? t.video.downloading(phase.pct)
          : phase.kind === "rendering"
            ? phase.status?.status === "rendering"
              ? t.video.rendering(Math.round(phase.status.progress * 100))
              : t.video.queued
            : null;
  const exportsList = project.exports;
  const renewal = quota && quota !== "failed" ? shortDate(quota.period_end, locale) : null;

  return (
    <section className="video-section video-export" aria-labelledby="video-export-title">
      <h2 id="video-export-title" className="video-section-title">
        {t.video.sectionExport}
      </h2>
      <p className="video-hint">{t.video.exportLede}</p>
      <p className="video-quota" role="status">
        {quota === null ? " " : quota === "failed" ? t.video.quotaUnknown : quotaLine(t, quota.remaining_seconds)}
        {renewal && <span className="video-quota-renew">{t.video.quotaRenews(renewal)}</span>}
      </p>
      <div className="video-export-row">
        <label className="video-field-inline">
          <span>{t.video.quality}</span>
          <select
            value={quality}
            disabled={busy}
            onChange={(e) => setQuality(e.currentTarget.value === "draft" ? "draft" : "standard")}
          >
            <option value="standard">{t.video.qualityStandard}</option>
            <option value="draft">{t.video.qualityDraft}</option>
          </select>
        </label>
        <button type="button" className="btn btn-primary btn-sm" onClick={start} disabled={busy || blocked}>
          <IconDownload size={14} />
          {t.video.exportButton}
        </button>
      </div>
      <p className="video-hint">{t.video.exportCost(formatTime(Math.ceil(project.duration)))}</p>
      {statusText && (
        <div className="video-progress" role="status" aria-live="polite">
          <span>{statusText}</span>
          <div
            className={`video-progress-bar${progress === null ? " indeterminate" : ""}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
            aria-label={statusText}
          >
            <span style={{ width: `${progress ?? 35}%` }} />
          </div>
          {phase.kind === "rendering" && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => cancel(phase.renderId)}>
              <IconStop size={13} />
              {t.video.cancel}
            </button>
          )}
        </div>
      )}
      {phase.kind === "error" && (
        <p className="inline-error" role="alert">
          {exportErrorMessage(t, locale, phase.error)}
        </p>
      )}
      {phase.kind === "done" && (
        <p className="video-ok" role="status">
          {t.video.exportDone}
        </p>
      )}
      {exportsList.length > 0 && (
        <div className="video-exports">
          <h3 className="video-subtitle">{t.video.exportsTitle}</h3>
          <ul>
            {[...exportsList].reverse().map((file) => (
              <li key={file.name}>
                <span className="video-export-name" title={file.name}>
                  {file.name}
                </span>
                <span className="video-export-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => fileAction(exportOpen(profileId, project.id, file.name))}
                  >
                    <IconExternal size={13} />
                    {t.video.openMp4}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => fileAction(exportReveal(profileId, project.id, file.name))}
                  >
                    <IconFolder size={13} />
                    {t.video.showInFolder}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => fileAction(exportSaveAs(profileId, project.id, file.name))}
                  >
                    {t.video.saveCopy}
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {fileError && (
            <p className="inline-error" role="alert">
              {t.video.openFailed}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
