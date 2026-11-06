// The "only images inside your working folders" refusal, made actionable:
// the message stays as is and one button opens Settings on the folders
// section, where the user adds the folder.

import { useT } from "../i18n";
import { IconFolder } from "../icons";

export function GrantErrorCard({ message, onOpenSettings }: { message: string; onOpenSettings: () => void }) {
  const t = useT();
  return (
    <div className="inline-error grant-error-card" role="alert">
      <p className="grant-error-text">{message}</p>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        aria-label={t.studio.openSettingsLabel}
        title={t.studio.openSettingsLabel}
        onClick={onOpenSettings}
      >
        <IconFolder size={14} />
        {t.studio.openSettings}
      </button>
    </div>
  );
}
