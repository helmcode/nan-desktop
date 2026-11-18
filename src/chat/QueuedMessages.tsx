// The composer queue on screen: the messages typed while a reply runs, just
// above the composer, each with Edit (back into the composer) and Remove.
// A held queue says why (stopped by the user, or the send failed) and offers
// "Send now". The rules live in ./queue.ts.

import { useId } from "react";
import { useT } from "../i18n";
import type { HeldReason, QueuedMessage } from "./queue";

export function QueuedMessages({
  items,
  held,
  canSendNow = true,
  onEdit,
  onRemove,
  onSendNow,
}: {
  items: readonly QueuedMessage[];
  held: HeldReason | false;
  /** False while sending cannot work (an expired session): no "Send now". */
  canSendNow?: boolean;
  onEdit: (id: number) => void;
  onRemove: (id: number) => void;
  onSendNow: () => void;
}) {
  const t = useT();
  const baseId = useId();
  const noteId = `${baseId}-note`;
  const count = items.length;
  const note =
    count === 0
      ? ""
      : held === "stopped"
        ? t.chat.queueHeld(count)
        : held === "failed"
          ? t.chat.queueFailed(count)
          : t.chat.queueWaiting(count);
  return (
    <>
      {/* Always mounted (empty when nothing waits), so the first queued
          message is announced: a live region added together with its text
          is often not read. */}
      <p className="visually-hidden queued-live" role="status">
        {note}
      </p>
      {count > 0 && (
        <section className="queued" aria-label={t.chat.queueLabel} aria-describedby={noteId}>
          <ul className="queued-list">
            {items.map((item) => {
              const textId = `${baseId}-m${item.id}`;
              return (
                <li key={item.id} className="queued-item">
                  <span className="queued-text" id={textId} title={item.text}>
                    {item.text}
                  </span>
                  <span className="queued-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-describedby={textId}
                      onClick={() => onEdit(item.id)}
                    >
                      {t.chat.queueEdit}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-describedby={textId}
                      onClick={() => onRemove(item.id)}
                    >
                      {t.chat.queueRemove}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="queued-footer">
            <p className="queued-note" id={noteId}>
              {note}
            </p>
            {held && canSendNow && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onSendNow}>
                {t.chat.queueSendNow}
              </button>
            )}
          </div>
        </section>
      )}
    </>
  );
}
