// S20: bottom-left user chip (avatar initial + account name + chevron) and
// its menu: account info, working folders, memory, language, settings and
// sign out. The Settings route stays; this menu is the entry point.

import { useEffect, useRef, useState } from "react";
import { accountInitial } from "../copy";
import { LOCALES, useI18n } from "../i18n";
import {
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconGear,
  IconGlobe,
  IconLogout,
  IconMemory,
} from "../icons";

export type SettingsSection = "folders" | "memory" | "language" | null;

export function UserMenu({
  accountName,
  accountDetail,
  onOpenSettings,
  onSignOut,
  signingOut,
}: {
  accountName: string;
  accountDetail: string;
  onOpenSettings: (section: SettingsSection) => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const { t, locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
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

  const go = (section: SettingsSection): void => {
    setOpen(false);
    onOpenSettings(section);
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
