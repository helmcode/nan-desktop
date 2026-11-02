import { describe, expect, it } from "vitest";
import { en } from "./en";
import { es } from "./es";
import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, persistLocale, storedLocale } from "./locale";

type Tree = { [key: string]: unknown };

function shape(node: unknown, path = ""): string[] {
  if (typeof node === "function") return [`${path}()`];
  if (typeof node === "string") return [path];
  return Object.keys(node as Tree)
    .sort()
    .flatMap((key) => shape((node as Tree)[key], path ? `${path}.${key}` : key));
}

/// Every rendered string, including function templates with sample args.
function allStrings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (typeof node === "function") {
    const fn = node as (...args: unknown[]) => unknown;
    return [String(fn("Sample", 2)), String(fn("Sample", 0))];
  }
  return Object.values(node as Tree).flatMap(allStrings);
}

describe("i18n strings (S19)", () => {
  it("es mirrors en key by key", () => {
    expect(shape(es)).toEqual(shape(en));
  });

  it("no string is empty", () => {
    for (const s of [...allStrings(en), ...allStrings(es)]) expect(s.trim().length).toBeGreaterThan(0);
  });

  it("es is actually translated where copy differs by language", () => {
    expect(es.login.title).not.toBe(en.login.title);
    expect(es.settings.title).not.toBe(en.settings.title);
    expect(es.chat.placeholder).not.toBe(en.chat.placeholder);
  });
});

describe("copy rules (S17/S18)", () => {
  it("login line is exactly the minimalist prompt", () => {
    expect(es.login.choose).toBe("Elige cómo quieres entrar:");
    expect(en.login.choose).toBe("Choose how to sign in:");
  });

  it("contains zero em dashes in en and es", () => {
    const emDash = String.fromCharCode(0x2014);
    for (const s of [...allStrings(en), ...allStrings(es)]) expect(s).not.toContain(emDash);
  });

  it("never shows the internal repo name", () => {
    for (const s of [...allStrings(en), ...allStrings(es)]) expect(s.toLowerCase()).not.toContain("nan-desktop");
  });

  it("names the product Helmcode and the window Helmcode Desktop", () => {
    for (const t of [en, es]) {
      expect(t.app.name).toBe("Helmcode");
      expect(t.app.windowTitle).toBe("Helmcode Desktop");
      expect(t.settings.about.product).toBe("Helmcode Desktop");
    }
  });

  it("offers both languages by their own names", () => {
    expect(en.language.names).toEqual({ en: "English", es: "Español" });
    expect(es.language.names).toEqual({ en: "English", es: "Español" });
  });
});

describe("locale persistence (S19)", () => {
  function memoryStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      data,
    };
  }

  it("defaults to English", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("first run has no stored locale", () => {
    expect(storedLocale(memoryStorage())).toBeNull();
  });

  it("ignores corrupted values", () => {
    expect(storedLocale(memoryStorage({ [LOCALE_STORAGE_KEY]: "fr" }))).toBeNull();
  });

  it("round-trips a choice", () => {
    const storage = memoryStorage();
    persistLocale("es", storage);
    expect(storedLocale(storage)).toBe("es");
  });
});
