// R-V1: "Export MP4". The core zips the project, uploads it to the
// platform's render service with the session JWT (the renderer never sees
// it), and later streams the finished MP4 into the project's exports
// folder. Here: the remaining monthly export time in plain words, the
// formats to export (one or several: they render one after another, see
// exportQueue.ts), each format's progress, cancel (one, or the rest),
// every failure in plain words, and what to do with each file (open, show
// in folder, save a copy).
//
// Round 25, the layout gate: before the renders start, every selected
// format is checked (layoutCheck.ts). The formats that show the video whole
// export right away; a format that would come out cut off is held, named,
// with "Fix with the assistant" (the automatic fix request, sent directly)
// and "Export anyway". A check that cannot run never holds anything.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "../i18n";
import { IconDownload, IconExternal, IconFolder, IconSparkles, IconStop } from "../icons";
import {
  ASPECTS,
  exportOpen,
  exportQuota,
  exportReveal,
  exportSaveAs,
  formatDuration,
  type Aspect,
  type RenderQuota,
  type VideoAskContext,
  type VideoExport,
  type VideoProject,
} from "./api";
import { brokenAspects, checkLayout, layoutProblems, type LayoutReport } from "./layoutCheck";
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

/// The layout gate: idle, checking the formats, or holding the ones that
/// would come out cut off.
type Gate =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "broken"; aspects: Aspect[]; report: LayoutReport; quality: Quality; othersExporting: boolean };

/// What the layout of a project depends on (not its exports list: a new
/// MP4 landing must not drop a verdict on screen).
export function layoutKey(project: VideoProject): string {
  return JSON.stringify([project.id, project.meta, project.sources, project.assets]);
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
  onFixLayout,
}: {
  profileId: string;
  project: VideoProject;
  /// The check found errors: exporting would fail (and cost time).
  blocked: boolean;
  /// A new MP4 landed in the project (refresh its exports list).
  onExported: () => void;
  /// The session expired: sign in again.
  onSignIn?: () => void;
  /// Send the assistant the request to fix formats that come out cut off.
  onFixLayout?: (text: string, context: VideoAskContext) => void;
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

  // The layout gate, and the verdicts for this version of the project.
  const [gate, setGate] = useState<Gate>({ kind: "idle" });
  const key = useMemo(() => layoutKey(project), [project]);
  const verdicts = useRef<{ key: string; report: LayoutReport }>({ key, report: {} });
  const fixButton = useRef<HTMLButtonElement | null>(null);
  const anywayButton = useRef<HTMLButtonElement | null>(null);
  // A changed video: an earlier verdict no longer applies.
  useEffect(() => {
    if (verdicts.current.key === key) return;
    verdicts.current = { key, report: {} };
    setGate({ kind: "idle" });
  }, [key]);
  // Held formats: the keyboard goes to the way out.
  useEffect(() => {
    if (gate.kind === "broken") (fixButton.current ?? anywayButton.current)?.focus();
  }, [gate]);

  // The format switch in the editor changes the preselected one.
  useEffect(() => setSelected([own]), [own]);

  // A render remembered from before a reopen picks its progress back up.
  useEffect(() => {
    const resumed = rememberedRender(project.id);
    if (resumed) queue.resume(resumed, rememberedAspect(project.id) ?? own);
    // Once per project (the queue): `own` changing later must not resume
    // again, and `project.id` is already part of `queue`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run on opening a project only
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
    const wanted = order;
    const chosen = quality;
    const atKey = key;
    const known = verdicts.current.key === atKey ? verdicts.current.report : {};
    const missing = wanted.filter((aspect) => !(aspect in known));
    setGate({ kind: "checking" });
    const checked: Promise<LayoutReport> = missing.length > 0 ? checkLayout(profileId, project.id, missing).catch(() => ({})) : Promise.resolve({});
    void checked.then((fresh) => {
      const report = { ...known, ...fresh };
      if (verdicts.current.key === atKey) verdicts.current = { key: atKey, report };
      const broken = brokenAspects(report, wanted);
      const fine = wanted.filter((aspect) => !broken.includes(aspect));
      // The formats that fit go now (also when the panel closed meanwhile:
      // the queue outlives it); the others wait for the user.
      if (fine.length > 0) queue.enqueue(fine, chosen);
      if (!alive.current) return;
      setGate(broken.length > 0 ? { kind: "broken", aspects: broken, report, quality: chosen, othersExporting: fine.length > 0 } : { kind: "idle" });
    });
  };

  const exportAnyway = () => {
    if (gate.kind !== "broken") return;
    setGate({ kind: "idle" });
    queue.enqueue(gate.aspects, gate.quality);
  };

  const fixLayout = () => {
    if (gate.kind !== "broken" || !onFixLayout) return;
    const formats = t.video.formatsPhrase(...gate.aspects.map((aspect) => t.video.aspectInline[aspect]));
    setGate({ kind: "idle" });
    onFixLayout(t.video.layoutFixText(formats), {
      project_id: project.id,
      title: project.meta.title,
      problems: layoutProblems(gate.report, gate.aspects),
    });
  };

  const sceneTitle = (id: string) => project.meta.scenes.find((scene) => scene.id === id)?.title || id;
  const checking = gate.kind === "checking";

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
          disabled={busy || checking || blocked || short || order.length === 0}
          aria-busy={checking || undefined}
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
      {checking && (
        <p className="video-hint" role="status">
          {t.video.layoutChecking}
        </p>
      )}
      {gate.kind === "broken" && (
        <div className="video-layout-gate">
          <p className="video-warn" role="alert">
            {t.video.layoutBroken(t.video.formatsPhrase(...gate.aspects.map((aspect) => t.video.aspectInline[aspect])))}
          </p>
          <ul className="video-layout-list">
            {gate.aspects.map((aspect) => {
              const issues = gate.report[aspect] ?? [];
              const scenes = [...new Set(issues.map((issue) => issue.scene))].map(sceneTitle).join(", ");
              return <li key={aspect}>{t.video.layoutFormatLine(t.video.aspectNames[aspect], issues.length, scenes)}</li>;
            })}
          </ul>
          {gate.othersExporting && <p className="video-hint">{t.video.layoutOthersExporting}</p>}
          <div className="video-export-actions">
            {onFixLayout && (
              <button type="button" ref={fixButton} className="btn btn-primary btn-sm" onClick={fixLayout}>
                <IconSparkles size={13} />
                {t.video.layoutFix}
              </button>
            )}
            <button type="button" ref={anywayButton} className="btn btn-secondary btn-sm" onClick={exportAnyway}>
              {t.video.layoutExportAnyway}
            </button>
          </div>
        </div>
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
