// Workspace state shared by the composer chip, the user menu and Settings.
//
// The Rust core owns every decision: folders are only added through the
// native picker it opens, the whole-computer mode only after the user
// confirms the core's native warning, and the approval mode of a grant is
// stored and enforced by the core (S13). The renderer lists grants and asks
// for changes.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { grantErrorKind, isComputerWide, type GrantErrorKind } from "./copy";
import { addGrant, DEFAULT_GRANT_MODE, normalizeGrantMode, setGrantMode, type GrantMode } from "./core";
import type { GrantView } from "./types";

export interface Workspace {
  /// Private folders of the active profile (most recent last).
  folders: GrantView[];
  /// The whole-computer grant, when that mode is on.
  computerWide: GrantView | null;
  /// Approval mode per grant id (default ask).
  modes: Record<string, GrantMode>;
  busy: boolean;
  /// Error kind; localized at render time.
  error: GrantErrorKind;
  clearError: () => void;
  refresh: () => Promise<void>;
  /// Opens the native folder picker; resolves true when a folder was added.
  /// The new grant gets `mode` (default ask).
  addFolder: (mode?: GrantMode) => Promise<boolean>;
  /// Like `addFolder`, resolving to the added (or already granted) folder,
  /// or null when the picker was cancelled or failed.
  pickFolder: (mode?: GrantMode) => Promise<GrantView | null>;
  /// Picks a replacement folder; the old grant is revoked only when a new
  /// one was actually added, and the new one keeps the old mode.
  repickFolder: (grantId: string) => Promise<boolean>;
  /// Resolves to the mode the core actually stored (null on failure): a
  /// declined native confirmation leaves the previous mode.
  setMode: (grantId: string, mode: GrantMode) => Promise<GrantMode | null>;
  /// Asks the core to enable the whole-computer mode (native confirmation).
  enableComputerWide: () => Promise<boolean>;
  /// Back to private folders only.
  disableComputerWide: () => Promise<void>;
  removeGrant: (grantId: string) => Promise<void>;
}

/// The mode that actually applies (core `Grant::effective_mode`):
/// computer-wide grants always ask, whatever is stored.
export function effectiveMode(grant: GrantView): GrantMode {
  return isComputerWide(grant) ? DEFAULT_GRANT_MODE : normalizeGrantMode(grant.mode);
}

/// Grants of one profile with their effective modes. Every grant in
/// `tools_grant_list` carries its `mode`, so no per-grant round trip.
export async function loadGrants(
  profileId: string | null,
): Promise<{ grants: GrantView[]; modes: Record<string, GrantMode> }> {
  const list = await invoke<GrantView[]>("tools_grant_list");
  const grants = list.filter((g) => g.profile_id === profileId);
  return { grants, modes: Object.fromEntries(grants.map((g) => [g.id, effectiveMode(g)])) };
}

export function useWorkspace(profileId: string | null): Workspace {
  const [grants, setGrants] = useState<GrantView[]>([]);
  const [modes, setModes] = useState<Record<string, GrantMode>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<GrantErrorKind>("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const loaded = await loadGrants(profileId);
      setGrants(loaded.grants);
      setModes(loaded.modes);
    } catch {
      // Keep the last known list on a transient failure.
    }
  }, [profileId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async <T,>(work: () => Promise<T>, fallback: T): Promise<T> => {
      setBusy(true);
      setError("");
      try {
        const result = await work();
        await refresh();
        return result;
      } catch (err) {
        setError(grantErrorKind(err));
        await refresh();
        return fallback;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const pickFolder = useCallback(
    async (mode: GrantMode = DEFAULT_GRANT_MODE): Promise<GrantView | null> => {
      if (!profileId) return null;
      // One call: the core applies `mode` (and confirms allow natively).
      return run(() => addGrant(profileId, mode), null);
    },
    [profileId, run],
  );

  const addFolder = useCallback(
    async (mode: GrantMode = DEFAULT_GRANT_MODE): Promise<boolean> => (await pickFolder(mode)) !== null,
    [pickFolder],
  );

  const repickFolder = useCallback(
    async (grantId: string): Promise<boolean> => {
      if (!profileId) return false;
      const previousMode = modes[grantId] ?? DEFAULT_GRANT_MODE;
      return run(async () => {
        const grant = await addGrant(profileId, previousMode);
        if (grant === null) return false;
        if (grant.id !== grantId) await invoke("tools_grant_revoke", { grantId });
        return true;
      }, false);
    },
    [profileId, modes, run],
  );

  const setMode = useCallback(
    async (grantId: string, mode: GrantMode): Promise<GrantMode | null> => {
      // The core returns the grant as stored: a declined native
      // confirmation leaves it unchanged, and the refresh in `run` shows that.
      return run(async (): Promise<GrantMode | null> => {
        const updated = await setGrantMode(grantId, mode);
        const stored = effectiveMode(updated);
        setModes((current) => ({ ...current, [updated.id]: stored }));
        return stored;
      }, null);
    },
    [run],
  );

  const enableComputerWide = useCallback(async (): Promise<boolean> => {
    if (!profileId) return false;
    return run(async () => {
      const grant = await invoke<GrantView | null>("tools_grant_computer_wide", { profileId });
      return grant !== null;
    }, false);
  }, [profileId, run]);

  const removeGrant = useCallback(
    async (grantId: string): Promise<void> => {
      await run(async () => {
        await invoke("tools_grant_revoke", { grantId });
      }, undefined);
    },
    [run],
  );

  const computerWide = grants.find(isComputerWide) ?? null;

  const disableComputerWide = useCallback(async (): Promise<void> => {
    if (computerWide) await removeGrant(computerWide.id);
  }, [computerWide, removeGrant]);

  return {
    folders: grants.filter((g) => !isComputerWide(g)),
    computerWide,
    modes,
    busy,
    error,
    clearError: () => setError(""),
    refresh,
    addFolder,
    pickFolder,
    repickFolder,
    setMode,
    enableComputerWide,
    disableComputerWide,
    removeGrant,
  };
}
