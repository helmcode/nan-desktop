// The composer queue on screen: the messages typed while a reply runs, just
// above the composer, each with Edit (back into the composer) and Remove.
// After a stop the queue is held and offers "Send now". The rules live in
// ./queue.ts.

import { useId } from "react";
import { useT } from "../i18n";
import type { QueuedMessage } from "./queue";

export function QueuedMessages({
  items,
  held,
  onEdit,
  onRemove,
  onSendNow,
}: {
  items: readonly QueuedMessage[];
  held: boolean;
  onEdit: (id: number) => void;
  onRemove: (id: number) => void;
  onSendNow: () => void;
}) {
  const t = useT();
  const baseId = useId();
  const noteId = `${baseId}-note`;
  if (items.length === 0) return null;
  return (
    <section className="queued" aria-label={t.chat.queueLabel} aria-describedby={noteId}>
      <ul className="queued-list">
        {items.map((item) => {
          const textId = `${baseId}-m${item.id}`;
          return (
            <li key={item.id} className="queued-item">
              <span className="queued-text" id={textId}>
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
        <p className="queued-note" id={noteId} role="status">
          {held ? t.chat.queueHeld(items.length) : t.chat.queueWaiting(items.length)}
        </p>
        {held && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSendNow}>
            {t.chat.queueSendNow}
          </button>
        )}
      </div>
    </section>
  );
}
