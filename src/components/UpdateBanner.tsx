// Round 7: non-invasive "new version available" banner at the top of the chat.
//
// - Checks silently on the shared schedule (R20-E, `updateSchedule.ts`): on
//   startup, every 2 hours and when the window comes back after more than
//   2 hours away. A failed check (offline, no release feed yet, dev build)
//   shows nothing.
// - In the app the shell owns that schedule and hands the banner the result
//   (`update` + `checkSeq`), so there is one check, not one per surface.
//   Without `update` (standalone) the banner runs the schedule itself.
// - Never installs by itself: only the user's click on "Update" downloads,
//   verifies, installs and relaunches.
// - The close button hides the banner until the next check.

import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, installUpdate, type UpdateInfo } from "../core";
import { useT } from "../i18n";
import { IconDownload, IconX } from "../icons";
import { startUpdateSchedule, UPDATE_CHECK_INTERVAL_MS } from "../updateSchedule";

export { UPDATE_CHECK_INTERVAL_MS };

type Phase = "idle" | "installing" | "failed";

export function UpdateBanner({
  check = checkForUpdate,
  install = installUpdate,
  externalBusy = false,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  update: controlled,
  checkSeq = 0,
}: {
  check?: () => Promise<UpdateInfo | null>;
  install?: () => Promise<void>;
  externalBusy?: boolean;
  intervalMs?: number;
  /** Controlled: the shell's last check result (it owns the schedule). */
  update?: UpdateInfo | null;
  /** Bumped by the shell after every completed check (a new check brings
   *  a dismissed banner back). */
  checkSeq?: number;
}) {
  const t = useT();
  const isControlled = controlled !== undefined;
  const [found, setFound] = useState<UpdateInfo | null>(null);
  const [visible, setVisible] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const update = isControlled ? controlled : found;

  const runCheck = useCallback(async (): Promise<void> => {
    try {
      const result = await check();
      if (result) {
        setFound(result);
        // A new check brings a dismissed banner back.
        setVisible(true);
      }
    } catch {
      // Silent by design: an update check must never bother the user.
    }
  }, [check]);

  useEffect(() => {
    if (isControlled) return;
    return startUpdateSchedule({ run: runCheck, intervalMs });
  }, [isControlled, runCheck, intervalMs]);

  // Controlled: every completed check that found something shows it again.
  useEffect(() => {
    if (isControlled) setVisible(true);
  }, [isControlled, checkSeq]);

  const onUpdate = async (): Promise<void> => {
    if (phase === "installing" || externalBusy) return;
    setPhase("installing");
    try {
      // On success the app relaunches and this component goes away.
      await install();
    } catch {
      setPhase("failed");
    }
  };

  if (!update || !visible) return null;
  const installing = phase === "installing";
  // Round 14 (C3): one install at a time across every surface. The buttons
  // keep aria-disabled instead of `disabled` so the keyboard is not dropped
  // while the download runs; the onClick guards below make them inert.
  const busy = installing || externalBusy;

  return (
    <div className="update-banner" role="status" aria-live="polite">
      <IconDownload size={14} />
      <span className="update-banner-text">
        {t.updater.available(update.version)}
        {phase === "failed" && (
          <span className="update-banner-error" role="alert">
            {" "}
            {t.updater.failed}
          </span>
        )}
      </span>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        aria-disabled={busy}
        aria-busy={busy}
        onClick={() => {
          if (busy) return;
          void onUpdate();
        }}
      >
        {busy ? t.updater.updating : t.updater.update}
      </button>
      <button
        type="button"
        className="toast-close"
        aria-label={t.updater.dismiss}
        title={t.updater.dismiss}
        aria-disabled={busy}
        onClick={() => {
          // Inert while installing: the banner is the only place that says
          // what is happening (C3).
          if (busy) return;
          setVisible(false);
        }}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}
