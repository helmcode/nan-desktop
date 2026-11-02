import { describe, expect, it } from "vitest";
import {
  accountInitial,
  chatErrorLabel,
  commandErrorLabel,
  folderName,
  grantErrorKind,
  grantErrorLabel,
  imageErrorLabel,
  profileTitle,
} from "./copy";
import { en } from "./i18n/en";
import { es } from "./i18n/es";

describe("copy helpers", () => {
  it("localizes profile titles with a fallback", () => {
    expect(profileTitle(es, "nan", "x")).toBe("Comunidad NaN");
    expect(profileTitle(en, "nan", "x")).toBe("NaN Community");
    expect(profileTitle(en, "other", "Other")).toBe("Other");
  });

  it("maps error kinds and never shows raw text", () => {
    expect(chatErrorLabel(en, "network")).toBe(en.chatErrors.network);
    expect(chatErrorLabel(en, "weird")).toBe(en.app.genericError);
    expect(commandErrorLabel(es, "Error: stack trace at foo")).toBe(es.app.genericError);
  });

  it("gives image errors a specific, actionable line (S23)", () => {
    expect(imageErrorLabel(en, "rate_limited")).toBe(en.imageErrors.rate_limited);
    expect(imageErrorLabel(en, "not_available")).toBe(en.imageErrors.not_available);
    expect(imageErrorLabel(en, "forbidden")).toBe(en.imageErrors.forbidden);
    expect(imageErrorLabel(en, "network")).toBe(en.chatErrors.network);
  });

  it("classifies grant errors", () => {
    expect(grantErrorKind({ kind: "scope", message: "x" })).toBe("scope");
    expect(grantErrorKind("boom")).toBe("generic");
    expect(grantErrorLabel(en, "")).toBe("");
    expect(grantErrorLabel(es, "scope")).toBe(es.grantErrors.scope);
  });

  it("derives the avatar initial", () => {
    expect(accountInitial("cristian")).toBe("C");
    expect(accountInitial("  Ángela")).toBe("Á");
    expect(accountInitial("")).toBe("?");
  });

  it("folder names", () => {
    expect(folderName("/Users/ana/Proyecto/")).toBe("Proyecto");
  });
});
