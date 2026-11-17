// @vitest-environment jsdom
//
// R22: the Account section offers two community links (star the repository,
// report an issue). Both carry their real href (visible on hover, readable by
// assistive tech) but never navigate the main window: a click goes through
// the same open_external core command every other surface uses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import { Settings } from "./Settings";
import { REPOSITORY_URL, REPORT_ISSUE_URL, TELEMETRY_DOCS_URL } from "./communityLinks";
import { I18nProvider } from "./i18n";
import { en } from "./i18n/en";
import { es } from "./i18n/es";
import type { Locale } from "./i18n/locale";
import type { Workspace } from "./workspace";

const workspace: Workspace = {
  folders: [],
  computerWide: null,
  modes: {},
  busy: false,
  error: null,
  clearError: () => {},
  refresh: async () => {},
  addFolder: async () => false,
  pickFolder: async () => null,
  repickFolder: async () => false,
  setMode: async () => null,
  enableComputerWide: async () => false,
} as unknown as Workspace;

function renderAccount(locale: Locale) {
  return render(
    <I18nProvider initial={locale}>
      <Settings
        profile={undefined}
        workspace={workspace}
        voice="ef_dora"
        onVoiceChange={() => {}}
        onAskComputerWide={() => {}}
        onBack={() => {}}
        onSignOut={() => {}}
        signingOut={false}
        focusSection={null}
      />
    </I18nProvider>,
  );
}

beforeEach(() => {
  resetTauri({
    tools_settings_get: () => ({ tools_allow_run_command: true }),
    memory_settings_get: () => ({ mode: "remote" }),
    app_info: () => ({ version: "0.2.11" }),
    open_external: () => null,
  });
});

afterEach(cleanup);

describe("community link targets", () => {
  it("point at the public repository and its new-issue form", () => {
    expect(REPOSITORY_URL).toBe("https://github.com/helmcode/nan-desktop");
    expect(REPORT_ISSUE_URL).toBe("https://github.com/helmcode/nan-desktop/issues/new");
  });
});

describe.each([
  ["en", en],
  ["es", es],
] as const)("Account community links (%s)", (locale, strings) => {
  it("renders both links with their hrefs inside the Account section", () => {
    renderAccount(locale);
    const section = screen.getByRole("region", { name: strings.settings.about.title });
    const star = screen.getByRole("link", { name: strings.settings.about.starRepo });
    const issue = screen.getByRole("link", { name: strings.settings.about.reportIssue });
    expect(section.contains(star)).toBe(true);
    expect(section.contains(issue)).toBe(true);
    expect(star.getAttribute("href")).toBe(REPOSITORY_URL);
    expect(issue.getAttribute("href")).toBe(REPORT_ISSUE_URL);
    // Each link carries a decorative icon, hidden from assistive tech.
    for (const link of [star, issue]) {
      const svg = link.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("opens the star link in the system browser, never in the window", async () => {
    renderAccount(locale);
    const star = screen.getByRole("link", { name: strings.settings.about.starRepo });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    star.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await waitFor(() => expect(invokedWith("open_external")).toEqual([{ url: REPOSITORY_URL }]));
  });

  it("opens the report link in the system browser, never in the window", async () => {
    renderAccount(locale);
    fireEvent.click(screen.getByRole("link", { name: strings.settings.about.reportIssue }));
    await waitFor(() => expect(invokedWith("open_external")).toEqual([{ url: REPORT_ISSUE_URL }]));
  });
});

describe("community link copy", () => {
  it("uses the agreed wording in both languages", () => {
    expect(en.settings.about.starRepo).toBe("Star on GitHub");
    expect(en.settings.about.reportIssue).toBe("Report an issue");
    expect(es.settings.about.starRepo).toBe("Dar una estrella en GitHub");
    expect(es.settings.about.reportIssue).toBe("Reportar una incidencia");
  });

  it("keeps Spanish free of anglicisms and both free of em dashes", () => {
    const emDash = String.fromCharCode(0x2014);
    const spanish = [es.settings.about.starRepo, es.settings.about.reportIssue];
    for (const s of spanish) {
      expect(s.toLowerCase()).not.toMatch(/\b(star|issue|report|bug|link)\b/);
    }
    for (const s of [...spanish, en.settings.about.starRepo, en.settings.about.reportIssue]) {
      expect(s).not.toContain(emDash);
    }
  });
});

// Telemetry is always on (owner decision): the Account section says so in
// one plain line, with no toggle anywhere.
describe.each([
  ["en", en],
  ["es", es],
] as const)("Account telemetry notice (%s)", (locale, strings) => {
  it("states what is sent inside the Account section, without a switch", () => {
    renderAccount(locale);
    const section = screen.getByRole("region", { name: strings.settings.about.title });
    const notice = screen.getByText(strings.settings.about.telemetry);
    expect(section.contains(notice)).toBe(true);
    expect(section.querySelector('input[type="checkbox"], [role="switch"]')).toBeNull();
  });

  it("links the details to the public telemetry docs, opened outside the window", async () => {
    renderAccount(locale);
    const section = screen.getByRole("region", { name: strings.settings.about.title });
    const details = screen.getByRole("link", { name: strings.settings.about.telemetryDetailsLabel });
    // The visible text stays short; the accessible name says what it is about.
    expect(details.textContent).toBe(strings.settings.about.telemetryDetails);
    expect(section.contains(details)).toBe(true);
    expect(details.getAttribute("href")).toBe(TELEMETRY_DOCS_URL);
    expect(details.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // The notice and its link sit together in their own block.
    const notice = screen.getByText(strings.settings.about.telemetry);
    expect(notice.parentElement?.classList.contains("about-telemetry")).toBe(true);
    expect(notice.parentElement?.contains(details)).toBe(true);
    fireEvent.click(details);
    await waitFor(() => expect(invokedWith("open_external")).toEqual([{ url: TELEMETRY_DOCS_URL }]));
  });
});

describe("telemetry notice copy", () => {
  it("uses the agreed wording and the copy rules", () => {
    expect(es.settings.about.telemetry).toBe(
      "Para corregir errores, la app envía a tu plataforma datos técnicos de uso asociados a tu cuenta (nunca tus conversaciones ni tus archivos).",
    );
    expect(en.settings.about.telemetry).toBe(
      "To fix bugs, the app sends technical usage data linked to your account to your platform (never your conversations or your files).",
    );
    expect(es.settings.about.telemetryDetails).toBe("Más detalles");
    expect(es.settings.about.telemetryDetailsLabel).toBe("Más detalles sobre los datos técnicos que se envían");
    expect(en.settings.about.telemetryDetailsLabel).toBe("More details about the technical data that is sent");
    expect(en.settings.about.telemetryDetails).toBe("More details");
    expect(TELEMETRY_DOCS_URL).toBe(
      "https://github.com/helmcode/nan-desktop/blob/main/SECURITY.md#telemetry-what-the-app-sends",
    );
    expect(es.settings.about.telemetry.toLowerCase()).not.toMatch(/\b(telemetr\w*|tracking|bug|data)\b/);
    for (const s of [
      es.settings.about.telemetry,
      en.settings.about.telemetry,
      es.settings.about.telemetryDetails,
      en.settings.about.telemetryDetails,
      es.settings.about.telemetryDetailsLabel,
      en.settings.about.telemetryDetailsLabel,
    ]) {
      expect(s).not.toContain(String.fromCharCode(0x2014));
    }
  });
});
