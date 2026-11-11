// S20: bottom-left user chip (avatar initial + account name + chevron) and
// its menu: account info, working folders, memory, language and sign out.
// The menu opens the Settings surface (round 14: a whole window whose own
// sidebar lists the sections), on the section the entry names.
// Round 14/S1: the account section also offers "Update" whenever a newer
// version exists, so closing the banner never hides the update.

import { useEffect, useRef, useState } from "react";
import { accountInitial } from "../copy";
import { isTopLayer, useEscapeLayer } from "../escapeLayers";
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
import { UpdateAction } from "./UpdateAction";

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
  /** Any update install in progress across surfaces, this menu's own
   *  included (one install at a time); the row's own guard stops re-entry. */
  busy: boolean;
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
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const layer = useEscapeLayer(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Round 14 review (F1/F2): an Escape that cancels an IME composition is
      // not a dismissal, and with several surfaces open only the innermost one
      // consumes the key (the skills form, say, keeps its draft).
      if (e.key !== "Escape" || e.isComposing) return;
      if (!isTopLayer(layer)) return;
      // Round 14 (B1): when it is the innermost surface the menu consumes
      // Escape. The capture phase runs before the Settings surface's own
      // Escape handler, whose first line checks `defaultPrevented`.
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open, layer]);

  const go = (section: SettingsTarget): void => {
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
          {update && (
            <div className="user-menu-update">
              {/* Round 14 (C6): the same row the Settings Account section
                  shows. It unmounts with the popover, so a failure from a
                  previous attempt never survives a re-open (C7). */}
              <UpdateAction
                version={update.version}
                onUpdate={update.onUpdate}
                busy={update.busy}
                menuItem
              />
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
