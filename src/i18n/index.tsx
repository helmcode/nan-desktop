// Lightweight i18n: one strings object per locale, a context, and a hook.
// No runtime library; the Strings type keeps both locales in lockstep.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { en, type Strings } from "./en";
import { es } from "./es";
import { DEFAULT_LOCALE, persistLocale, storedLocale, type Locale } from "./locale";

export type { Strings } from "./en";
export { LOCALES, DEFAULT_LOCALE, type Locale } from "./locale";

export const STRINGS: Record<Locale, Strings> = { en, es };

interface I18nValue {
  locale: Locale;
  t: Strings;
  /// True until the user picked a language once (first-run screen).
  firstRun: boolean;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  t: en,
  firstRun: false,
  setLocale: () => {},
});

export function I18nProvider({ children, initial }: { children: ReactNode; initial?: Locale | null }) {
  const [stored] = useState<Locale | null>(() => (initial !== undefined ? initial : storedLocale()));
  const [locale, setLocaleState] = useState<Locale>(stored ?? DEFAULT_LOCALE);
  const [firstRun, setFirstRun] = useState(stored === null);

  const setLocale = useCallback((next: Locale) => {
    persistLocale(next);
    setLocaleState(next);
    setFirstRun(false);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = STRINGS[locale].app.windowTitle;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({ locale, t: STRINGS[locale], firstRun, setLocale }),
    [locale, firstRun, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

export function useT(): Strings {
  return useContext(I18nContext).t;
}
