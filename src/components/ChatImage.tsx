// Round 7: an image in the chat with a download icon in its top-right corner
// that appears on hover (and on keyboard focus). The icon opens the same
// native Save-as dialog as the "Save as…" button below the image; the image
// itself is left untouched so its own click behaviour does not change.
// Image edits: an optional Edit icon sits just left of the download icon and
// opens the composer in edit mode with this image in the tray.

import { convertFileSrc } from "@tauri-apps/api/core";
import { useT } from "../i18n";
import { IconDownload, IconPencil } from "../icons";
import { useSaveImage, type SaveImageResult } from "./SaveImageButton";

export function ChatImage({
  path,
  alt,
  onResult,
  onEdit,
}: {
  /// Absolute path of the image (under the app's images folder).
  path: string;
  alt: string;
  onResult: (result: SaveImageResult) => void;
  /// When set, the hover actions include "Edit image".
  onEdit?: () => void;
}) {
  const t = useT();
  const { busy, save } = useSaveImage(path, onResult);

  return (
    <div className="msg-image-wrap">
      <img className="msg-image" src={convertFileSrc(path)} alt={alt} />
      {onEdit && (
        <button
          type="button"
          className="msg-image-edit"
          aria-label={t.chat.editImage}
          title={t.chat.editImage}
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          <IconPencil size={16} />
        </button>
      )}
      <button
        type="button"
        className="msg-image-download"
        aria-label={t.chat.downloadImage}
        title={t.chat.downloadImage}
        disabled={busy}
        aria-busy={busy}
        onClick={(e) => {
          // The icon sits on top of the image: never let the click reach it.
          e.stopPropagation();
          void save();
        }}
      >
        <IconDownload size={16} />
      </button>
    </div>
  );
}
