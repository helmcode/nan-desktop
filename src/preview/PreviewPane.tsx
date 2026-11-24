// S21: collapsible preview pane to the right of the chat. Lazy-loaded by the
// chat shell; renderers load on demand. Local files are read by the core
// (inside active grants only); web pages go through the platform fetch
// wrapper, with a branded open-in-browser card as the fallback.

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  fetchArtifactLinkPreview,
  fetchWebPreview,
  readFileWithSiteForPreview,
  rejectionKind,
  releaseSitePreview,
  type ArtifactLinkPreview,
  type FileForPreview,
  type WebPreview,
} from "../core";
import { SitePreview } from "./sitePreview";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { folderName, hostOf } from "../copy";
import { useT } from "../i18n";
import { IconDownload, IconExternal, IconFolder, IconGlobe, IconPencil, IconShare, IconX } from "../icons";
import { BrandMark } from "../brand";
import { Markdown, openExternal } from "../Markdown";
import { isEditableImagePath } from "../studio/studio";
import { isTopLayer, useEscapeLayer } from "../escapeLayers";
import { isArtifactShareUrl, previewKind, targetKey, type PreviewTarget } from "./kind";
import { revealInFolder } from "./reveal";
import { shareSourceFor, type ShareSource } from "../artifacts/artifacts";
import { videoPreview, type VideoPreviewInfo } from "../video/api";
import { useVideoRevision } from "../video/useVideoRevision";

const VideoPlayer = lazy(() => import("../video/VideoPlayer").then((m) => ({ default: m.VideoPlayer })));
const PreviewExport = lazy(() => import("../video/PreviewExport"));

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

/// Issue #57: an HTML artifact's sandboxed token goes back to the core when
/// its preview is gone (same ephemeral document class as a user's HTML).
function releaseArtifact(artifact: ArtifactLinkPreview): void {
  if (artifact.siteUrl !== null) releaseSitePreview(artifact.siteUrl);
}

/// Issue #57: a shared artifact link shows the artifact itself. The core
/// fetches the share page and the bytes (no credentials); HTML runs in the
/// sandboxed frame, every other type in the existing renderers. A link the
/// core cannot show here (restricted, expired, an unknown type) falls back
/// to the open-in-browser card.
function ArtifactBody({ url, onOpenLink }: { url: string; onOpenLink: (url: string) => void }) {
  const t = useT();
  const state = useLoad<ArtifactLinkPreview>(`artifact:${url}`, () => fetchArtifactLinkPreview(url), releaseArtifact);
  if (state.status === "loading") return <p className="preview-note">{t.preview.loading}</p>;
  if (state.status === "error") {
    if (state.kind === "too_large") return <LinkOutCard url={url} message={t.preview.tooLarge} />;
    const message = state.kind === "not_found" ? t.preview.artifactGone : t.preview.artifactUnavailable;
    return <LinkOutCard url={url} message={message} />;
  }
  const artifact = state.value;
  const name = artifact.title ?? artifact.filename ?? hostOf(url);
  const path = artifact.filename ?? "artifact.txt";
  if (artifact.kind === "html") {
    // A direct child of .preview-body, like a local HTML file, so the frame
    // fills the pane (App.css `.preview-body:has(> .preview-site)`).
    return artifact.siteUrl !== null ? (
      <SitePreview url={artifact.siteUrl} name={name} />
    ) : (
      <LinkOutCard url={url} message={t.preview.artifactUnavailable} />
    );
  }
  let body;
  switch (artifact.kind) {
    case "image":
      body = <Renderers.image bytes={artifact.bytes} alt={name} />;
      break;
    case "pdf":
      body = <Renderers.pdf bytes={artifact.bytes} />;
      break;
    case "markdown":
      body = <Renderers.text bytes={artifact.bytes} path={path} markdown />;
      break;
    case "text":
      body = <Renderers.text bytes={artifact.bytes} path={path} markdown={false} />;
      break;
    case "sheet":
      body = <Renderers.sheet bytes={artifact.bytes} />;
      break;
    case "docx":
      body = <Renderers.docx bytes={artifact.bytes} onOpenLink={onOpenLink} />;
      break;
    default:
      body = null;
  }
  if (body === null) return <LinkOutCard url={url} message={t.preview.artifactUnavailable} />;
  return (
    <article className="preview-artifact">
      {artifact.title && <h2 className="preview-web-title">{artifact.title}</h2>}
      {body}
    </article>
  );
}

/// R-V1: a video preview's token goes back to the core when its player is
/// gone (the target changed or the pane closed).
function releaseVideo(info: VideoPreviewInfo): void {
  releaseSitePreview(info.url);
}

/// R-V1: a project of the user's video library in the sandboxed player.
///
/// Round 24: it follows the assistant. Every `create_video`/`edit_video`
/// write of this project (debounced, see useVideoRevision) loads a fresh
/// preview; the current one stays on screen until the new one is ready
/// (no blank flash, no loop), the new player resumes at the same playhead,
/// and the old preview token goes back to the core. A reload that fails
/// keeps the last good preview.
function VideoBody({
  profileId,
  projectId,
  exporting,
  onSignIn,
}: {
  profileId: string;
  projectId: string;
  exporting: boolean;
  onSignIn?: () => void;
}) {
  const t = useT();
  const changes = useVideoRevision(projectId);
  const [state, setState] = useState<LoadState<VideoPreviewInfo>>({ status: "loading" });
  const [startAt, setStartAt] = useState(0);
  // Full screen survives the reload of the player after an assistant edit.
  const [fullscreen, setFullscreen] = useState(false);
  const shown = useRef<VideoPreviewInfo | null>(null);
  const time = useRef(0);
  useEffect(() => {
    let cancelled = false;
    videoPreview(profileId, projectId)
      .then((info) => {
        if (cancelled) return releaseVideo(info);
        const previous = shown.current;
        shown.current = info;
        setStartAt(previous ? Math.min(time.current, Math.max(0, info.duration - 0.05)) : 0);
        setState({ status: "ready", value: info });
        if (previous) releaseVideo(previous);
      })
      .catch((err: unknown) => {
        if (!cancelled && !shown.current) setState({ status: "error", kind: rejectionKind(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, projectId, changes]);
  // The last preview's token goes back when the panel closes.
  useEffect(
    () => () => {
      if (shown.current) releaseVideo(shown.current);
      shown.current = null;
    },
    [],
  );
  if (state.status === "loading") return <p className="preview-note">{t.video.loading}</p>;
  if (state.status === "error") {
    const message =
      state.kind === "not_found" ? t.video.gone : state.kind === "too_large" ? t.video.tooLarge : t.video.previewFailed;
    return <p className="preview-note">{message}</p>;
  }
  return (
    <article className="preview-video">
      <h2 className="preview-web-title">{state.value.title}</h2>
      <VideoPlayer
        key={state.value.url}
        info={state.value}
        startAt={startAt}
        fullscreen={fullscreen}
        onFullscreenChange={setFullscreen}
        onTime={(seconds) => {
          time.current = seconds;
        }}
      />
      {exporting && <PreviewExport profileId={profileId} projectId={projectId} revision={changes} onSignIn={onSignIn} />}
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
  onOpenVideo,
  onSignIn,
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
  /// R-V1: when set, a video shows "Edit video", which opens the Videos
  /// editor on it.
  onOpenVideo?: (projectId: string) => void;
  /// R-V1: the session expired during a video export: sign in again.
  onSignIn?: () => void;
}) {
  const t = useT();
  const isWeb = target.kind === "web";
  const isVideo = target.kind === "video";
  const isImage = target.kind === "media" || (target.kind === "file" && previewKind(target) === "image");
  const editable =
    onEditImage !== undefined &&
    (target.kind === "media" || (target.kind === "file" && previewKind(target) === "image" && isEditableImagePath(target.ref)));
  const title = isWeb ? hostOf(target.ref) : isVideo ? t.video.previewTitle : folderName(target.ref);
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
  // R-V1: the video's export section, opened from the header.
  const [exportingFor, setExportingFor] = useState<string | null>(null);
  const exporting = isVideo && exportingFor === key;

  // Round 17 review (U1): the pane is an escape layer like every other inner
  // surface. A surface opened after it (a row menu, a dialog) sits above it
  // and takes Escape first; a key another handler already consumed
  // (defaultPrevented) or an IME composition never closes the pane.
  // Registered at commit (layout effect), like its layer: no window where an
  // Escape pressed right after the pane opened reaches another surface.
  const layer = useEscapeLayer(true);
  useLayoutEffect(() => {
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
        {isVideo && previewKind(target) === "video" && (
          <button
            type="button"
            className={`btn btn-sm preview-export ${exporting ? "btn-primary" : "btn-secondary"}`}
            aria-expanded={exporting}
            aria-controls="preview-video-export"
            onClick={() => setExportingFor(exporting ? null : key)}
          >
            <IconDownload size={14} />
            {t.video.previewExport}
          </button>
        )}
        {isVideo && onOpenVideo && (
          <button type="button" className="btn btn-secondary btn-sm preview-edit" onClick={() => onOpenVideo(target.ref)}>
            <IconPencil size={14} />
            {t.video.edit}
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
            ) : isVideo ? (
              previewKind(target) === "video" ? (
                <VideoBody profileId={profileId} projectId={target.ref} exporting={exporting} onSignIn={onSignIn} />
              ) : (
                <p className="preview-note">{t.preview.unsupported}</p>
              )
            ) : isWeb ? (
              previewKind(target) !== "web" ? (
                <p className="preview-note">{t.preview.unsupported}</p>
              ) : isArtifactShareUrl(target.ref) ? (
                <ArtifactBody url={target.ref} onOpenLink={onOpenLink} />
              ) : (
                <WebBody profileId={profileId} url={target.ref} onOpenLink={onOpenLink} />
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
