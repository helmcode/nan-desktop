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
import { DEFAULT_GRANT_MODE, getGrantMode, normalizeGrantMode, setGrantMode, type GrantMode } from "./core";
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
  /// Picks a replacement folder; the old grant is revoked only when a new
  /// one was actually added, and the new one keeps the old mode.
  repickFolder: (grantId: string) => Promise<boolean>;
  setMode: (grantId: string, mode: GrantMode) => Promise<void>;
  /// Asks the core to enable the whole-computer mode (native confirmation).
  enableComputerWide: () => Promise<boolean>;
  /// Back to private folders only.
  disableComputerWide: () => Promise<void>;
  removeGrant: (grantId: string) => Promise<void>;
}

/// Grants of one profile, with modes resolved (list field first, then the
/// per-grant command, then the safe default).
export async function loadGrants(
  profileId: string | null,
): Promise<{ grants: GrantView[]; modes: Record<string, GrantMode> }> {
  const list = await invoke<GrantView[]>("tools_grant_list");
  const grants = list.filter((g) => g.profile_id === profileId);
  const entries = await Promise.all(
    grants.map(async (g): Promise<[string, GrantMode]> => {
      if (g.mode !== undefined) return [g.id, normalizeGrantMode(g.mode)];
      try {
        return [g.id, await getGrantMode(g.id)];
      } catch {
        return [g.id, DEFAULT_GRANT_MODE];
      }
    }),
  );
  return { grants, modes: Object.fromEntries(entries) };
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

  const addFolder = useCallback(
    async (mode: GrantMode = DEFAULT_GRANT_MODE): Promise<boolean> => {
      if (!profileId) return false;
      return run(async () => {
        const grant = await invoke<GrantView | null>("tools_grant_add", { profileId });
        if (grant === null) return false;
        if (mode !== DEFAULT_GRANT_MODE) await setGrantMode(grant.id, mode);
        return true;
      }, false);
    },
    [profileId, run],
  );

  const repickFolder = useCallback(
    async (grantId: string): Promise<boolean> => {
      if (!profileId) return false;
      const previousMode = modes[grantId] ?? DEFAULT_GRANT_MODE;
      return run(async () => {
        const grant = await invoke<GrantView | null>("tools_grant_add", { profileId });
        if (grant === null) return false;
        if (grant.id !== grantId) {
          if (previousMode !== DEFAULT_GRANT_MODE) await setGrantMode(grant.id, previousMode);
          await invoke("tools_grant_revoke", { grantId });
        }
        return true;
      }, false);
    },
    [profileId, modes, run],
  );

  const setMode = useCallback(
    async (grantId: string, mode: GrantMode): Promise<void> => {
      await run(async () => {
        await setGrantMode(grantId, mode);
      }, undefined);
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
    repickFolder,
    setMode,
    enableComputerWide,
    disableComputerWide,
    removeGrant,
  };
}
