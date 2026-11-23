// R-V1: the app's own confirmation dialog for destructive video actions
// (delete a video, remove a scene). Not window.confirm: the macOS webview
// (wry) implements no JavaScript confirm panel, so it silently answers
// "no". Same pattern as the app's other alert dialogs: focus starts on
// Cancel, Escape and a click outside cancel.

import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { useEscape } from "../escapeLayers";
import { IconWarning } from "../icons";

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  // Focus starts on Cancel and goes back to what opened the dialog.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => {
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);
  useEscape(true, (e) => {
    e.preventDefault();
    onCancel();
  });
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="modal modal-warn"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="video-confirm-title"
        aria-describedby="video-confirm-body"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="modal-icon">
          <IconWarning size={22} />
        </span>
        <h2 id="video-confirm-title">{title}</h2>
        <p id="video-confirm-body">{body}</p>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onCancel}>
            {t.app.cancel}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
