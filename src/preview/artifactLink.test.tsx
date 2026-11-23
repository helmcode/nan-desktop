// @vitest-environment jsdom
// Issue #57: a shared artifact link opened in the side panel shows the
// artifact itself (HTML in the sandboxed frame, PDF/images/text with the
// existing renderers), not the share page's metadata as text. Only the two
// tenants' artifact hosts with an exact /a/<token> path take this path;
// every other URL keeps the generic web preview.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { I18nProvider } from "../i18n";
import { invokedWith, resetTauri } from "../test/tauriMock";
import PreviewPane from "./PreviewPane";
import { isArtifactShareUrl } from "./kind";
import { artifactSiteUrl } from "../core";
import { SITE_SANDBOX } from "./sitePreview";

const TOKEN = "Zk3d9QpL2xVb7Nw4Rt6Ys1Ue8Ia0Oc5Hj2Kl4Mn6Pq";
const NAN_LINK = `https://artifacts.nan.builders/a/${TOKEN}`;
const HELMCODE_LINK = `https://artifacts.helmcode.com/a/${TOKEN}`;
const SITE = "nan-site://localhost/0123456789abcdef0123456789abcdef";

function renderPane(url: string, locale: "en" | "es" = "en") {
  return render(
    <I18nProvider initial={locale}>
      <PreviewPane target={{ kind: "web", ref: url }} profileId="nan" onClose={() => {}} onOpenLink={() => {}} />
    </I18nProvider>,
  );
}

afterEach(cleanup);

describe("isArtifactShareUrl", () => {
  it("matches only the two artifact hosts with an exact /a/<token> path over https", () => {
    expect(isArtifactShareUrl(NAN_LINK)).toBe(true);
    expect(isArtifactShareUrl(HELMCODE_LINK)).toBe(true);
    expect(isArtifactShareUrl(`${NAN_LINK}?e=grant#top`)).toBe(true);
    expect(isArtifactShareUrl(`HTTPS://Artifacts.Nan.Builders/a/${TOKEN}`)).toBe(true);
    for (const url of [
      `http://artifacts.nan.builders/a/${TOKEN}`,
      `https://artifacts.nan.builders:443/a/${TOKEN}`,
      `https://user@artifacts.nan.builders/a/${TOKEN}`,
      `https://evil.artifacts.nan.builders/a/${TOKEN}`,
      `https://artifacts.nan.builders.evil.com/a/${TOKEN}`,
      `https://cloud.nan.builders/a/${TOKEN}`,
      `https://artifacts.nan.builders/c/${TOKEN}`,
      `https://artifacts.nan.builders/a/${TOKEN}/`,
      `https://artifacts.nan.builders/a/${TOKEN}/x`,
      "https://artifacts.nan.builders/a/short",
      "https://artifacts.nan.builders/",
      "https://example.com/a/" + TOKEN,
      "",
    ]) {
      expect(isArtifactShareUrl(url), url).toBe(false);
    }
  });
});

describe("artifactSiteUrl", () => {
  it("accepts only the core's sandboxed scheme for HTML artifacts", () => {
    expect(artifactSiteUrl({ kind: "html", size: 1, siteUrl: SITE })).toBe(SITE);
    expect(artifactSiteUrl({ kind: "html", size: 1, siteUrl: "https://artifacts.nan.builders/c/x" })).toBeNull();
    expect(artifactSiteUrl({ kind: "pdf", size: 1, siteUrl: SITE })).toBeNull();
    expect(artifactSiteUrl({ kind: "html", size: 1 })).toBeNull();
  });
});

describe("PreviewPane: shared artifact links (#57)", () => {
  it("renders an HTML artifact in the sandboxed frame and releases it on close", async () => {
    resetTauri({
      artifact_link_preview: () => ({ kind: "html", title: "Calculadora", filename: "calc.html", size: 10, siteUrl: SITE }),
      preview_release_site: () => null,
    });
    const view = renderPane(NAN_LINK);
    const frame = (await screen.findByTitle("Website Calculadora")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe(SITE);
    expect(frame.getAttribute("sandbox")).toBe(SITE_SANDBOX);
    expect(invokedWith("artifact_link_preview")).toEqual([{ url: NAN_LINK }]);
    // Never the generic text fetch of the share page.
    expect(invokedWith("web_preview_fetch")).toEqual([]);
    // The frame fills the pane: a direct child of the preview body.
    expect(frame.closest("figure")?.parentElement?.className).toBe("preview-body");
    view.unmount();
    await waitFor(() => expect(invokedWith("preview_release_site")).toEqual([{ token: SITE.split("/").pop() }]));
  });

  it("renders a markdown artifact from its bytes (Helmcode host too)", async () => {
    resetTauri({
      artifact_link_preview: () => ({
        kind: "markdown",
        title: "Notas",
        filename: "notas.md",
        size: 12,
        base64: btoa("# Hola mundo"),
      }),
    });
    renderPane(HELMCODE_LINK);
    expect(await screen.findByRole("heading", { name: "Hola mundo" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Notas" })).toBeTruthy();
    expect(invokedWith("artifact_link_preview")).toEqual([{ url: HELMCODE_LINK }]);
  });

  it("never frames an HTML reply without a sandboxed site URL", async () => {
    resetTauri({
      artifact_link_preview: () => ({ kind: "html", title: "X", size: 1, siteUrl: "https://evil.example/" }),
    });
    renderPane(NAN_LINK);
    expect(await screen.findByText("This shared file cannot be shown here. Open it in your browser.")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("falls back to opening the link in the browser when the file is restricted", async () => {
    resetTauri({
      artifact_link_preview: () => {
        throw { kind: "restricted", message: "x" };
      },
      open_external: () => null,
    });
    renderPane(NAN_LINK, "es");
    expect(await screen.findByText("Este archivo compartido no se puede mostrar aquí. Ábrelo en tu navegador.")).toBeTruthy();
    const open = screen.getAllByRole("button", { name: "Abrir en el navegador" });
    fireEvent.click(open[open.length - 1]);
    await waitFor(() => expect(invokedWith("open_external")).toEqual([{ url: NAN_LINK }]));
  });

  it("says when the link is gone", async () => {
    resetTauri({
      artifact_link_preview: () => {
        throw { kind: "not_found", message: "x" };
      },
    });
    renderPane(NAN_LINK);
    expect(await screen.findByText("This shared link is not available. It may have expired or been removed.")).toBeTruthy();
  });

  it("keeps the generic web preview for every other URL", async () => {
    resetTauri({
      web_preview_fetch: () => ({ url: "https://example.com/a", title: "Example", content_type: "text/html", text: "hello" }),
    });
    renderPane(`https://example.com/a/${TOKEN}`);
    expect(await screen.findByText("hello")).toBeTruthy();
    expect(invokedWith("artifact_link_preview")).toEqual([]);
  });
});
