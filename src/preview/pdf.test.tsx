// @vitest-environment jsdom
// Continuous PDF preview: every page stacked in one vertical scroll at the
// pane width, painted lazily, with a sticky current-page label.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const pdf = vi.hoisted(() => ({
  numPages: 13,
  pageSize: { width: 960, height: 540 },
  getPage: vi.fn(),
  render: vi.fn(),
  destroy: vi.fn(),
  fail: false,
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: pdf.fail
      ? Promise.reject(new Error("bad pdf"))
      : Promise.resolve({ numPages: pdf.numPages, getPage: pdf.getPage, destroy: pdf.destroy }),
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.js" }));
vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());

import { I18nProvider } from "../i18n";
import { currentPdfPage, PDF_MAX_PAGE_WIDTH, PdfPreview, pdfRenderScale } from "./renderers";

function wrap(children: ReactNode, locale: "en" | "es" = "en") {
  return <I18nProvider initial={locale}>{children}</I18nProvider>;
}

const ctx = {} as CanvasRenderingContext2D;

beforeEach(() => {
  pdf.numPages = 13;
  pdf.fail = false;
  pdf.getPage.mockReset().mockImplementation(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: pdf.pageSize.width * scale, height: pdf.pageSize.height * scale }),
    render: (params: unknown) => {
      pdf.render(params);
      return { promise: Promise.resolve() };
    },
  }));
  pdf.render.mockReset();
  pdf.destroy.mockReset().mockResolvedValue(undefined);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pdfRenderScale", () => {
  it("draws the page at the pane width times the pixel ratio", () => {
    expect(pdfRenderScale(500, 600, 1)).toBeCloseTo(600 / 500);
    expect(pdfRenderScale(500, 600, 2)).toBeCloseTo(1200 / 500);
  });

  it("caps the width, keeps a sharp floor and bounds the pixel ratio", () => {
    expect(pdfRenderScale(1000, 4000, 1)).toBeCloseTo(PDF_MAX_PAGE_WIDTH / 1000);
    expect(pdfRenderScale(480, 100, 1)).toBeCloseTo(1);
    expect(pdfRenderScale(480, 0, 1)).toBeCloseTo(1);
    expect(pdfRenderScale(500, 500, 3)).toBeCloseTo(2);
    expect(pdfRenderScale(500, 500, 0)).toBeCloseTo(1);
    expect(pdfRenderScale(0, 500, 1)).toBe(1);
  });
});

describe("currentPdfPage", () => {
  it("is the last page whose top crossed 40% of the scroll area", () => {
    // The line sits at viewTop + 40% of the height.
    expect(currentPdfPage([0, 500, 1000, 1500], 0, 1000)).toBe(1);
    expect(currentPdfPage([0, 400, 800], 0, 1000)).toBe(2);
    expect(currentPdfPage([100, 600, 1100], 100, 1000)).toBe(1);
    expect(currentPdfPage([10, 500, 1000], 0, 1000)).toBe(1);
    expect(currentPdfPage([-900, -400, 300, 900], 0, 1000)).toBe(3);
    expect(currentPdfPage([-3000, -2500, -2000], 0, 1000)).toBe(3);
    expect(currentPdfPage([], 0, 1000)).toBe(1);
  });
});

describe("PdfPreview (continuous scroll)", () => {
  it("stacks every page vertically, each a labelled fit-width canvas, with no pager", async () => {
    const { container } = render(wrap(<PdfPreview bytes={new Uint8Array([1, 2, 3])} />));
    const doc = await screen.findByRole("group", { name: "PDF document, 13 pages" });
    const pages = doc.querySelectorAll(".preview-pdf-page");
    expect(pages).toHaveLength(13);
    pages.forEach((page, i) => {
      expect(page.getAttribute("data-page")).toBe(String(i + 1));
      // The box keeps the page's aspect ratio before it is painted.
      expect((page as HTMLElement).style.aspectRatio).toBe(String(960 / 540));
      const canvas = page.querySelector("canvas");
      expect(canvas?.classList.contains("preview-pdf-canvas")).toBe(true);
    });
    expect(screen.getByRole("img", { name: "Page 1 of 13" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Page 13 of 13" })).toBeTruthy();
    // Previous/Next are gone in favour of scrolling.
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(container.querySelector(".preview-pager")).toBeNull();
    // Every page gets painted (no IntersectionObserver in jsdom: eager).
    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(13));
    expect(new Set(pdf.getPage.mock.calls.map((call) => call[0]))).toEqual(new Set(Array.from({ length: 13 }, (_, i) => i + 1)));
  });

  it("paints a page only once it nears the visible area", async () => {
    const observers: { cb: IntersectionObserverCallback; targets: Element[]; options?: IntersectionObserverInit }[] = [];
    class FakeObserver {
      targets: Element[] = [];
      constructor(
        public cb: IntersectionObserverCallback,
        public options?: IntersectionObserverInit,
      ) {
        observers.push(this);
      }
      observe(el: Element) {
        this.targets.push(el);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    render(wrap(<PdfPreview bytes={new Uint8Array([1])} />));
    await screen.findByRole("group", { name: "PDF document, 13 pages" });
    expect(observers).toHaveLength(13);
    expect(observers[0].options?.rootMargin).toMatch(/px/);
    expect(pdf.render).not.toHaveBeenCalled();

    const near = (i: number) =>
      act(async () => {
        observers[i].cb([{ isIntersecting: true, target: observers[i].targets[0] } as IntersectionObserverEntry], observers[i] as never);
      });
    await near(0);
    await near(1);
    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(2));
    expect(pdf.getPage.mock.calls.map((call) => call[0])).toEqual(expect.arrayContaining([1, 2]));
    expect(pdf.getPage.mock.calls.map((call) => call[0])).not.toContain(7);
  });

  it("sizes each canvas from the pane width and paints it with pdf.js", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.stubGlobal("devicePixelRatio", 2);
    pdf.numPages = 1;
    render(wrap(<PdfPreview bytes={new Uint8Array([1])} />));
    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(1));
    const canvas = screen.getByRole("img", { name: "Page 1 of 1" }) as HTMLCanvasElement;
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(Math.floor(540 * (1200 / 960)));
    const params = pdf.render.mock.calls[0][0] as { canvas: HTMLCanvasElement; canvasContext: unknown };
    expect(params.canvas).toBe(canvas);
    expect(params.canvasContext).toBe(ctx);
  });

  it("tracks the current page as the pane scrolls (single page: no label)", async () => {
    const { unmount } = render(
      wrap(
        <div className="preview-body">
          <PdfPreview bytes={new Uint8Array([1])} />
        </div>,
      ),
    );
    await screen.findByRole("group", { name: "PDF document, 13 pages" });
    const area = document.querySelector(".preview-body") as HTMLElement;
    const label = document.querySelector(".preview-pdf-indicator") as HTMLElement;
    expect(label.textContent).toBe("Page 1 of 13");
    expect(label.getAttribute("aria-hidden")).toBe("true");

    // Page n's top sits at (n - 1) * 500 - scrolled; the area is 1000 high.
    let scrolled = 0;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const page = Number(this.getAttribute("data-page") ?? 0);
      const top = page ? (page - 1) * 500 - scrolled : 0;
      return { top, height: page ? 500 : 1000, bottom: top + 500, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} } as DOMRect;
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    scrolled = 2600; // page 6 top at -100, page 7 at 400 (= the 40% line)
    fireEvent.scroll(area);
    await waitFor(() => expect(label.textContent).toBe("Page 7 of 13"));
    unmount();

    pdf.numPages = 1;
    render(wrap(<PdfPreview bytes={new Uint8Array([2])} />));
    await screen.findByRole("group", { name: "PDF document, 1 page" });
    expect(document.querySelector(".preview-pdf-indicator")).toBeNull();
  });

  it("speaks Spanish", async () => {
    render(wrap(<PdfPreview bytes={new Uint8Array([1])} />, "es"));
    await screen.findByRole("group", { name: "Documento PDF, 13 páginas" });
    expect(screen.getByRole("img", { name: "Página 4 de 13" })).toBeTruthy();
  });

  it("falls back to the failure note when the PDF cannot be read", async () => {
    pdf.fail = true;
    render(wrap(<PdfPreview bytes={new Uint8Array([1])} />));
    expect(await screen.findByText("Could not load the preview.")).toBeTruthy();
  });

  it("lets each page box adopt its own aspect ratio once painted (mixed portrait + landscape)", async () => {
    // Page 1 is portrait (it sizes every placeholder), page 2 landscape,
    // page 3 portrait again.
    const sizes: Record<number, { width: number; height: number }> = {
      1: { width: 600, height: 800 },
      2: { width: 960, height: 540 },
      3: { width: 500, height: 1000 },
    };
    pdf.numPages = 3;
    pdf.getPage.mockImplementation(async (n: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: sizes[n].width * scale, height: sizes[n].height * scale }),
      render: (params: unknown) => {
        pdf.render(params);
        return { promise: Promise.resolve() };
      },
    }));
    render(wrap(<PdfPreview bytes={new Uint8Array([1])} />));
    await screen.findByRole("group", { name: "PDF document, 3 pages" });
    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(3));
    const box = (n: number) => document.querySelector(`.preview-pdf-page[data-page="${n}"]`) as HTMLElement;
    await waitFor(() => expect(box(2).style.aspectRatio).toBe(String(960 / 540)));
    expect(box(1).style.aspectRatio).toBe(String(600 / 800));
    expect(box(3).style.aspectRatio).toBe(String(500 / 1000));
  });

  it("keeps unpainted pages at page 1's ratio until they are painted", async () => {
    const observers: { cb: IntersectionObserverCallback; targets: Element[] }[] = [];
    class FakeObserver {
      targets: Element[] = [];
      constructor(public cb: IntersectionObserverCallback) {
        observers.push(this);
      }
      observe(el: Element) {
        this.targets.push(el);
      }
      disconnect() {}
      unobserve() {}
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    pdf.numPages = 2;
    pdf.getPage.mockImplementation(async (n: number) => {
      const size = n === 1 ? { width: 600, height: 800 } : { width: 960, height: 540 };
      return {
        getViewport: ({ scale }: { scale: number }) => ({ width: size.width * scale, height: size.height * scale }),
        render: (params: unknown) => {
          pdf.render(params);
          return { promise: Promise.resolve() };
        },
      };
    });
    render(wrap(<PdfPreview bytes={new Uint8Array([1])} />));
    await screen.findByRole("group", { name: "PDF document, 2 pages" });
    const box2 = document.querySelector('.preview-pdf-page[data-page="2"]') as HTMLElement;
    expect(box2.style.aspectRatio).toBe(String(600 / 800));
    await act(async () => {
      observers[1].cb([{ isIntersecting: true, target: observers[1].targets[0] } as IntersectionObserverEntry], observers[1] as never);
    });
    await waitFor(() => expect(box2.style.aspectRatio).toBe(String(960 / 540)));
  });

  it("replaces the whole document with the failure note when one page fails to render (chosen design)", async () => {
    // A page pdf.js cannot draw means the file is damaged: rather than a
    // document with a silently blank page, the pane shows the failure note
    // (which keeps "open in the default app" available).
    pdf.numPages = 6;
    pdf.getPage.mockImplementation(async (n: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 960 * scale, height: 540 * scale }),
      render: (params: unknown) => {
        pdf.render(params);
        return { promise: n === 4 ? Promise.reject(new Error("broken page")) : Promise.resolve() };
      },
    }));
    render(wrap(<PdfPreview bytes={new Uint8Array([1])} />));
    expect(await screen.findByText("Could not load the preview.")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "PDF document, 6 pages" })).toBeNull();
    expect(document.querySelector(".preview-pdf-page")).toBeNull();
  });

  it("paints each page once at its first width: a later resize is CSS-only", async () => {
    let paneWidth = 600;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => paneWidth);
    vi.stubGlobal("devicePixelRatio", 1);
    pdf.numPages = 1;
    render(wrap(<PdfPreview bytes={new Uint8Array([1])} />));
    await waitFor(() => expect(pdf.render).toHaveBeenCalledTimes(1));
    const canvas = screen.getByRole("img", { name: "Page 1 of 1" }) as HTMLCanvasElement;
    expect(canvas.width).toBe(600);

    paneWidth = 1000;
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });
    // No re-render, same backing store: CSS stretches the canvas to the
    // box (PDF_MIN_RENDER_WIDTH keeps narrow first renders sharp enough).
    expect(pdf.render).toHaveBeenCalledTimes(1);
    expect(canvas.width).toBe(600);
  });

  it("releases the document on unmount", async () => {
    const { unmount } = render(wrap(<PdfPreview bytes={new Uint8Array([1])} />));
    await screen.findByRole("group", { name: "PDF document, 13 pages" });
    unmount();
    expect(pdf.destroy).toHaveBeenCalled();
  });
});
