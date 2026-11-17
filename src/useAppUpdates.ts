// The app window's ONE update state (R20-E schedule, round 14/S1 result).
//
// Updates never depend on a session: `App` calls this before the sign-in
// state resolves, so the schedule (startup, every 2 hours, coming back after
// 2 hours away, never more than once per 30 minutes, one check at a time)
// runs on the loading, sign-in and error screens too. The `update_check` /
// `update_install` commands only talk to the public, signed release feed.
//
// Everything that shows the update reads this one state: the banner (on the
// sign-in screen or in the chat), the user menu and Settings. The install
// busy flag and the banner's dismiss live here as well, so a second install
// cannot start from another surface and a banner dismissed on the sign-in
// screen stays dismissed in the chat for the same check.

import { useCallback, useEffect, useState } from "react";
import { checkForUpdate, installUpdate, type UpdateInfo } from "./core";
import { startUpdateSchedule } from "./updateSchedule";

export interface AppUpdates {
  /** The newer version the last good check found (null: up to date). */
  available: UpdateInfo | null;
  /** Bumped after every successful check. */
  checkSeq: number;
  /** The check whose banner the user closed (null: none). */
  dismissedSeq: number | null;
  dismiss: (seq: number) => void;
  /** One install at a time across every surface. */
  installing: boolean;
  startInstall: () => Promise<void>;
}

export function useAppUpdates({
  check = checkForUpdate,
  install = installUpdate,
}: { check?: () => Promise<UpdateInfo | null>; install?: () => Promise<void> } = {}): AppUpdates {
  const [available, setAvailable] = useState<UpdateInfo | null>(null);
  const [checkSeq, setCheckSeq] = useState(0);
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);

  // A failed check (dev build, offline, no release feed yet, a wake-up
  // before the network) is silent and changes nothing: the banner and the
  // menu keep what the last good check found, and a dismissed banner stays
  // dismissed. It rejects so the schedule can retry once back online.
  const runCheck = useCallback(async (): Promise<UpdateInfo | null> => {
    const found = await check();
    setAvailable(found);
    setCheckSeq((n) => n + 1);
    return found;
  }, [check]);

  useEffect(() => startUpdateSchedule({ run: runCheck }), [runCheck]);

  const startInstall = useCallback(async (): Promise<void> => {
    if (installing) return;
    setInstalling(true);
    try {
      await install();
    } finally {
      setInstalling(false);
    }
  }, [installing, install]);

  return { available, checkSeq, dismissedSeq, dismiss: setDismissedSeq, installing, startInstall };
}
