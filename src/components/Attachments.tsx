// Attachment chips: the composer tray (removable, with a reading state) and
// the attachments shown in a sent user message (image thumbnails, document
// chips). Images load through the asset protocol from the core's prepared
// copy; documents are only named (their text never reaches the UI).

import { convertFileSrc } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import type { Strings } from "../i18n/en";
import type { AttachProblem } from "../chat/useComposerAttachments";
import { IconFile, IconImage, IconTable, IconX } from "../icons";
import type { AttachmentKind, MessageAttachment } from "../types";
import { formatSize, type PendingAttachment } from "../chat/attachments";

function KindIcon({ kind }: { kind: AttachmentKind }) {
  if (kind === "image") return <IconImage size={15} />;
  if (kind === "sheet") return <IconTable size={15} />;
  return <IconFile size={15} />;
}

export function AttachmentTray({
  items,
  onRemove,
  disabled,
}: {
  items: PendingAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  if (items.length === 0) return null;
  return (
    <ul className="attach-tray" aria-label={t.attachments.trayLabel}>
      {items.map((item) => {
        const reading = item.status === "reading";
        return (
          <li key={item.id} className={`attach-chip${reading ? " reading" : ""}`}>
            {item.kind === "image" && item.previewPath ? (
              <img className="attach-thumb" src={convertFileSrc(item.previewPath)} alt="" />
            ) : (
              <span className="attach-icon">
                <KindIcon kind={item.kind} />
              </span>
            )}
            <span className="attach-text">
              <span className="attach-name" title={item.name}>
                {item.name}
              </span>
              <span className="attach-meta">
                {reading ? t.attachments.reading : `${t.attachments.kinds[item.kind]} · ${formatSize(item.size, locale)}`}
              </span>
            </span>
            <button
              type="button"
              className="attach-remove"
              aria-label={t.attachments.remove(item.name)}
              title={t.attachments.remove(item.name)}
              onClick={() => onRemove(item.id)}
              disabled={disabled}
            >
              <IconX size={13} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function MessageAttachments({ attachments }: { attachments: MessageAttachment[] }) {
  const { t, locale } = useI18n();
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => a.kind === "image" && a.path);
  const files = attachments.filter((a) => !(a.kind === "image" && a.path));
  return (
    <div className="msg-attachments">
      {images.length > 0 && (
        <div className="msg-attach-images">
          {images.map((image) => (
            <img
              key={image.id}
              className="msg-attach-image"
              src={convertFileSrc(image.path ?? "")}
              alt={image.name}
              title={image.name}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <ul className="msg-attach-files" aria-label={t.attachments.sentLabel}>
          {files.map((file) => (
            <li key={file.id} className="attach-chip static">
              <span className="attach-icon">
                <KindIcon kind={file.kind} />
              </span>
              <span className="attach-text">
                <span className="attach-name" title={file.name}>
                  {file.name}
                </span>
                <span className="attach-meta">
                  {file.truncated
                    ? t.attachments.truncated
                    : `${t.attachments.kinds[file.kind]} · ${formatSize(file.size, locale)}`}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/// Plain words for an attach problem (core reason or local extraction).
export function attachProblemText(t: Strings, problem: AttachProblem): string {
  const errors = t.attachments.errors;
  const name = problem.name;
  switch (problem.reason) {
    case "too_many":
      return errors.too_many;
    case "total_too_large":
      return errors.total_too_large;
    case "too_large":
    case "unsupported":
    case "unreadable":
    case "not_allowed":
    case "read_failed":
    case "no_text":
      return name ? errors[problem.reason](name) : errors.generic;
    default:
      return errors.generic;
  }
}
