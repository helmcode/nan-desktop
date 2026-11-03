// Round 6: "Save as…" on a generated image in the chat. The user's own
// action, not the agent's: the core opens the NATIVE save dialog and writes
// the PNG where the user picked, so no folder grant is involved. The button
// only names which generated image to save; a cancelled dialog is silent,
// success and failure are reported through `onResult` (the chat's notice).

import { useState } from "react";
import { saveImageAs } from "../core";
import { useT } from "../i18n";
import { IconDownload } from "../icons";

export type SaveImageResult = { kind: "saved"; path: string } | { kind: "failed" };

export function SaveImageButton({
  path,
  onResult,
}: {
  /// Absolute path of the generated image (under the app's images folder).
  path: string;
  onResult: (result: SaveImageResult) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await saveImageAs(path);
      if (saved) onResult({ kind: "saved", path: saved });
    } catch {
      onResult({ kind: "failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      className="msg-action"
      title={t.chat.saveImageAsLabel}
      disabled={busy}
      aria-busy={busy}
      onClick={() => void save()}
    >
      <IconDownload size={14} />
      {t.chat.saveImageAs}
    </button>
  );
}
