// S21: collapsible preview pane to the right of the chat. Lazy-loaded by the
// chat shell; renderers load on demand. Local files are read by the core
// (inside active grants only); web pages go through the platform fetch
// wrapper, with a branded open-in-browser card as the fallback.

import { lazy, Suspense, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { fetchWebPreview, readFileForPreview, type WebPreview } from "../core";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { folderName, hostOf } from "../copy";
import { useT } from "../i18n";
import { IconExternal, IconGlobe, IconX } from "../icons";
import { BrandMark } from "../brand";
import { Markdown, openExternal } from "../Markdown";
import { previewKind, targetKey, type PreviewTarget } from "./kind";

const Renderers = {
  image: lazy(() => import("./renderers").then((m) => ({ default: m.ImagePreview }))),
  pdf: lazy(() => import("./renderers").then((m) => ({ default: m.PdfPreview }))),
  text: lazy(() => import("./renderers").then((m) => ({ default: m.TextPreview }))),
  html: lazy(() => import("./renderers").then((m) => ({ default: m.HtmlPreview }))),
  sheet: lazy(() => import("./renderers").then((m) => ({ default: m.SheetPreview }))),
  docx: lazy(() => import("./renderers").then((m) => ({ default: m.DocxPreview }))),
};

type LoadState<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error" };

function useLoad<T>(key: string, load: () => Promise<T>): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    load()
      .then((value) => {
        if (!cancelled) setState({ status: "ready", value });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // `key` identifies the target; `load` is recreated per render.
  }, [key]);
  return state;
}

function LinkOutCard({ url, message }: { url: string; message: string }) {
  const t = useT();
  return (
    <div className="preview-linkout">
      <BrandMark size={32} />
      <p className="preview-linkout-host">{hostOf(url)}</p>
      <p className="preview-note">{message}</p>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => openExternal(url)}>
        <IconExternal size={14} />
        {t.preview.openInBrowser}
      </button>
    </div>
  );
}

function WebBody({ profileId, url, onOpenLink }: { profileId: string; url: string; onOpenLink: (url: string) => void }) {
  const t = useT();
  const state = useLoad<WebPreview>(`web:${url}`, () => fetchWebPreview(profileId, url));
  if (state.status === "loading") return <p className="preview-note">{t.preview.loading}</p>;
  if (state.status === "error" || state.value.text.trim().length === 0) {
    return <LinkOutCard url={url} message={t.preview.webUnavailable} />;
  }
  return (
    <article className="preview-web">
      {state.value.title && <h2 className="preview-web-title">{state.value.title}</h2>}
      <Markdown text={state.value.text} onOpenLink={onOpenLink} />
    </article>
  );
}

function FileBody({
  profileId,
  path,
  onOpenLink,
}: {
  profileId: string;
  path: string;
  onOpenLink: (url: string) => void;
}) {
  const t = useT();
  const kind = previewKind({ kind: "file", ref: path });
  const state = useLoad<Uint8Array>(`file:${path}`, () =>
    kind === "unsupported" ? Promise.reject(new Error("unsupported")) : readFileForPreview(profileId, path),
  );
  if (kind === "unsupported") return <p className="preview-note">{t.preview.unsupported}</p>;
  if (state.status === "loading") return <p className="preview-note">{t.preview.loading}</p>;
  if (state.status === "error") return <p className="preview-note">{t.preview.failed}</p>;
  const bytes = state.value;
  switch (kind) {
    case "image":
      return <Renderers.image bytes={bytes} alt={folderName(path)} />;
    case "pdf":
      return <Renderers.pdf bytes={bytes} />;
    case "markdown":
      return <Renderers.text bytes={bytes} path={path} markdown />;
    case "text":
      return <Renderers.text bytes={bytes} path={path} markdown={false} />;
    case "html":
      return <Renderers.html bytes={bytes} onOpenLink={onOpenLink} />;
    case "sheet":
      return <Renderers.sheet bytes={bytes} />;
    case "docx":
      return <Renderers.docx bytes={bytes} onOpenLink={onOpenLink} />;
    default:
      return <p className="preview-note">{t.preview.unsupported}</p>;
  }
}

export default function PreviewPane({
  target,
  profileId,
  onClose,
  onOpenLink,
}: {
  target: PreviewTarget;
  profileId: string;
  onClose: () => void;
  onOpenLink: (url: string) => void;
}) {
  const t = useT();
  const isWeb = target.kind === "web";
  const title = isWeb ? hostOf(target.ref) : folderName(target.ref);
  const key = targetKey(target);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="preview-pane" aria-label={t.preview.title}>
      <header className="preview-header">
        <span className="preview-title" title={target.ref}>
          {isWeb && <IconGlobe size={15} />}
          {title}
        </span>
        {isWeb && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t.preview.openInBrowser}
            title={t.preview.openInBrowser}
            onClick={() => openExternal(target.ref)}
          >
            <IconExternal size={16} />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label={t.preview.close} title={t.preview.close} onClick={onClose}>
          <IconX size={16} />
        </button>
      </header>
      <div className="preview-body" key={key}>
        <ErrorBoundary resetKey={key} fallback={<p className="preview-note">{t.preview.crashed}</p>}>
          <Suspense fallback={<p className="preview-note">{t.preview.loading}</p>}>
            {target.kind === "media" ? (
              <img className="preview-image" src={convertFileSrc(target.ref)} alt={title} />
            ) : isWeb ? (
              previewKind(target) === "web" ? (
                <WebBody profileId={profileId} url={target.ref} onOpenLink={onOpenLink} />
              ) : (
                <p className="preview-note">{t.preview.unsupported}</p>
              )
            ) : (
              <FileBody profileId={profileId} path={target.ref} onOpenLink={onOpenLink} />
            )}
          </Suspense>
        </ErrorBoundary>
      </div>
    </aside>
  );
}
