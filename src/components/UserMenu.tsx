// S20: bottom-left user chip (avatar initial + account name + chevron) and
// its menu: account info, working folders, memory, language and sign out.
// The menu opens the Settings surface (round 14: a whole window whose own
// sidebar lists the sections), on the section the entry names.
// Round 14/S1: the account section also offers "Update" whenever a newer
// version exists, so closing the banner never hides the update.

import { useEffect, useRef, useState } from "react";
import { accountInitial } from "../copy";
import { LOCALES, useI18n } from "../i18n";
import {
  IconCheck,
  IconDownload,
  IconChevronDown,
  IconFolder,
  IconGear,
  IconGlobe,
  IconLogout,
  IconMemory,
} from "../icons";

/** One of the sections the Settings surface shows (its sidebar lists them). */
export type SettingsPane = "account" | "folders" | "memory" | "language" | "skills";

/** A section to open: a pane, or null for the first one (Account). */
export type SettingsSection = SettingsPane | null;

/** What an account-menu entry asks for: one of the sections it names, or
 *  null for the first one (Account). */
export type SettingsTarget = Exclude<SettingsPane, "skills"> | null;

/** The newer version the updater found: the same check the banner reads. */
export type UserMenuUpdate = {
  version: string;
  /** The banner's install flow: download, verify, install, relaunch. */
  onUpdate: () => Promise<void>;
};

export function UserMenu({
  accountName,
  accountDetail,
  update = null,
  onOpenSettings,
  onSignOut,
  signingOut,
}: {
  accountName: string;
  accountDetail: string;
  update?: UserMenuUpdate | null;
  onOpenSettings: (section: SettingsTarget) => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateFailed, setUpdateFailed] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (section: SettingsTarget): void => {
    setOpen(false);
    onOpenSettings(section);
  };

  const startUpdate = async (): Promise<void> => {
    if (!update || updating) return;
    setUpdating(true);
    setUpdateFailed(false);
    try {
      // On success the app installs and relaunches; the menu goes away.
      await update.onUpdate();
    } catch {
      setUpdating(false);
      setUpdateFailed(true);
    }
  };

  return (
    <div className="user-menu" ref={rootRef}>
      {open && (
        <div className="user-menu-pop" role="menu" aria-label={t.userMenu.open}>
          <div className="user-menu-account">
            <span className="avatar avatar-lg" aria-hidden="true">
              {accountInitial(accountName)}
            </span>
            <span className="user-menu-account-text">
              <strong>{accountName}</strong>
              <span>{accountDetail}</span>
            </span>
          </div>
          {update && (
            <div className="user-menu-update">
              <button
                type="button"
                role="menuitem"
                className="btn btn-primary btn-sm"
                title={t.updater.available(update.version)}
                disabled={updating}
                aria-busy={updating}
                onClick={() => void startUpdate()}
              >
                <IconDownload size={14} />
                {updating ? t.updater.updating : t.updater.update}
              </button>
              {updateFailed && (
                <p className="user-menu-update-error" role="alert">
                  {t.updater.failed}
                </p>
              )}
            </div>
          )}
          <div className="ws-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="ws-menu-item" onClick={() => go("folders")}>
            <IconFolder size={15} />
            <span className="ws-menu-text">{t.userMenu.workingFolders}</span>
          </button>
          <button type="button" role="menuitem" className="ws-menu-item" onClick={() => go("memory")}>
            <IconMemory size={15} />
            <span className="ws-menu-text">{t.userMenu.memory}</span>
          </button>
          <p className="ws-menu-heading">
            <IconGlobe size={13} /> {t.userMenu.language}
          </p>
          {LOCALES.map((id) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={locale === id}
              lang={id}
              className="ws-menu-item"
              onClick={() => setLocale(id)}
            >
              <span className="ws-menu-text">{t.language.names[id]}</span>
              {locale === id && <IconCheck size={14} />}
            </button>
          ))}
          <div className="ws-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="ws-menu-item" onClick={() => go(null)}>
            <IconGear size={15} />
            <span className="ws-menu-text">{t.userMenu.settings}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="ws-menu-item ws-menu-item-danger"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            disabled={signingOut}
          >
            <IconLogout size={15} />
            <span className="ws-menu-text">{t.userMenu.signOut}</span>
          </button>
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="user-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t.userMenu.open}: ${accountName}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="avatar" aria-hidden="true">
          {accountInitial(accountName)}
        </span>
        <span className="user-chip-name">{accountName}</span>
        <IconChevronDown size={14} />
      </button>
    </div>
  );
}
