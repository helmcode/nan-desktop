// S21: collapsible preview pane to the right of the chat. Lazy-loaded by the
// chat shell; renderers load on demand. Local files are read by the core
// (inside active grants only); web pages go through the platform fetch
// wrapper, with a branded open-in-browser card as the fallback.

import { lazy, Suspense, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  fetchWebPreview,
  readFileWithSiteForPreview,
  rejectionKind,
  releaseSitePreview,
  type FileForPreview,
  type WebPreview,
} from "../core";
import { SitePreview } from "./sitePreview";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { folderName, hostOf } from "../copy";
import { useT } from "../i18n";
import { IconExternal, IconFolder, IconGlobe, IconPencil, IconShare, IconX } from "../icons";
import { BrandMark } from "../brand";
import { Markdown, openExternal } from "../Markdown";
import { isEditableImagePath } from "../studio/studio";
import { isTopLayer, useEscapeLayer } from "../escapeLayers";
import { previewKind, targetKey, type PreviewTarget } from "./kind";
import { revealInFolder } from "./reveal";
import { shareSourceFor, type ShareSource } from "../artifacts/artifacts";

const Renderers = {
  image: lazy(() => import("./renderers").then((m) => ({ default: m.ImagePreview }))),
  pdf: lazy(() => import("./renderers").then((m) => ({ default: m.PdfPreview }))),
  text: lazy(() => import("./renderers").then((m) => ({ default: m.TextPreview }))),
  sheet: lazy(() => import("./renderers").then((m) => ({ default: m.SheetPreview }))),
  docx: lazy(() => import("./renderers").then((m) => ({ default: m.DocxPreview }))),
};

type LoadState<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "error"; kind: string | null };

/// `release` (R22) runs once for every value this load produced when that
/// value is no longer shown: the target changed, the pane closed, or the
/// load resolved after it was cancelled.
function useLoad<T>(key: string, load: () => Promise<T>, release?: (value: T) => void): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    let loaded: { value: T } | null = null;
    setState({ status: "loading" });
    load()
      .then((value) => {
        if (cancelled) {
          release?.(value);
          return;
        }
        loaded = { value };
        setState({ status: "ready", value });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: "error", kind: rejectionKind(err) });
      });
    return () => {
      cancelled = true;
      if (loaded) release?.(loaded.value);
    };
    // `key` identifies the target; `load` is recreated per render.
  }, [key]);
  return state;
}

function LinkOutCard({ url, message }: { url: string; message: string }) {
  const t = useT();
  return (
    <div className="preview-linkout">
      <BrandMark size="lg" />
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

/// R22: a user HTML document's ephemeral token goes back to the core when
/// its preview is gone (a tool website's token is never released).
function releaseFile(file: FileForPreview): void {
  if (file.releasable && file.siteUrl !== null) releaseSitePreview(file.siteUrl);
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
  const state = useLoad<FileForPreview>(
    `file:${path}`,
    () => (kind === "unsupported" ? Promise.reject(new Error("unsupported")) : readFileWithSiteForPreview(profileId, path)),
    releaseFile,
  );
  if (kind === "unsupported") return <p className="preview-note">{t.preview.unsupported}</p>;
  if (state.status === "loading") return <p className="preview-note">{t.preview.loading}</p>;
  if (state.status === "error") {
    return <p className="preview-note">{state.kind === "too_large" ? t.preview.tooLarge : t.preview.failed}</p>;
  }
  const { bytes, siteUrl } = state.value;
  // R20-D + R22: every HTML file renders for real in the sandboxed frame,
  // served by the core under its no-network policy: a website
  // write_website wrote (pinned class) or a user's own document (ephemeral
  // class). The core decides; the whitelist renderer is for non-HTML only.
  if (kind === "html") {
    return siteUrl !== null ? (
      <SitePreview url={siteUrl} name={folderName(path)} />
    ) : (
      <p className="preview-note">{t.preview.failed}</p>
    );
  }
  switch (kind) {
    case "image":
      return <Renderers.image bytes={bytes} alt={folderName(path)} />;
    case "pdf":
      return <Renderers.pdf bytes={bytes} />;
    case "markdown":
      return <Renderers.text bytes={bytes} path={path} markdown />;
    case "text":
      return <Renderers.text bytes={bytes} path={path} markdown={false} />;
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
  onEditImage,
  onRemove,
  onShare,
}: {
  target: PreviewTarget;
  profileId: string;
  onClose: () => void;
  onOpenLink: (url: string) => void;
  /// When set, an editable image (PNG/JPEG/WebP) shows a visible "Edit
  /// image" button that opens the Image Studio on it.
  onEditImage?: (target: PreviewTarget) => void;
  /// When set, an image gets a small X on it that takes it OUT of the
  /// preview (the pane forgets it, so another image can be opened). It
  /// never deletes the file itself.
  onRemove?: () => void;
  /// When set (shared artifacts available), a shareable file or generated
  /// image shows a "Share" button that opens the share-as-link dialog.
  onShare?: (source: ShareSource) => void;
}) {
  const t = useT();
  const isWeb = target.kind === "web";
  const isImage = target.kind === "media" || (target.kind === "file" && previewKind(target) === "image");
  const editable =
    onEditImage !== undefined &&
    (target.kind === "media" || (target.kind === "file" && previewKind(target) === "image" && isEditableImagePath(target.ref)));
  const title = isWeb ? hostOf(target.ref) : folderName(target.ref);
  const key = targetKey(target);
  // Only local files the user granted live in a folder of theirs; web pages
  // and generated images (app data) have nothing to show in a folder.
  const revealable = target.kind === "file";
  const [revealFailedFor, setRevealFailedFor] = useState<string | null>(null);
  const reveal = () => {
    setRevealFailedFor(null);
    revealInFolder(profileId, target.ref).catch(() => setRevealFailedFor(key));
  };
  const shareSource = onShare ? shareSourceFor(target) : null;

  // Round 17 review (U1): the pane is an escape layer like every other inner
  // surface. A surface opened after it (a row menu, a dialog) sits above it
  // and takes Escape first; a key another handler already consumed
  // (defaultPrevented) or an IME composition never closes the pane.
  const layer = useEscapeLayer(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
      if (!isTopLayer(layer)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [layer, onClose]);

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
        {editable && (
          <button type="button" className="btn btn-secondary btn-sm preview-edit" onClick={() => onEditImage?.(target)}>
            <IconPencil size={14} />
            {t.chat.editImage}
          </button>
        )}
        {shareSource && (
          <button
            type="button"
            className="btn btn-secondary btn-sm preview-share"
            aria-label={t.artifacts.shareLabel(title)}
            onClick={() => onShare?.(shareSource)}
          >
            <IconShare size={14} />
            {t.artifacts.share}
          </button>
        )}
        {/* Show in folder stays right next to close (preview-scroll-reveal). */}
        {revealable && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t.preview.revealInFolder}
            title={t.preview.revealInFolder}
            onClick={reveal}
          >
            <IconFolder size={16} />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label={t.preview.close} title={t.preview.close} onClick={onClose}>
          <IconX size={16} />
        </button>
      </header>
      {revealFailedFor === key && (
        <p className="preview-note preview-reveal-error" role="alert">
          {t.preview.revealFailed}
        </p>
      )}
      <div className="preview-body" key={key}>
        <ErrorBoundary resetKey={key} fallback={<p className="preview-note">{t.preview.crashed}</p>}>
          <Suspense fallback={<p className="preview-note">{t.preview.loading}</p>}>
            {isImage && onRemove ? (
              // The X sits on the image's own corner (the frame shrinks to it).
              <div className="preview-image-frame">
                {target.kind === "media" ? (
                  <img className="preview-image" src={convertFileSrc(target.ref)} alt={title} />
                ) : (
                  <FileBody profileId={profileId} path={target.ref} onOpenLink={onOpenLink} />
                )}
                <button
                  type="button"
                  className="preview-remove"
                  aria-label={t.preview.removeFromPreview}
                  title={t.preview.removeFromPreview}
                  onClick={onRemove}
                >
                  <IconX size={12} />
                </button>
              </div>
            ) : target.kind === "media" ? (
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
