// Round 7: non-invasive "new version available" banner at the top of the chat.
//
// - R20-E: the app window owns the one update schedule (`useAppUpdates.ts`
//   over `updateSchedule.ts`: startup, every 2 hours, and when the window
//   comes back after more than 2 hours away), signed in or not, and hands
//   the banner the result (`update` + `checkSeq`). The banner never checks
//   by itself.
// - Never installs by itself: only the user's click on "Update" downloads,
//   verifies, installs and relaunches.
// - The close button hides the banner until the next check.

import { useState } from "react";
import { installUpdate, type UpdateInfo } from "../core";
import { useT } from "../i18n";
import { IconDownload, IconX } from "../icons";

type Phase = "idle" | "installing" | "failed";

export function UpdateBanner({
  update,
  checkSeq,
  install = installUpdate,
  externalBusy = false,
  dismissedSeq: dismissedSeqProp,
  onDismiss,
}: {
  /** The shell's last good check result (null: up to date). */
  update: UpdateInfo | null;
  /** Bumped by the shell after every successful check (a new check brings
   *  a dismissed banner back). */
  checkSeq: number;
  install?: () => Promise<void>;
  externalBusy?: boolean;
  /** Controlled dismiss: the app keeps it so a banner closed on the sign-in
   *  screen stays closed in the chat for the same check. Omitted: local. */
  dismissedSeq?: number | null;
  onDismiss?: (seq: number) => void;
}) {
  const t = useT();
  // Dismiss hides the banner for the check it was showing; a later check
  // (a new `checkSeq`) shows it again. Derived, not re-set from an effect:
  // an effect could run after a dismiss made right as a check landed and
  // bring the banner back.
  const [localDismissedSeq, setLocalDismissedSeq] = useState<number | null>(null);
  const controlled = onDismiss !== undefined;
  const dismissedSeq = controlled ? (dismissedSeqProp ?? null) : localDismissedSeq;
  const visible = dismissedSeq !== checkSeq;
  const [phase, setPhase] = useState<Phase>("idle");

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
        onClick={() => void onUpdate()}
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
          if (controlled) onDismiss(checkSeq);
          else setLocalDismissedSeq(checkSeq);
        }}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}
