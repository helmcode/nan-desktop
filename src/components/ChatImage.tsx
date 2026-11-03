// Round 7: an image in the chat with a download icon in its top-right corner
// that appears on hover (and on keyboard focus). The icon opens the same
// native Save-as dialog as the "Save as…" button below the image; the image
// itself is left untouched so its own click behaviour does not change.

import { convertFileSrc } from "@tauri-apps/api/core";
import { useT } from "../i18n";
import { IconDownload } from "../icons";
import { useSaveImage, type SaveImageResult } from "./SaveImageButton";

export function ChatImage({
  path,
  alt,
  onResult,
}: {
  /// Absolute path of the image (under the app's images folder).
  path: string;
  alt: string;
  onResult: (result: SaveImageResult) => void;
}) {
  const t = useT();
  const { busy, save } = useSaveImage(path, onResult);

  return (
    <div className="msg-image-wrap">
      <img className="msg-image" src={convertFileSrc(path)} alt={alt} />
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
