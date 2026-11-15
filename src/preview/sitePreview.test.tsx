// @vitest-environment jsdom
// R20-D sandboxed website preview. The core alone decides a file is a
// self-contained website (the write_website marker); the pane then shows it
// in a frame sandboxed with scripts only, served from the core's own scheme
// under a no-network CSP. Every other HTML keeps the whitelist renderer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { I18nProvider } from "../i18n";
import { resetTauri } from "../test/tauriMock";
import { sandboxedSiteUrl } from "../core";
import PreviewPane from "./PreviewPane";
import { SITE_SANDBOX, SitePreview } from "./sitePreview";

const SESSION = "/private/var/folders/x/T/helmcode-desktop/abc/conversation-7";
const SITE_PATH = `${SESSION}/website-panaderia-ana.html`;
const USER_PATH = "/Users/ana/Proyecto/website-panaderia-ana.html";
const TOKEN = "0123456789abcdef0123456789abcdef";
const SITE_URL = `nan-site://localhost/${TOKEN}`;
const SITE = `<!doctype html><html><head><style>h1{color:red}</style></head>
<body><h1>Pan del día</h1><script>document.body.dataset.ran = "yes";</script></body></html>`;
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function renderPane(path: string, locale: "en" | "es" = "es") {
  return render(
    <I18nProvider initial={locale}>
      <PreviewPane target={{ kind: "file", ref: path }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("the core's flag is the only way into the sandboxed mode", () => {
  it("accepts a flagged reply with a site URL on the core's scheme", () => {
    const base = { base64: "", size: 0 };
    expect(sandboxedSiteUrl({ ...base, selfContainedWebsite: true, siteUrl: SITE_URL })).toBe(SITE_URL);
    const windows = `http://nan-site.localhost/${TOKEN}`;
    expect(sandboxedSiteUrl({ ...base, selfContainedWebsite: true, siteUrl: windows })).toBe(windows);
  });

  it("ignores a URL without the flag, the flag without a URL, and any other origin", () => {
    const base = { base64: "", size: 0 };
    expect(sandboxedSiteUrl(base)).toBeNull();
    expect(sandboxedSiteUrl({ ...base, siteUrl: SITE_URL })).toBeNull();
    expect(sandboxedSiteUrl({ ...base, selfContainedWebsite: false, siteUrl: SITE_URL })).toBeNull();
    expect(sandboxedSiteUrl({ ...base, selfContainedWebsite: true })).toBeNull();
    for (const bad of [
      "https://evil.example/x",
      "javascript:alert(1)",
      `nan-site://evil.example/${TOKEN}`,
      `http://nan-site.localhost.evil.example/${TOKEN}`,
      `nan-site://localhost/${TOKEN}/../x`,
      `data:text/html,hi`,
      `tauri://localhost/index.html`,
    ]) {
      expect(sandboxedSiteUrl({ ...base, selfContainedWebsite: true, siteUrl: bad }), bad).toBeNull();
    }
  });
});

describe("PreviewPane: gating between the sandboxed site and the whitelist", () => {
  it("shows a flagged website-*.html from the session folder in the sandboxed frame", async () => {
    resetTauri({
      preview_read_file: () => ({ base64: b64(SITE), size: SITE.length, selfContainedWebsite: true, siteUrl: SITE_URL }),
    });
    renderPane(SITE_PATH);
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    const frame = (await within(pane).findByTitle("Sitio web website-panaderia-ana.html")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(SITE_URL);
    // Scripts only: never same-origin, forms, popups or top navigation.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect((frame.getAttribute("sandbox") ?? "").split(/\s+/)).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(
      within(pane).getByText(
        "Vista previa de sitio aislado. Su código se ejecuta separado de la aplicación y sin acceso a la red.",
      ),
    ).toBeTruthy();
    // Nothing of the site runs or lands in the app's own DOM.
    expect(within(pane).queryByText("Pan del día")).toBeNull();
    expect(pane.querySelector("script, style")).toBeNull();
    expect(document.body.dataset.ran).toBeUndefined();
  });

  it("keeps the whitelist renderer for a user's own .html (no flag from the core)", async () => {
    resetTauri({ preview_read_file: () => ({ base64: b64(SITE), size: SITE.length, selfContainedWebsite: false }) });
    renderPane(USER_PATH);
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    expect(await within(pane).findByText("Pan del día")).toBeTruthy();
    expect(pane.querySelector("iframe, script, style")).toBeNull();
    expect(within(pane).queryByText(/Vista previa de sitio aislado/)).toBeNull();
  });

  it("keeps the whitelist when the reply carries a URL the frame must not load", async () => {
    resetTauri({
      preview_read_file: () => ({
        base64: b64(SITE),
        size: SITE.length,
        selfContainedWebsite: true,
        siteUrl: "https://evil.example/site",
      }),
    });
    renderPane(SITE_PATH);
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    expect(await within(pane).findByText("Pan del día")).toBeTruthy();
    expect(pane.querySelector("iframe")).toBeNull();
  });

  it("never runs a flagged non-HTML file in the frame", async () => {
    resetTauri({
      preview_read_file: () => ({ base64: b64("hola"), size: 4, selfContainedWebsite: true, siteUrl: SITE_URL }),
    });
    renderPane(`${SESSION}/website-notas.txt`);
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    await waitFor(() => expect(within(pane).getByText("hola")).toBeTruthy());
    expect(pane.querySelector("iframe")).toBeNull();
  });
});

describe("SitePreview", () => {
  it("has the English caption and frame name too", () => {
    render(
      <I18nProvider initial="en">
        <SitePreview url={SITE_URL} name="website-bakery.html" />
      </I18nProvider>,
    );
    const frame = screen.getByTitle("Website website-bakery.html");
    expect(frame.getAttribute("sandbox")).toBe(SITE_SANDBOX);
    expect(SITE_SANDBOX).toBe("allow-scripts");
    expect(screen.getByText("Isolated site preview. Its code runs apart from the app, with no network access.")).toBeTruthy();
  });
});

// The policy the frame runs under is set by the core (a response header and,
// when the document has none, an injected <meta>); keep its contract honest
// from here: nothing remote, only inline code and data: assets.
describe("the site policy (core source and app config)", () => {
  const core = readFileSync("src-tauri/src/site_preview.rs", "utf8");
  const policy = /pub const SITE_CSP: &str = "([\s\S]*?)";/.exec(core)?.[1]?.replace(/\\\n/g, "") ?? "";

  it("blocks every network load and allows only inline code and data: assets", () => {
    for (const directive of [
      "default-src 'none'",
      "script-src 'unsafe-inline' data:",
      "style-src 'unsafe-inline' data:",
      "img-src data:",
      "connect-src 'none'",
      "frame-src 'none'",
      "form-action 'none'",
    ]) {
      expect(policy).toContain(directive);
    }
    expect(policy).not.toMatch(/https?:|\*/);
  });

  it("is sent as a header with a sandbox directive, and injected as a meta only when absent", () => {
    expect(core).toContain('"Content-Security-Policy",\n            format!("{SITE_CSP}; sandbox allow-scripts")');
    expect(core).toMatch(/pub fn with_csp_meta[\s\S]*?if has_csp_meta\(html\) \{\n\s*return html\.to_string\(\);/);
  });

  it("the app lets frames load only the core's site scheme", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    for (const csp of [conf.app.security.csp, conf.app.security.devCsp] as string[]) {
      const frameSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("frame-src"));
      expect(frameSrc).toBe("frame-src nan-site: http://nan-site.localhost");
    }
  });
});
