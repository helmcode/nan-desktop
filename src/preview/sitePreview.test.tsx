// @vitest-environment jsdom
// R20-D sandboxed website preview, extended by R22 to every HTML file. The
// core alone decides the class: a self-contained website (the write_website
// marker, pinned) or a user's own HTML document (ephemeral, released on
// close). Both render in a frame sandboxed with scripts only, served from
// the core's own scheme under a no-network CSP. Non-HTML keeps its renderer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { I18nProvider } from "../i18n";
import { invokedWith, resetTauri } from "../test/tauriMock";
import { readFileWithSiteForPreview, sandboxedSiteUrl } from "../core";
import PreviewPane from "./PreviewPane";
import { SITE_SANDBOX, SitePreview } from "./sitePreview";

const SESSION = "/private/var/folders/x/T/helmcode-desktop/abc/conversation-7";
const SITE_PATH = `${SESSION}/website-panaderia-ana.html`;
const USER_PATH = "/Users/ana/Proyecto/website-panaderia-ana.html";
const TOKEN = "0123456789abcdef0123456789abcdef";
const SITE_URL = `nan-site://localhost/${TOKEN}`;
const SITE = `<!doctype html><html><head><style>h1{color:red}</style></head>
<body><h1>Pan del día</h1><script>document.body.dataset.ran = "yes";</script></body></html>`;
const DOC_TOKEN = "fedcba9876543210fedcba9876543210";
const DOC_URL = `nan-site://localhost/${DOC_TOKEN}`;
const CAPTION_ES = "Vista previa aislada: el código del sitio se ejecuta aparte de la aplicación y sin acceso a la red.";
const CAPTION_EN = "Isolated preview: the site's code runs apart from the app, with no network access.";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/// The frame contract every HTML preview shares: the core's URL, scripts
/// only (never same-origin, forms, popups or top navigation), no referrer,
/// never srcdoc (which would inherit the app's CSP instead of the site's).
function expectSandboxedFrame(frame: HTMLIFrameElement, url: string) {
  expect(frame.tagName).toBe("IFRAME");
  expect(frame.getAttribute("src")).toBe(url);
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect((frame.getAttribute("sandbox") ?? "").split(/\s+/)).not.toContain("allow-same-origin");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame.hasAttribute("srcdoc")).toBe(false);
}

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

  it("accepts a user HTML document the core registered (R22)", () => {
    const base = { base64: "", size: 0 };
    expect(sandboxedSiteUrl({ ...base, htmlDocument: true, siteUrl: DOC_URL })).toBe(DOC_URL);
    expect(sandboxedSiteUrl({ ...base, htmlDocument: false, siteUrl: DOC_URL })).toBeNull();
    expect(sandboxedSiteUrl({ ...base, htmlDocument: true, siteUrl: "https://evil.example/x" })).toBeNull();
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

describe("PreviewPane: tool websites in the sandboxed frame (unchanged)", () => {
  it("shows a flagged website-*.html from the session folder in the sandboxed frame", async () => {
    resetTauri({
      preview_read_file: () => ({ base64: b64(SITE), size: SITE.length, selfContainedWebsite: true, siteUrl: SITE_URL }),
      preview_release_site: () => null,
    });
    const { unmount } = renderPane(SITE_PATH);
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    const frame = (await within(pane).findByTitle("Sitio web website-panaderia-ana.html")) as HTMLIFrameElement;
    expectSandboxedFrame(frame, SITE_URL);
    expect(within(pane).getByText(CAPTION_ES)).toBeTruthy();
    // Nothing of the site runs or lands in the app's own DOM.
    expect(within(pane).queryByText("Pan del día")).toBeNull();
    expect(pane.querySelector("script, style")).toBeNull();
    expect(document.body.dataset.ran).toBeUndefined();
    // A tool website keeps its pinned token: closing never releases it.
    unmount();
    await Promise.resolve();
    expect(invokedWith("preview_release_site")).toEqual([]);
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

describe("PreviewPane: a user's own HTML renders for real (R22)", () => {
  const document_ = (extra: Record<string, unknown> = {}) => () => ({
    base64: b64(SITE),
    size: SITE.length,
    htmlDocument: true,
    siteUrl: DOC_URL,
    ...extra,
  });

  it("shows a user .html in the same sandboxed frame, not the whitelist text", async () => {
    resetTauri({ preview_read_file: document_(), preview_release_site: () => null });
    renderPane(USER_PATH);
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    const frame = (await within(pane).findByTitle("Sitio web website-panaderia-ana.html")) as HTMLIFrameElement;
    expectSandboxedFrame(frame, DOC_URL);
    expect(within(pane).getByText(CAPTION_ES)).toBeTruthy();
    // Not the whitelist renderer: none of the document lands in the app DOM.
    expect(within(pane).queryByText("Pan del día")).toBeNull();
    expect(pane.querySelector("script, style, h1")).toBeNull();
    expect(document.body.dataset.ran).toBeUndefined();
    expect(within(pane).queryByText(/scripts/i)).toBeNull();
  });

  it("says the same isolated-site caption in English, for .htm too", async () => {
    resetTauri({ preview_read_file: document_(), preview_release_site: () => null });
    renderPane("/Users/ana/Downloads/deepinfer_research/deepinfer.htm", "en");
    const frame = await screen.findByTitle("Website deepinfer.htm");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.getByText(CAPTION_EN)).toBeTruthy();
    expect(screen.queryByText(/Scripts do not run/)).toBeNull();
  });

  it("a website-*.html from a previous session now renders too (no scripts-off note)", async () => {
    resetTauri({ preview_read_file: document_(), preview_release_site: () => null });
    renderPane(`${SESSION}/website-de-ayer.html`);
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    expect(await within(pane).findByTitle("Sitio web website-de-ayer.html")).toBeTruthy();
    expect(within(pane).queryByText(/Los scripts no se ejecutan/)).toBeNull();
  });

  it("releases the document's ephemeral token when the preview closes, once", async () => {
    resetTauri({ preview_read_file: document_(), preview_release_site: () => null });
    const { unmount } = renderPane(USER_PATH);
    await screen.findByTitle("Sitio web website-panaderia-ana.html");
    expect(invokedWith("preview_release_site")).toEqual([]);
    unmount();
    await waitFor(() => expect(invokedWith("preview_release_site")).toEqual([{ token: DOC_TOKEN }]));
  });

  it("releases the previous document when the pane moves to another file", async () => {
    let n = 0;
    const tokens = [DOC_TOKEN, TOKEN];
    resetTauri({
      preview_read_file: () => ({
        base64: b64(SITE),
        size: SITE.length,
        htmlDocument: true,
        siteUrl: `nan-site://localhost/${tokens[n++]}`,
      }),
      preview_release_site: () => null,
    });
    const view = renderPane("/Users/ana/a.html");
    await screen.findByTitle("Sitio web a.html");
    view.rerender(
      <I18nProvider initial="es">
        <PreviewPane target={{ kind: "file", ref: "/Users/ana/b.html" }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
      </I18nProvider>,
    );
    await screen.findByTitle("Sitio web b.html");
    await waitFor(() => expect(invokedWith("preview_release_site")).toEqual([{ token: DOC_TOKEN }]));
  });

  it("releases a document whose read finished after the pane closed", async () => {
    let resolve: (value: unknown) => void = () => {};
    resetTauri({
      preview_read_file: () => new Promise((r) => (resolve = r)),
      preview_release_site: () => null,
    });
    const { unmount } = renderPane(USER_PATH);
    unmount();
    resolve(document_()());
    await waitFor(() => expect(invokedWith("preview_release_site")).toEqual([{ token: DOC_TOKEN }]));
  });

  it("a failed release is silent (the core's ring evicts it anyway)", async () => {
    resetTauri({
      preview_read_file: document_(),
      preview_release_site: () => {
        throw { kind: "io", message: "x" };
      },
    });
    const { unmount } = renderPane(USER_PATH);
    await screen.findByTitle("Sitio web website-panaderia-ana.html");
    unmount();
    await waitFor(() => expect(invokedWith("preview_release_site")).toHaveLength(1));
  });

  it("never falls back to the whitelist: a reply without a loadable URL is a failure note", async () => {
    for (const reply of [
      { htmlDocument: true, siteUrl: "https://evil.example/site" },
      { selfContainedWebsite: true, siteUrl: "https://evil.example/site" },
      { htmlDocument: true },
      {},
    ]) {
      resetTauri({ preview_read_file: () => ({ base64: b64(SITE), size: SITE.length, ...reply }) });
      renderPane(USER_PATH);
      const pane = screen.getByRole("complementary", { name: "Vista previa" });
      expect(await within(pane).findByText("No se ha podido cargar la vista previa.")).toBeTruthy();
      expect(pane.querySelector("iframe, h1, script, style")).toBeNull();
      expect(within(pane).queryByText("Pan del día")).toBeNull();
      cleanup();
    }
  });

  it("an HTML over the 8 MB cap says so (es/en), instead of a generic failure", async () => {
    resetTauri({
      preview_read_file: () => {
        throw { kind: "too_large", message: "file is larger than the 8388608-byte preview cap" };
      },
    });
    renderPane("/Users/ana/huge.html");
    expect(await screen.findByText("Este archivo supera el límite de 8 MB de la vista previa.")).toBeTruthy();
    cleanup();
    renderPane("/Users/ana/huge.html", "en");
    expect(await screen.findByText("This file is over the 8 MB preview limit.")).toBeTruthy();
  });

  it("a large HTML (the 159 KB report) comes back whole from the core read", async () => {
    let html = "<!doctype html><html><head><style>td{padding:4px}</style></head><body><table>";
    while (html.length < 200 * 1024) html += "<tr><td>deepinfer</td><td>throughput</td></tr>";
    html += "</table><p>FIN</p></body></html>";
    resetTauri({ preview_read_file: () => ({ base64: b64(html), size: html.length, htmlDocument: true, siteUrl: DOC_URL }) });
    const file = await readFileWithSiteForPreview("nan", "/Users/ana/Downloads/deepinfer.html");
    expect(file.bytes.length).toBe(html.length);
    expect(new TextDecoder().decode(file.bytes)).toBe(html);
    expect(file.siteUrl).toBe(DOC_URL);
    expect(file.releasable).toBe(true);
  });

  it("non-HTML files keep their renderers (text stays text, no frame)", async () => {
    resetTauri({ preview_read_file: () => ({ base64: b64("<h1>not a page</h1>"), size: 19 }) });
    renderPane("/Users/ana/notes.txt");
    const pane = screen.getByRole("complementary", { name: "Vista previa" });
    expect(await within(pane).findByText("<h1>not a page</h1>")).toBeTruthy();
    expect(pane.querySelector("iframe")).toBeNull();
    expect(within(pane).queryByText(CAPTION_ES)).toBeNull();
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
    expect(screen.getByText("Isolated preview: the site's code runs apart from the app, with no network access.")).toBeTruthy();
  });
});

// The policy the frame runs under is set by the core (a response header and,
// when the document has none, an injected <meta>); keep its contract honest
// from here: nothing remote, only inline code and data: assets.
describe("the site policy (core source and app config)", () => {
  const core = readFileSync("src-tauri/src/site_preview.rs", "utf8").replace(/\r\n/g, "\n");
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
