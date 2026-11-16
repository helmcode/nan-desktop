// Round 7: non-invasive "new version available" banner at the top of the chat.
//
// - R20-E: the shell owns the one update schedule (`updateSchedule.ts`:
//   startup, every 2 hours, and when the window comes back after more than
//   2 hours away) and hands the banner the result (`update` + `checkSeq`).
//   The banner never checks by itself.
// - Never installs by itself: only the user's click on "Update" downloads,
//   verifies, installs and relaunches.
// - The close button hides the banner until the next check.

import { useEffect, useState } from "react";
import { installUpdate, type UpdateInfo } from "../core";
import { useT } from "../i18n";
import { IconDownload, IconX } from "../icons";

type Phase = "idle" | "installing" | "failed";

export function UpdateBanner({
  update,
  checkSeq,
  install = installUpdate,
  externalBusy = false,
}: {
  /** The shell's last good check result (null: up to date). */
  update: UpdateInfo | null;
  /** Bumped by the shell after every successful check (a new check brings
   *  a dismissed banner back). */
  checkSeq: number;
  install?: () => Promise<void>;
  externalBusy?: boolean;
}) {
  const t = useT();
  const [visible, setVisible] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");

  // Every completed check shows the banner again.
  useEffect(() => {
    setVisible(true);
  }, [checkSeq]);

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
          setVisible(false);
        }}
      >
        <IconX size={12} />
      </button>
    </div>
  );
}
