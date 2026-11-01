// Workspace state shared by the composer chip and the Settings screen.
//
// The Rust core owns every decision: folders are only added through the
// native picker it opens, the whole-computer mode only after the user
// confirms the core's native warning, and every single file action the
// assistant wants is approved in another native dialog. The renderer only
// lists grants and asks for changes.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { grantErrorLabel, isComputerWide } from "./copy";
import type { GrantView } from "./types";

export interface Workspace {
  /// Private folders of the active profile (most recent last).
  folders: GrantView[];
  /// The whole-computer grant, when that mode is on.
  computerWide: GrantView | null;
  busy: boolean;
  error: string;
  clearError: () => void;
  refresh: () => Promise<void>;
  /// Opens the native folder picker; resolves true when a folder was added.
  addFolder: () => Promise<boolean>;
  /// Asks the core to enable the whole-computer mode (native confirmation).
  enableComputerWide: () => Promise<boolean>;
  /// Back to private folders only.
  disableComputerWide: () => Promise<void>;
  removeGrant: (grantId: string) => Promise<void>;
}

export function useWorkspace(profileId: string | null): Workspace {
  const [grants, setGrants] = useState<GrantView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await invoke<GrantView[]>("tools_grant_list");
      setGrants(list.filter((g) => g.profile_id === profileId));
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
        setError(grantErrorLabel(err));
        return fallback;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const addFolder = useCallback(async (): Promise<boolean> => {
    if (!profileId) return false;
    return run(async () => {
      const grant = await invoke<GrantView | null>("tools_grant_add", { profileId });
      return grant !== null;
    }, false);
  }, [profileId, run]);

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
    busy,
    error,
    clearError: () => setError(""),
    refresh,
    addFolder,
    enableComputerWide,
    disableComputerWide,
    removeGrant,
  };
}
