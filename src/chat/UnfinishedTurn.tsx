// Turn continuity: when a reply's turn ended before the work was done, the
// core says why (`end_reason` on the stored reply, `reason` on
// `chat://done`). For the reasons that mean "not finished, not by you"
// (the task needed more steps than one reply allows, the connection
// dropped, or the reply hit its length limit) the chat shows a calm notice
// under that reply and a "Continue" button that sends a continuation turn.
// A finished reply or one the user stopped shows nothing.
//
// A dropped connection or a too-long reply is resumed automatically ONCE
// (after AUTO_RETRY_DELAY_MS, cancellable): the user should not have to do
// it. If that automatic continuation stops the same way, the manual notice
// is shown instead (never a loop). The step cap (`tool_cap`) always waits
// for the user: it bounds cost on purpose.

import { useId } from "react";
import { useT } from "../i18n";

/** The end reasons the user can continue from (mirrors the core's
 * `TurnEndReason::is_continuable`). */
export const CONTINUABLE_REASONS = ["tool_cap", "stream_cut", "length"] as const;
export type ContinuableReason = (typeof CONTINUABLE_REASONS)[number];

/** The reasons resumed automatically once. */
export const AUTO_RETRY_REASONS = ["stream_cut", "length"] as const;
export type AutoRetryReason = (typeof AUTO_RETRY_REASONS)[number];

/** Pause before the automatic continuation (time to read and cancel). */
export const AUTO_RETRY_DELAY_MS = 2000;

export function isContinuable(reason: string | null | undefined): reason is ContinuableReason {
  return (CONTINUABLE_REASONS as readonly string[]).includes(reason ?? "");
}

/** Whether a turn that just ended with `reason` is resumed automatically:
 * only a cut or a too-long reply, and never when that turn was itself the
 * automatic continuation. */
export function shouldAutoRetry(reason: string | null | undefined, turnWasAutoRetry: boolean): boolean {
  return !turnWasAutoRetry && (AUTO_RETRY_REASONS as readonly string[]).includes(reason ?? "");
}

export function UnfinishedTurn({
  reason,
  onContinue,
  disabled = false,
  autoRetrying = false,
  onCancelAutoRetry,
}: {
  reason: string | null | undefined;
  onContinue: () => void;
  disabled?: boolean;
  /** An automatic continuation is about to start (shows "resuming" and a
   * Cancel button instead of Continue). */
  autoRetrying?: boolean;
  onCancelAutoRetry?: () => void;
}) {
  const t = useT();
  const noteId = useId();
  if (!isContinuable(reason)) return null;
  if (autoRetrying && reason !== "tool_cap") {
    return (
      <div className="unfinished-turn" role="status">
        <p className="unfinished-note" id={noteId}>
          {t.chat.autoRetrying[reason]}
        </p>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onCancelAutoRetry}
          aria-describedby={noteId}
        >
          {t.chat.cancelAutoRetry}
        </button>
      </div>
    );
  }
  return (
    <div className="unfinished-turn" role="status">
      <p className="unfinished-note" id={noteId}>
        <span className="unfinished-title">{t.chat.unfinished}</span> {t.chat.unfinishedReason[reason]}
      </p>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={onContinue}
        disabled={disabled}
        aria-describedby={noteId}
      >
        {t.chat.continueTurn}
      </button>
    </div>
  );
}
