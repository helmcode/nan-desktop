// Round 6: a small transient notice at the bottom of the chat (e.g. the
// outcome of "Save as…"). Polite live region, dismissible, and it closes by
// itself after `timeoutMs`.

import { useEffect } from "react";
import { useT } from "../i18n";
import { IconCheck, IconWarning, IconX } from "../icons";

export interface ToastNotice {
  /// Changes for every notice so a repeated message restarts the timer.
  id: number;
  kind: "success" | "error";
  text: string;
}

export const TOAST_TIMEOUT_MS = 5000;

export function Toast({
  notice,
  onDismiss,
  timeoutMs = TOAST_TIMEOUT_MS,
}: {
  notice: ToastNotice | null;
  onDismiss: () => void;
  timeoutMs?: number;
}) {
  const t = useT();
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(onDismiss, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss, timeoutMs]);

  // The live region stays mounted so screen readers announce new notices.
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {notice && (
        <div className={`toast toast-${notice.kind}`}>
          {notice.kind === "success" ? <IconCheck size={14} /> : <IconWarning size={14} />}
          <span className="toast-text">{notice.text}</span>
          <button type="button" className="toast-close" aria-label={t.chat.dismissNotice} onClick={onDismiss}>
            <IconX size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
