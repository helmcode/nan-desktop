// Round 7: non-invasive "new version available" banner at the top of the chat.
//
// - Checks silently on startup and every 6 hours. A failed check (offline,
//   no release feed yet, dev build) shows nothing.
// - Never installs by itself: only the user's click on "Update" downloads,
//   verifies, installs and relaunches.
// - The close button hides the banner until the next check.

import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, installUpdate, type UpdateInfo } from "../core";
import { useT } from "../i18n";
import { IconDownload, IconX } from "../icons";

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type Phase = "idle" | "installing" | "failed";

export function UpdateBanner({
  check = checkForUpdate,
  install = installUpdate,
  externalBusy = false,
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
}: {
  check?: () => Promise<UpdateInfo | null>;
  install?: () => Promise<void>;
  externalBusy?: boolean;
  intervalMs?: number;
}) {

  const t = useT();
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");

  const runCheck = useCallback(async (): Promise<void> => {
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        // A new check brings a dismissed banner back.
        setVisible(true);
      }
    } catch {
      // Silent by design: an update check must never bother the user.
    }
  }, [check]);

  useEffect(() => {
    void runCheck();
    const timer = window.setInterval(() => void runCheck(), intervalMs);
    return () => window.clearInterval(timer);
  }, [runCheck, intervalMs]);

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
