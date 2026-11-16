// "Preguntar siempre" / "Permitir sin preguntar" radio pair, shared by the
// folder cards, the whole-computer card and the whole-computer dialog. The
// allow option carries the warning tone; the core confirms it natively.

import type { GrantMode } from "../core";
import { useI18n } from "../i18n";

export function ModeSwitch({
  label,
  value,
  onChange,
  disabled,
  showLabel = false,
}: {
  label: string;
  value: GrantMode;
  onChange: (mode: GrantMode) => void;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const { t } = useI18n();
  const options: Array<{ id: GrantMode; text: string }> = [
    { id: "ask", text: t.settings.folders.modeAsk },
    { id: "allow", text: t.settings.folders.modeAllow },
  ];
  return (
    <div className="mode-switch-wrap">
      {showLabel && <span className="mode-switch-label">{label}</span>}
      <div className="mode-switch" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={`mode-option${value === option.id ? " selected" : ""}${option.id === "allow" ? " allow" : ""}`}
            onClick={() => value !== option.id && onChange(option.id)}
            disabled={disabled}
          >
            {option.text}
          </button>
        ))}
      </div>
    </div>
  );
}
