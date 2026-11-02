// S17/S18 guard: no em dash anywhere in the shipped UI sources, and no
// internal repo name in user-visible markup.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob(["./**/*.{ts,tsx,css}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const EM_DASH = String.fromCharCode(0x2014);

describe("copy rules across src/", () => {
  it("scans a meaningful set of files", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
  });

  it("contains zero em dashes", () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => text.includes(EM_DASH))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("keeps the internal repo name out of components and strings", () => {
    const offenders = Object.entries(sources)
      .filter(([file]) => file.endsWith(".tsx") || file.includes("/i18n/"))
      .filter(([, text]) => /nan-desktop/i.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
