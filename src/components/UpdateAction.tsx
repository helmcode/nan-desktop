// Round 14 (C6): the "a newer version is available" row, shared by the
// account menu's popover and the Settings Account section, so the update is
// reachable from both with ONE busy state (one install at a time) and the
// same failure line. The parent passes the busy flag; this row owns only the
// install it started itself, and it unmounts when its surface closes, so a
// stale failure never survives a re-open.

import { useState } from "react";
import { useT } from "../i18n";
import { IconDownload } from "../icons";

export type UpdateActionProps = {
  /** The version the update check found. */
  version: string;
  /** The app's install flow: download, verify, install, relaunch. */
  onUpdate: () => Promise<void>;
  /** True while any update install is in progress, this row's own included
   *  (one install at a time); the guard below stops re-entry. */
  busy?: boolean;
  /** Inside the account menu's popover the row is a menuitem. */
  menuItem?: boolean;
};

export function UpdateAction({ version, onUpdate, busy = false, menuItem = false }: UpdateActionProps) {
  const t = useT();
  const [ownBusy, setOwnBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const installing = busy || ownBusy;

  const start = async (): Promise<void> => {
    if (installing) return;
    setOwnBusy(true);
    setFailed(false);
    try {
      // On success the app installs and relaunches; this row goes away.
      await onUpdate();
    } catch {
      setFailed(true);
    } finally {
      setOwnBusy(false);
    }
  };

  return (
    <div className="update-action">
      <p className="update-action-version">{t.updater.available(version)}</p>
      <button
        type="button"
        role={menuItem ? "menuitem" : undefined}
        className="btn btn-primary btn-sm"
        aria-disabled={installing}
        aria-busy={installing}
        onClick={() => {
          if (installing) return;
          void start();
        }}
      >
        <IconDownload size={14} />
        {installing ? t.updater.updating : t.updater.update}
      </button>
      {failed && (
        <p className="update-action-error" role="alert">
          {t.updater.failed}
        </p>
      )}
    </div>
  );
}
