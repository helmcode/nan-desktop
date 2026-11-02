// S19: first-run language choice, shown BEFORE tenant selection. English is
// preselected; the choice is persisted by the i18n provider.

import { useState } from "react";
import { BrandLogo } from "../brand";
import { LOCALES, STRINGS, useI18n, type Locale } from "../i18n";
import { IconCheck } from "../icons";

export function LanguageScreen() {
  const { locale, setLocale } = useI18n();
  const [choice, setChoice] = useState<Locale>(locale);
  // Preview the copy in the highlighted language before confirming.
  const t = STRINGS[choice];

  return (
    <main className="center-screen" lang={choice}>
      <div className="center-card">
        <div className="brand-hero">
          <BrandLogo label={t.app.name} />
        </div>
        <h1>{t.language.title}</h1>
        <p className="lede">{t.language.lede}</p>
        <div className="choice-list" role="radiogroup" aria-label={t.language.label}>
          {LOCALES.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={choice === id}
              lang={id}
              className={`choice-card${choice === id ? " selected" : ""}`}
              onClick={() => setChoice(id)}
            >
              <span className="choice-dot" aria-hidden="true">
                {choice === id && <IconCheck size={12} />}
              </span>
              <span className="choice-text">
                <strong>{t.language.names[id]}</strong>
              </span>
            </button>
          ))}
        </div>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => setLocale(choice)}>
            {t.language.continue}
          </button>
        </div>
      </div>
    </main>
  );
}
