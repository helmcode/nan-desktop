// Allow-mode suggestion in the chat stream (see chat/allowNudge.ts). One
// click switches the folder to allow (the core asks for its own native
// confirmation); the X dismisses it. For computer-wide access, which can
// never be allow, it points to Settings instead. The browser variant
// offers "always" or "only this session" (both confirmed natively by the
// core).

import type { Nudge, NudgeScope } from "../chat/allowNudge";
import { useT } from "../i18n";
import { IconCheck, IconX } from "../icons";

export function AllowNudgeCard({
  nudge,
  folderName,
  onAllow,
  onAllowBrowser,
  onOpenSettings,
  onDismiss,
}: {
  nudge: Nudge;
  /// Display name of the folder (folder targets only).
  folderName: string;
  onAllow: () => void;
  /// Browser target: "Permitir siempre" or "Solo en esta sesión".
  onAllowBrowser: (scope: NudgeScope) => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const isBrowser = nudge.target.kind === "browser";

  if (nudge.status === "allowed") {
    const text = isBrowser
      ? nudge.scope === "session"
        ? t.nudge.browserSessionAllowed
        : t.nudge.browserAllowed
      : t.nudge.allowed(folderName);
    return (
      <div className="approval-line granted" role="status">
        <IconCheck size={14} />
        <span className="approval-line-text">{text}</span>
      </div>
    );
  }

  const dismiss = (
    <button type="button" className="icon-btn" aria-label={t.nudge.dismiss} title={t.nudge.dismiss} onClick={onDismiss}>
      <IconX size={15} />
    </button>
  );

  if (isBrowser) {
    return (
      <div className="nudge-card" role="group" aria-label={t.nudge.region}>
        <p className="nudge-text">{t.nudge.browser}</p>
        <div className="nudge-actions">
          {nudge.status === "switching" ? (
            <span className="approval-sending" role="status">
              {t.nudge.switching}
            </span>
          ) : (
            <>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onAllowBrowser("always")}>
                {t.nudge.browserAlways}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onAllowBrowser("session")}>
                {t.nudge.browserSession}
              </button>
            </>
          )}
          {dismiss}
        </div>
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
        {dismiss}
      </div>
    </div>
  );
}
