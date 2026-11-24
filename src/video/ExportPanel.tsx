// R-V1: "Export MP4". The core zips the project, uploads it to the
// platform's render service with the session JWT (the renderer never sees
// it), and later streams the finished MP4 into the project's exports
// folder. Here: the remaining monthly export time in plain words, the
// formats to export (one or several: they render one after another, see
// exportQueue.ts), each format's progress, cancel (one, or the rest),
// every failure in plain words, and what to do with each file (open, show
// in folder, save a copy).

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "../i18n";
import { IconDownload, IconExternal, IconFolder, IconStop } from "../icons";
import {
  ASPECTS,
  exportOpen,
  exportQuota,
  exportReveal,
  exportSaveAs,
  formatDuration,
  type Aspect,
  type RenderQuota,
  type VideoExport,
  type VideoProject,
} from "./api";
import { openExternal } from "../Markdown";
import { exportQueueFor, isSettled, type Quality, type QueueItem } from "./exportQueue";
import { exportCharge, exportErrorMessage, queueCharge, quotaLine, rememberedAspect, rememberedRender, shortDate } from "./logic";

export { POLL_MS } from "./exportQueue";

/// Where a member subscribes or changes plan, per tenant.
export const PLANS_URL: Record<string, string> = {
  nan: "https://cloud.nan.builders/membership",
  helmcode: "https://console.helmcode.com/billing",
};

/// The formats to queue, the project's own first.
export function exportOrder(selected: Aspect[], own: Aspect): Aspect[] {
  return [own, ...ASPECTS.filter((a) => a !== own)].filter((a) => selected.includes(a));
}

/// Which stage of the queue an item is in, for refreshing the quota when a
/// render starts or ends (the server charges at admission, refunds on a
/// failure or a cancel).
function stage(item: QueueItem): string {
  switch (item.phase.kind) {
    case "pending":
    case "waiting":
    case "uploading":
      return "a";
    case "rendering":
    case "canceling":
    case "downloading":
      return "b";
    default:
      return item.phase.kind;
  }
}

export function ExportPanel({
  profileId,
  project,
  blocked,
  onExported,
  onSignIn,
}: {
  profileId: string;
  project: VideoProject;
  /// The check found errors: exporting would fail (and cost time).
  blocked: boolean;
  /// A new MP4 landed in the project (refresh its exports list).
  onExported: () => void;
  /// The session expired: sign in again.
  onSignIn?: () => void;
}) {
  const { t, locale } = useI18n();
  const own = project.meta.aspect;
  const [quality, setQuality] = useState<Quality>("standard");
  const [selected, setSelected] = useState<Aspect[]>([own]);
  const [quota, setQuota] = useState<RenderQuota | null | "failed">(null);
  const [fileError, setFileError] = useState(false);
  const queue = useMemo(() => exportQueueFor(profileId, project.id), [profileId, project.id]);
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The format switch in the editor changes the preselected one.
  useEffect(() => setSelected([own]), [own]);

  // A render remembered from before a reopen picks its progress back up.
  useEffect(() => {
    const resumed = rememberedRender(project.id);
    if (resumed) queue.resume(resumed, rememberedAspect(project.id) ?? own);
    // Once per project (the queue): `own` changing later must not resume
    // again, and `project.id` is already part of `queue`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on opening a project only
    // Only on opening the project.
  }, [queue]);

  const refreshQuota = useCallback(() => {
    exportQuota(profileId)
      .then((q) => alive.current && setQuota(q))
      .catch(() => alive.current && setQuota("failed"));
  }, [profileId]);
  const stages = items.map((item) => `${item.key}:${stage(item)}`).join(",");
  useEffect(refreshQuota, [refreshQuota, stages]);

  // Each MP4 that lands refreshes the project's exports (once).
  const seen = useRef<Set<number> | null>(null);
  useEffect(() => {
    const done = items.filter((item) => item.phase.kind === "done").map((item) => item.key);
    if (seen.current === null) {
      seen.current = new Set(done);
      return;
    }
    let fresh = false;
    for (const key of done) {
      if (!seen.current.has(key)) {
        seen.current.add(key);
        fresh = true;
      }
    }
    if (fresh) onExported();
  }, [items, onExported]);

  // Waiting for a slot: the countdown ticks every second.
  const waiting = items.some((item) => item.phase.kind === "waiting");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!waiting) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting]);

  const busy = queue.busy;
  const order = exportOrder(selected, own);
  const each = exportCharge(project.duration);
  const charge = queueCharge(project.duration, order.length);
  const short = quota !== null && quota !== "failed" && charge > quota.remaining_seconds;
  const renewal = quota && quota !== "failed" ? shortDate(quota.period_end, locale) : null;
  const many = items.length > 1;
  // "Cancel the rest": the formats not started yet, while another one runs
  // or several wait.
  const rest = items.filter((item) => item.phase.kind === "pending" || item.phase.kind === "waiting");
  const unsettled = items.filter((item) => !isSettled(item));

  const toggle = (aspect: Aspect) =>
    setSelected((prev) => (prev.includes(aspect) ? prev.filter((a) => a !== aspect) : [...prev, aspect]));

  const start = () => {
    setFileError(false);
    queue.enqueue(order, quality);
  };

  const fileAction = (action: Promise<unknown>) => {
    setFileError(false);
    action.catch(() => alive.current && setFileError(true));
  };

  const fileButtons = (file: VideoExport) => (
    <span className="video-export-actions">
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileAction(exportOpen(profileId, project.id, file.name))}>
        <IconExternal size={13} />
        {t.video.openMp4}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileAction(exportReveal(profileId, project.id, file.name))}>
        <IconFolder size={13} />
        {t.video.showInFolder}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileAction(exportSaveAs(profileId, project.id, file.name))}>
        {t.video.saveCopy}
      </button>
    </span>
  );

  const row = (item: QueueItem) => {
    const { phase } = item;
    const name = t.video.aspectNames[item.aspect];
    const statusText =
      phase.kind === "pending"
        ? t.video.queuePending
        : phase.kind === "waiting"
          ? t.video.queueWaiting(phase.reason, formatDuration(Math.max(1, Math.ceil((phase.until - now) / 1000))))
          : phase.kind === "uploading"
            ? phase.pct === null
              ? t.video.uploading
              : phase.pct >= 100
                ? t.video.preparing
                : t.video.uploadingPct(phase.pct)
            : phase.kind === "canceling"
              ? t.video.canceling
              : phase.kind === "downloading"
                ? t.video.downloading(phase.pct)
                : phase.kind === "rendering"
                  ? phase.progress !== null
                    ? t.video.rendering(Math.round(phase.progress * 100))
                    : t.video.queued
                  : null;
    const progress =
      phase.kind === "rendering" && phase.progress !== null
        ? Math.round(phase.progress * 100)
        : phase.kind === "downloading" || phase.kind === "uploading"
          ? phase.pct
          : null;
    const cancelable =
      phase.kind === "pending" ||
      phase.kind === "waiting" ||
      phase.kind === "rendering" ||
      (phase.kind === "uploading" && (phase.pct ?? 0) < 100);
    return (
      <li key={item.key} className={`video-queue-item video-queue-${phase.kind}`}>
        {many && <span className="video-queue-format">{name}</span>}
        {statusText && (
          <div className="video-progress" role="status" aria-live="polite">
            <span>{statusText}</span>
            {phase.kind !== "pending" && phase.kind !== "waiting" && (
              <div
                className={`video-progress-bar${progress === null ? " indeterminate" : ""}`}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress ?? undefined}
                aria-label={many ? `${name}: ${statusText}` : statusText}
              >
                <span style={{ width: `${progress ?? 35}%` }} />
              </div>
            )}
            {cancelable && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={many ? t.video.cancelFormat(name) : undefined}
                onClick={() => queue.cancel(item.key)}
              >
                <IconStop size={13} />
                {t.video.cancel}
              </button>
            )}
          </div>
        )}
        {phase.kind === "uploading" && phase.slow && (
          <p className="video-warn" role="alert">
            {t.video.slowUpload}
          </p>
        )}
        {phase.kind === "error" && (
          <div className="video-error">
            <p className="inline-error" role="alert">
              {exportErrorMessage(t, locale, phase.error)}
            </p>
            {(phase.error.kind === "subscription_required" || phase.error.kind === "quota_exhausted") && PLANS_URL[profileId] && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => openExternal(PLANS_URL[profileId])}>
                <IconExternal size={13} />
                {t.video.viewPlans}
              </button>
            )}
            {phase.error.kind === "no_session" && onSignIn && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onSignIn}>
                {t.video.signInAgain}
              </button>
            )}
          </div>
        )}
        {phase.kind === "canceled" && (
          <p className="video-hint" role="status">
            {t.video.exportCanceled}
          </p>
        )}
        {phase.kind === "skipped" && (
          <p className="video-hint" role="status">
            {t.video.queueSkipped}
          </p>
        )}
        {phase.kind === "done" && (
          <>
            <p className="video-ok" role="status">
              {t.video.exportDone}
            </p>
            {many && fileButtons(phase.file)}
          </>
        )}
      </li>
    );
  };

  return (
    <section className="video-section video-export" aria-labelledby="video-export-title">
      <h2 id="video-export-title" className="video-section-title" tabIndex={-1}>
        {t.video.sectionExport}
      </h2>
      <p className="video-hint">{t.video.exportLede}</p>
      <p className="video-quota" role="status">
        {quota === null ? " " : quota === "failed" ? t.video.quotaUnknown : quotaLine(t, quota.remaining_seconds)}
        {renewal && <span className="video-quota-renew">{t.video.quotaRenews(renewal)}</span>}
      </p>
      <fieldset className="video-export-formats" disabled={busy}>
        <legend className="video-field-label">{t.video.exportFormats}</legend>
        {[own, ...ASPECTS.filter((a) => a !== own)].map((aspect) => (
          <label key={aspect} className={`video-export-format${selected.includes(aspect) ? " active" : ""}`}>
            <input type="checkbox" checked={selected.includes(aspect)} onChange={() => toggle(aspect)} />
            <span className={`video-format-icon aspect-${aspect.replace(":", "x")}`} aria-hidden="true" />
            <span>{t.video.aspectNames[aspect]}</span>
          </label>
        ))}
      </fieldset>
      <div className="video-export-row">
        <label className="video-field-inline">
          <span>{t.video.quality}</span>
          <select value={quality} disabled={busy} onChange={(e) => setQuality(e.currentTarget.value === "draft" ? "draft" : "standard")}>
            <option value="standard">{t.video.qualityStandard}</option>
            <option value="draft">{t.video.qualityDraft}</option>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={start}
          disabled={busy || blocked || short || order.length === 0}
        >
          <IconDownload size={14} />
          {order.length > 1 ? t.video.exportButtonMany(order.length) : t.video.exportButton}
        </button>
      </div>
      {order.length === 0 ? (
        <p className="video-hint">{t.video.exportPickFormat}</p>
      ) : short && quota !== null && typeof quota === "object" ? (
        <div className="video-error">
          <p className="video-warn" role="status">
            {order.length > 1
              ? t.video.insufficientMany(formatDuration(charge), formatDuration(quota.remaining_seconds))
              : t.video.insufficient(formatDuration(charge), formatDuration(quota.remaining_seconds))}
          </p>
          {PLANS_URL[profileId] && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => openExternal(PLANS_URL[profileId])}>
              <IconExternal size={13} />
              {t.video.viewPlans}
            </button>
          )}
        </div>
      ) : (
        <p className="video-hint">
          {order.length > 1 ? t.video.exportCostMany(formatDuration(charge), formatDuration(each)) : t.video.exportCost(formatDuration(charge))}
        </p>
      )}
      {items.length > 0 && (
        <ul className="video-queue" aria-label={t.video.exportFormats}>
          {items.map(row)}
        </ul>
      )}
      {rest.length > 0 && unsettled.length > 1 && (
        <button type="button" className="btn btn-ghost btn-sm video-cancel-rest" onClick={() => queue.cancelRest()}>
          <IconStop size={13} />
          {t.video.cancelRest}
        </button>
      )}
      {project.exports.length > 0 && (
        <div className="video-exports">
          <h3 className="video-subtitle">{t.video.exportsTitle}</h3>
          <ul>
            {[...project.exports].reverse().map((file) => (
              <li key={file.name}>
                <span className="video-export-name" title={file.name}>
                  {file.name}
                </span>
                {fileButtons(file)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {fileError && (
        <p className="inline-error" role="alert">
          {t.video.openFailed}
        </p>
      )}
    </section>
  );
}
