// Composer edit mode: the reference tray. Shows the 1..3 images the edit
// starts from as removable thumbnails, an "Add image" button (native file
// picker opened by the core, through the folder grants) and a close button.
// Thumbnails load through the asset protocol; the bytes never cross IPC.

import { convertFileSrc } from "@tauri-apps/api/core";
import { MAX_EDIT_IMAGES, type EditSource } from "../chat/editTray";
import { useT } from "../i18n";
import { IconPlus, IconX } from "../icons";

export function EditTray({
  sources,
  adding,
  disabled,
  onAdd,
  onRemove,
  onClose,
}: {
  sources: readonly EditSource[];
  adding: boolean;
  disabled: boolean;
  onAdd: () => void;
  onRemove: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const full = sources.length >= MAX_EDIT_IMAGES;
  return (
    <div className="edit-tray" role="group" aria-label={t.chat.editTrayLabel}>
      <ul className="edit-tray-list">
        {sources.map((source, index) => (
          <li key={source.path} className="edit-thumb">
            <img src={convertFileSrc(source.path)} alt={source.label} />
            <button
              type="button"
              className="edit-thumb-remove"
              aria-label={t.chat.removeEditImage(index + 1)}
              title={t.chat.removeEditImage(index + 1)}
              onClick={() => onRemove(source.path)}
              disabled={disabled}
            >
              <IconX size={12} />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn btn-ghost btn-sm edit-tray-add"
        onClick={onAdd}
        disabled={disabled || adding || full}
        aria-busy={adding}
      >
        <IconPlus size={14} />
        {t.chat.addEditImage}
      </button>
      <span className="edit-tray-count">{t.chat.editCount(sources.length, MAX_EDIT_IMAGES)}</span>
      <button
        type="button"
        className="icon-btn edit-tray-close"
        aria-label={t.chat.exitEdit}
        title={t.chat.exitEdit}
        onClick={onClose}
        disabled={disabled}
      >
        <IconX size={16} />
      </button>
    </div>
  );
}
