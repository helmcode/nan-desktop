// R-V1: "Export MP4". The core zips the project, uploads it to the
// platform's render service with the session JWT (the renderer never sees
// it), and later streams the finished MP4 into the project's exports
// folder. Here: the remaining monthly export time in plain words, the
// formats to export (one or several: they render one after another, see
// exportQueue.ts), each format's progress, cancel (one, or the rest),
// every failure in plain words, and what to do with each file (open, show
// in folder, save a copy).
//
// Export on demand: the project's own format (the one the assistant built
// and the user saw) exports right away, unchecked. Any OTHER selected
// format is checked first (layoutCheck.ts): the ones that show the video
// whole join the queue as soon as the check ends; a format that would come
// out cut off is not put to the user as a choice: the panel says it needs
// adjustments, the assistant is fixing it and it will download by itself,
// and exportFix.ts drives that (fix message, re-check, export, bounded).
// A check that cannot run never holds anything.

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
import { exportFixFor, MAX_EXPORT_FIX_ROUNDS } from "./exportFix";
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

/// The layout gate: idle, or checking the other formats.
type Gate =
  | { kind: "idle" }
  /// `aspect`: the format being checked now (null: waiting to start).
  | { kind: "checking"; aspects: Aspect[]; aspect: Aspect | null };

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
  /// Send the assistant a request to fix formats that come out cut off
  /// (and go to the chat): the way out once the automatic fix gave up.
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
  // The assistant fixing a cut-off format (outlives the panel).
  const flow = useMemo(() => exportFixFor(profileId, project.id), [profileId, project.id]);
  const fix = useSyncExternalStore(flow.subscribe, flow.getSnapshot);
  const fixPanel = useRef<HTMLDivElement | null>(null);
  const ownPanel = useRef<HTMLDivElement | null>(null);
  const section = useRef<HTMLElement | null>(null);
  const [, rerender] = useState(0);
  const exportButton = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const queueList = useRef<HTMLUListElement | null>(null);
  // The running check's abort ("Cancel export").
  const checkAbort = useRef<AbortController | null>(null);
  // The gate's buttons go away when used: the keyboard lands on the Export
  // button, or (while it is disabled) a queue control, or the heading;
  // never on <body>. Resolved after the render that removed them.
  // `awaitQueue` ("Export anyway"): the queue fills a render or two after
  // the gate goes away, so the heading fallback waits a few renders for a
  // queue control instead of grabbing the focus first.
  const refocus = useRef<false | { awaitQueue: number }>(false);
  useEffect(() => {
    const pending = refocus.current;
    if (!pending) return;
    const control =
      (exportButton.current && !exportButton.current.disabled ? exportButton.current : null) ??
      queueList.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") ??
      null;
    if (!control && pending.awaitQueue > 0) {
      refocus.current = { awaitQueue: pending.awaitQueue - 1 };
      return;
    }
    refocus.current = false;
    (control ?? heading.current)?.focus();
  });
  // A changed video: an earlier verdict no longer applies.
  useEffect(() => {
    if (verdicts.current.key === key) return;
    verdicts.current = { key, report: {} };
    // A check in flight stays on screen (and keeps Export disabled): it
    // notices the new version when it ends and checks that one instead.
    setGate((prev) => (prev.kind === "checking" ? prev : { kind: "idle" }));
  }, [key]);
  // The fix flow moving on: the keyboard follows it, but only when it was
  // in this panel (or nowhere): it is never taken from the chat composer.
  const fixKind = fix.status.kind;
  const prevFixKind = useRef(fixKind);
  useEffect(() => {
    const before = prevFixKind.current;
    prevFixKind.current = fixKind;
    if (before === fixKind) return;
    const active = document.activeElement;
    const ours = !active || active === document.body || (section.current?.contains(active) ?? false);
    if (!ours) return;
    if (fixKind === "idle") {
      // A note about the own format takes the keyboard instead (below).
      if (flow.getSnapshot().ownBroken) return;
      refocus.current = { awaitQueue: 5 };
      rerender((n) => n + 1);
      return;
    }
    fixPanel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [fixKind, flow]);
  const ownBroken = fix.ownBroken !== null;
  useEffect(() => {
    if (!ownBroken || fixKind !== "idle") return;
    const active = document.activeElement;
    if (!active || active === document.body || (section.current?.contains(active) ?? false))
      ownPanel.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [ownBroken, fixKind]);

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
  // Rows name their format when there are several, or while a format is
  // being fixed (the one row on screen is then not the only format).
  const many = items.length > 1 || fix.status.kind !== "idle" || fix.fixed.length > 0;
  // "Cancel the rest": the formats not started yet, while another one runs
  // or several wait.
  const rest = items.filter((item) => item.phase.kind === "pending" || item.phase.kind === "waiting");
  const unsettled = items.filter((item) => !isSettled(item));

  const toggle = (aspect: Aspect) =>
    setSelected((prev) => (prev.includes(aspect) ? prev.filter((a) => a !== aspect) : [...prev, aspect]));

  // The version and project a running check must still match when it ends.
  const current = useRef({ key, projectId: project.id, own, title: project.meta.title });
  current.current = { key, projectId: project.id, own, title: project.meta.title };

  /// Check `wanted` (the verdicts of this version are reused), then queue
  /// the formats that fit (`append`: after the own format, already queued)
  /// and hand the others to the assistant. ONE check at a time: while one
  /// runs, Export is disabled and a second start is ignored, so a format
  /// can never be queued twice (the flow also tells every panel of this
  /// project that a check runs, so a panel opened meanwhile waits too).
  /// `end` releases that, once.
  const runGate = (wanted: Aspect[], chosen: Quality, append: boolean, end: () => void) => {
    const atKey = current.current.key;
    const projectId = current.current.projectId;
    const known = verdicts.current.key === atKey ? verdicts.current.report : {};
    const missing = wanted.filter((aspect) => !(aspect in known));
    const abort = new AbortController();
    checkAbort.current = abort;
    setGate({ kind: "checking", aspects: wanted, aspect: null });
    const checked: Promise<LayoutReport> =
      missing.length > 0
        ? checkLayout(profileId, projectId, missing, {
            signal: abort.signal,
            onAspect: (aspect) => {
              if (alive.current && !abort.signal.aborted) setGate({ kind: "checking", aspects: wanted, aspect });
            },
          }).catch(() => ({}))
        : Promise.resolve({});
    void checked.then((fresh) => {
      // "Don't export": nothing goes out, and the partial verdict is not kept.
      if (abort.signal.aborted) {
        end();
        return;
      }
      if (checkAbort.current === abort) checkAbort.current = null;
      if (current.current.key !== atKey) {
        // The video changed while it was checked: this verdict is about an
        // old version. Nothing is queued or shown from it; the same formats
        // are checked again for the version on screen (another project
        // entirely, or a closed panel: dropped).
        if (alive.current && current.current.projectId === projectId) {
          runGate(wanted, chosen, append, end);
          return;
        }
        end();
        if (alive.current) setGate({ kind: "idle" });
        return;
      }
      const report = { ...known, ...fresh };
      // Only real verdicts are remembered: "could not check" (null: a
      // timeout, the budget, an error) is tried again on the next export
      // instead of passing this version for good.
      const kept: LayoutReport = {};
      for (const aspect of Object.keys(report) as Aspect[]) if (report[aspect]) kept[aspect] = report[aspect];
      if (verdicts.current.key === atKey) verdicts.current = { key: atKey, report: kept };
      const broken = brokenAspects(report, wanted);
      const fine = wanted.filter((aspect) => !broken.includes(aspect));
      // The formats that fit go now (also when the panel closed meanwhile:
      // the queue outlives it); the assistant fixes the others, which then
      // download by themselves (the flow outlives the panel too).
      if (fine.length > 0) queue.enqueue(fine, chosen, append);
      if (broken.length > 0) flow.start({ aspects: broken, report, quality: chosen, own: current.current.own, title: current.current.title });
      end();
      if (!alive.current) return;
      setGate({ kind: "idle" });
    });
  };

  // Releases the running check's hold on the project's panels.
  const endCheck = useRef<(() => void) | null>(null);
  const start = () => {
    if (checkAbort.current || flow.active || queue.busy) return;
    const others = order.filter((aspect) => aspect !== own);
    // One export check per project, whichever panel runs it.
    if (others.length > 0 && !flow.beginCheck()) return;
    setFileError(false);
    flow.reset();
    // The own format is the one the assistant built and the user saw: it
    // goes right away. The others are checked meanwhile.
    const withOwn = order.includes(own);
    if (withOwn) queue.enqueue([own], quality);
    if (others.length > 0) {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        if (endCheck.current === end) endCheck.current = null;
        flow.endCheck();
      };
      endCheck.current = end;
      runGate(others, quality, withOwn, end);
    }
  };

  const cancelCheck = () => {
    checkAbort.current?.abort();
    checkAbort.current = null;
    endCheck.current?.();
    refocus.current = { awaitQueue: 0 };
    setGate({ kind: "idle" });
  };

  const phrase = (aspects: Aspect[]) => t.video.formatsPhrase(...aspects.map((aspect) => t.video.aspectInline[aspect]));

  // Final state of a fix: export as it is, or take it to the chat.
  const exportAnyway = () => {
    refocus.current = { awaitQueue: 5 };
    flow.exportAnyway();
  };
  const fixInChat = () => {
    const status = fix.status;
    if (status.kind !== "stuck" || !onFixLayout) return;
    refocus.current = { awaitQueue: 0 };
    flow.dismiss();
    onFixLayout(t.video.layoutFixText(phrase(status.aspects), phrase([fix.own])), {
      project_id: project.id,
      title: project.meta.title,
      problems: layoutProblems(status.report, status.aspects),
    });
  };
  const discardFix = () => {
    refocus.current = { awaitQueue: 0 };
    flow.dismiss();
  };
  const cancelFix = () => {
    refocus.current = { awaitQueue: 0 };
    flow.cancel();
  };
  // The own format broke after a fix.
  const fixOwnInChat = () => {
    if (!fix.ownBroken || !onFixLayout) return;
    const report: LayoutReport = { [fix.own]: fix.ownBroken };
    refocus.current = { awaitQueue: 0 };
    flow.dismissOwn();
    onFixLayout(t.video.layoutOwnFixText(phrase([fix.own])), {
      project_id: project.id,
      title: project.meta.title,
      problems: layoutProblems(report, [fix.own]),
    });
  };
  const dismissOwn = () => {
    refocus.current = { awaitQueue: 0 };
    flow.dismissOwn();
  };

  // A scene without a title is "Scene N" (its position), as in the editor.
  const sceneTitle = (id: string) => {
    const index = project.meta.scenes.findIndex((scene) => scene.id === id);
    if (index < 0) return id;
    return project.meta.scenes[index].title.trim() || t.video.sceneUntitled(index + 1);
  };
  const checking = gate.kind === "checking";
  const fixing = fix.status.kind === "fixing" || fix.status.kind === "checking";
  // The formats exporting while another one is fixed, in the app's order.
  const exportingNow = ASPECTS.filter((aspect) => items.some((item) => item.aspect === aspect && !isSettled(item)));
  const ownState: "exported" | "held" | "none" = fix.ownHeld
    ? "held"
    : items.some((item) => item.aspect === fix.own && item.phase.kind !== "canceled" && item.phase.kind !== "skipped")
      ? "exported"
      : "none";
  const issueLines = (aspects: Aspect[], report: LayoutReport) => (
    <ul className="video-layout-list">
      {aspects.map((aspect) => {
        const issues = report[aspect] ?? [];
        const scenes = [...new Set(issues.map((issue) => issue.scene))].map(sceneTitle).join(", ");
        return <li key={aspect}>{t.video.layoutFormatLine(t.video.aspectInline[aspect], issues.length, scenes)}</li>;
      })}
    </ul>
  );

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
    <section ref={section} className="video-section video-export" aria-labelledby="video-export-title">
      <h2 id="video-export-title" ref={heading} className="video-section-title" tabIndex={-1}>
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
          ref={exportButton}
          onClick={start}
          disabled={busy || checking || fix.gateChecking || fixing || blocked || short || order.length === 0}
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
      {gate.kind === "checking" && (
        <div className="video-progress video-layout-checking">
          <span role="status">{gate.aspect ? t.video.layoutCheckingFormat(t.video.aspectInline[gate.aspect]) : t.video.layoutChecking}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancelCheck}>
            <IconStop size={13} />
            {t.video.layoutCancelFormats(phrase(gate.aspects))}
          </button>
        </div>
      )}
      {gate.kind !== "checking" && fix.gateChecking && (
        <p className="video-progress video-layout-checking" role="status">
          {t.video.layoutChecking}
        </p>
      )}
      {fix.status.kind === "fixing" && (
        <div className="video-layout-gate" ref={fixPanel}>
          {/* Only this sentence is live: it changes when the assistant
              takes the request, not on every detail below. */}
          <p className="video-hint" role="status">
            {t.video.layoutFixing(phrase(fix.status.aspects), fix.status.aspects.length, fix.status.started)}
          </p>
          {fix.status.round > 1 && <p className="video-hint">{t.video.layoutFixingRound(fix.status.round, MAX_EXPORT_FIX_ROUNDS)}</p>}
          {fix.waitingIn && <p className="video-warn">{t.video.layoutFixWaitingIn(fix.waitingIn.title)}</p>}
          {issueLines(fix.status.aspects, fix.status.report)}
          {exportingNow.length > 0 && <p className="video-hint">{t.video.layoutFixingOthers(phrase(exportingNow), exportingNow.length)}</p>}
          <div className="video-export-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={cancelFix}>
              <IconStop size={13} />
              {t.video.layoutCancelFormats(phrase(fix.status.aspects))}
            </button>
          </div>
        </div>
      )}
      {fix.status.kind === "checking" && (
        <div className="video-progress video-layout-checking" ref={fixPanel}>
          <span role="status">{t.video.layoutFixChecking(phrase(fix.status.aspects))}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancelFix}>
            <IconStop size={13} />
            {t.video.layoutCancelFormats(phrase(fix.status.aspects))}
          </button>
        </div>
      )}
      {fix.status.kind === "stuck" && (
        <div className="video-layout-gate" ref={fixPanel}>
          <p className="video-warn" role="alert">
            {t.video.layoutStuck(phrase(fix.status.aspects), fix.status.aspects.length, fix.status.why)}
          </p>
          {fix.status.why === "rounds" && issueLines(fix.status.aspects, fix.status.report)}
          <div className="video-export-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={exportAnyway}>
              {t.video.layoutExportAnyway}
            </button>
            {onFixLayout && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={fixInChat}>
                <IconSparkles size={13} />
                {t.video.layoutFixInChat}
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={discardFix}>
              {t.video.layoutDiscard}
            </button>
          </div>
        </div>
      )}
      {fix.status.kind === "idle" && fix.canceledMidTurn && (
        <p className="video-hint" role="status">
          {t.video.layoutFixCanceledMidTurn}
        </p>
      )}
      {fix.status.kind === "idle" && fix.fixed.length > 0 && (
        <p className="video-ok" role="status">
          {t.video.layoutFixed(phrase(fix.fixed), fix.fixed.length)}
        </p>
      )}
      {fix.ownBroken && (
        <div className="video-layout-gate" ref={ownPanel}>
          <p className="video-warn" role="alert">
            {t.video.layoutOwnBroken(phrase([fix.own]), ownState)}
          </p>
          {issueLines([fix.own], { [fix.own]: fix.ownBroken })}
          <div className="video-export-actions">
            {onFixLayout && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={fixOwnInChat}>
                <IconSparkles size={13} />
                {t.video.layoutFixInChat}
              </button>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={dismissOwn}>
              {t.video.layoutOwnDismiss}
            </button>
          </div>
        </div>
      )}
      {items.length > 0 && (
        <ul className="video-queue" ref={queueList} aria-label={t.video.exportFormats}>
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
