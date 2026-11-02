// Allow-mode suggestion in the chat stream (see chat/allowNudge.ts). One
// click switches the folder to allow (the core asks for its own native
// confirmation); the X dismisses it. For computer-wide access, which can
// never be allow, it points to Settings instead.

import type { Nudge } from "../chat/allowNudge";
import { useT } from "../i18n";
import { IconCheck, IconX } from "../icons";

export function AllowNudgeCard({
  nudge,
  folderName,
  onAllow,
  onOpenSettings,
  onDismiss,
}: {
  nudge: Nudge;
  /// Display name of the folder (folder targets only).
  folderName: string;
  onAllow: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const t = useT();

  if (nudge.status === "allowed") {
    return (
      <div className="approval-line granted" role="status">
        <IconCheck size={14} />
        <span className="approval-line-text">{t.nudge.allowed(folderName)}</span>
      </div>
    );
  }

  const isFolder = nudge.target.kind === "folder";
  return (
    <div className="nudge-card" role="group" aria-label={t.nudge.region}>
      <p className="nudge-text">{isFolder ? t.nudge.folder(folderName) : t.nudge.computerWide}</p>
      <div className="nudge-actions">
        {nudge.status === "switching" ? (
          <span className="approval-sending" role="status">
            {t.nudge.switching}
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={isFolder ? onAllow : onOpenSettings}
          >
            {isFolder ? t.nudge.allowAlways : t.nudge.openSettings}
          </button>
        )}
        <button
          type="button"
          className="icon-btn"
          aria-label={t.nudge.dismiss}
          title={t.nudge.dismiss}
          onClick={onDismiss}
        >
          <IconX size={15} />
        </button>
      </div>
    </div>
  );
}
