// Locale persistence. English is the default; a missing stored locale means
// the first-run language screen has not been completed yet (S19).

export type Locale = "en" | "es";

export const LOCALES: Locale[] = ["en", "es"];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_STORAGE_KEY = "helmcode.locale";

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "es";
}

/// The stored locale, or null on first run (or a corrupted value).
export function storedLocale(storage: Pick<Storage, "getItem"> = window.localStorage): Locale | null {
  try {
    const value = storage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export function persistLocale(
  locale: Locale,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // Storage unavailable: the choice holds for this session only.
  }
}
