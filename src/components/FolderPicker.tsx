// Composer folder picker: which working folders THIS conversation may use.
// Multi-select (none, some or all; a new conversation starts with none),
// plus the profile-level actions: add a folder through the native picker,
// whole-computer mode and Settings. The selection is a renderer preference
// sent with each message; the Rust core enforces it.

import { useEffect, useRef, useState } from "react";
import { allFolders, isAllSelected, pruneSelection, toggleFolder } from "../chat/folderSelection";
import { folderName } from "../copy";
import { useT } from "../i18n";
import { IconCheck, IconChevronDown, IconComputer, IconFolder, IconGear, IconPlus, IconWarning } from "../icons";
import type { Workspace } from "../workspace";

export function FolderPicker({
  workspace,
  selected,
  onChange,
  onAskComputerWide,
  onOpenSettings,
}: {
  workspace: Workspace;
  /// Selected grant ids of the open conversation.
  selected: string[];
  onChange: (grantIds: string[]) => void;
  onAskComputerWide: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const folders = workspace.folders;
  const wide = workspace.computerWide !== null;
  const noGrants = !wide && folders.length === 0;
  const chosen = pruneSelection(selected, folders);
  const chosenGrants = folders.filter((grant) => chosen.includes(grant.id));
  const [first, ...rest] = chosenGrants;
  const label = wide
    ? t.workspace.computerWide
    : noGrants
      ? t.workspace.pickFolder
      : first
        ? t.workspace.folderLabel(folderName(first.canonical_path), rest.length)
        : t.workspace.noFolder;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = async (action: () => Promise<unknown> | void): Promise<void> => {
    setOpen(false);
    await action();
  };

  // A folder the user adds from the chat is meant for this chat: select it.
  const addAndSelect = async (): Promise<void> => {
    const grant = await workspace.pickFolder();
    if (grant && !chosen.includes(grant.id)) onChange([...chosen, grant.id]);
  };

  const noneSelected = chosen.length === 0;
  const allSelected = isAllSelected(chosen, folders);

  return (
    <div className="ws" ref={rootRef}>
      <button
        type="button"
        className={`ws-chip${wide ? " ws-chip-wide" : ""}${noGrants || (noneSelected && !wide) ? " ws-chip-empty" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t.workspace.chipTitle}
        onClick={() => {
          if (noGrants) {
            void addAndSelect();
          } else {
            setOpen((value) => !value);
          }
        }}
        disabled={workspace.busy}
      >
        {wide ? <IconWarning size={15} /> : noGrants ? <IconPlus size={15} /> : <IconFolder size={15} />}
        <span className="ws-chip-label">{label}</span>
        {!noGrants && <IconChevronDown size={14} />}
      </button>
      {open && (
        <div className="ws-menu" role="menu" aria-label={t.workspace.menuLabel}>
          <p className="ws-menu-heading">{t.workspace.selectionHeading}</p>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={noneSelected}
            className="ws-menu-item"
            onClick={() => onChange([])}
          >
            <span className="ws-menu-text">{t.workspace.none}</span>
            {noneSelected && <IconCheck size={14} />}
          </button>
          {folders.length > 1 && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={allSelected}
              className="ws-menu-item"
              onClick={() => onChange(allFolders(folders))}
            >
              <span className="ws-menu-text">{t.workspace.all}</span>
              {allSelected && <IconCheck size={14} />}
            </button>
          )}
          {folders.map((grant) => {
            const checked = chosen.includes(grant.id);
            return (
              <button
                key={grant.id}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                className="ws-menu-item"
                title={grant.canonical_path}
                onClick={() => onChange(toggleFolder(chosen, grant.id))}
              >
                <IconFolder size={15} />
                <span className="ws-menu-text">{folderName(grant.canonical_path)}</span>
                {checked && <IconCheck size={14} />}
              </button>
            );
          })}
          {noneSelected && !wide && <p className="ws-menu-hint">{t.workspace.noneHint}</p>}
          <button type="button" role="menuitem" className="ws-menu-item" onClick={() => void close(addAndSelect)}>
            <IconPlus size={15} />
            <span className="ws-menu-text">{t.workspace.addFolder}</span>
          </button>
          <div className="ws-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={wide}
            className="ws-menu-item ws-menu-item-wide"
            onClick={() => void close(() => (wide ? workspace.disableComputerWide() : onAskComputerWide()))}
          >
            <IconComputer size={15} />
            <span className="ws-menu-text">{t.workspace.computerWide}</span>
            {wide && <IconCheck size={14} />}
          </button>
          <div className="ws-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="ws-menu-item ws-menu-item-muted" onClick={() => void close(onOpenSettings)}>
            <IconGear size={15} />
            <span className="ws-menu-text">{t.workspace.manage}</span>
          </button>
        </div>
      )}
    </div>
  );
}
