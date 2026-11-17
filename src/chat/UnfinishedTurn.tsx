// Turn continuity: when a reply's turn ended before the work was done, the
// core says why (`end_reason` on the stored reply, `reason` on
// `chat://done`). For the reasons that mean "not finished, not by you"
// (the task needed more steps than one reply allows, the connection
// dropped, or the reply hit its length limit) the chat shows a calm notice
// under that reply and a "Continue" button that sends a continuation turn.
// A finished reply or one the user stopped shows nothing.

import { useId } from "react";
import { useT } from "../i18n";

/** The end reasons the user can continue from (mirrors the core's
 * `TurnEndReason::is_continuable`). */
export const CONTINUABLE_REASONS = ["tool_cap", "stream_cut", "length"] as const;
export type ContinuableReason = (typeof CONTINUABLE_REASONS)[number];

export function isContinuable(reason: string | null | undefined): reason is ContinuableReason {
  return (CONTINUABLE_REASONS as readonly string[]).includes(reason ?? "");
}

export function UnfinishedTurn({
  reason,
  onContinue,
  disabled = false,
}: {
  reason: string | null | undefined;
  onContinue: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  const noteId = useId();
  if (!isContinuable(reason)) return null;
  return (
    <div className="unfinished-turn">
      <p className="unfinished-note" role="note" id={noteId}>
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
