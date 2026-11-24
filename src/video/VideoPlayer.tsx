// R-V1: the HyperFrames player around a project's sandboxed preview.
//
// Isolation (docs/VIDEO.md): the player is our own pinned bundle code
// (@hyperframes/player); the COMPOSITION runs in the player's inner iframe,
// loaded from the core's `nan-site` scheme, which serves the assembled
// document with the no-network CSP header plus `sandbox allow-scripts`.
// `sandbox-origin="opaque"` makes the player drop allow-same-origin from
// that iframe too, so the composition is an opaque origin either way: it
// reaches neither this app's DOM, nor storage, nor the Tauri bridge; the
// player talks to it only through postMessage.
//
// The element is created only after the player module has defined it, so
// `sandbox-origin` is in place before the first load (changing it later
// would reload the frame), and `src` is set only after the inner frame's
// `allow` is narrowed to `autoplay` (no `fullscreen`: a hostile composition
// must not be able to take the whole screen and imitate the app). The
// player's own fullscreen button is hidden too.
//
// Our own "Full screen" button (round 24) enlarges the PLAYER, never the
// composition frame: the figure becomes a fixed full-window overlay (CSS,
// works in every webview: WKWebView on macOS, WebView2 on Windows, WebKitGTK)
// and, where the webview allows the Fullscreen API on app elements
// (`requestFullscreen`, or `webkitRequestFullscreen` on older WebKit), the
// same element also goes to the screen's full screen. The element is never
// moved in the DOM (moving an iframe reloads it). Escape, or the button
// again, leaves it.

import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { useT } from "../i18n";
import { isTopLayer, useEscapeLayer } from "../escapeLayers";
import { IconFit } from "../icons";
import { formatDuration, type VideoPreviewInfo } from "./api";
import "./video.css";

/// The one sandbox origin mode the player gets. Never removed: without it
/// the player's default frame would be same-origin with its document.
export const PLAYER_SANDBOX_ORIGIN = "opaque";

export interface PlayerHandle {
  currentTime: () => number;
  seek: (seconds: number) => void;
  pause: () => void;
}

interface PlayerElement extends HTMLElement {
  currentTime?: number;
  seek?: (seconds: number) => void;
  pause?: () => void;
  iframeElement?: HTMLIFrameElement | null;
}

type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };

/// Ask the webview for real full screen on `el` (best effort: the overlay
/// already fills the window when it is not available).
export function enterNativeFullscreen(el: HTMLElement): void {
  const node = el as FullscreenElement;
  try {
    const request = node.requestFullscreen ?? node.webkitRequestFullscreen;
    const result = request?.call(node);
    if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch(() => undefined);
  } catch {
    /* not allowed here: the overlay is enough */
  }
}

function nativeFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function exitNativeFullscreen(): void {
  const doc = document as FullscreenDocument;
  if (!nativeFullscreenElement()) return;
  try {
    const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
    const result = exit?.call(doc);
    if (result && typeof (result as Promise<void>).catch === "function") (result as Promise<void>).catch(() => undefined);
  } catch {
    /* already out */
  }
}

let playerModule: Promise<unknown> | null = null;
function loadPlayer(): Promise<unknown> {
  playerModule ??= import("@hyperframes/player");
  return playerModule;
}

/// What the composition frame may use: autoplay only.
export const FRAME_ALLOW = "autoplay";

export function VideoPlayer({
  info,
  handle,
  onTime,
  compact = false,
  autoplay = false,
  startAt = 0,
}: {
  info: VideoPreviewInfo;
  handle?: Ref<PlayerHandle>;
  onTime?: (seconds: number) => void;
  /// Gallery thumbnail: no meta line, no controls, plays muted in a loop.
  compact?: boolean;
  /// Starts playing by itself, muted and looping (template detail).
  autoplay?: boolean;
  /// Where the playhead goes once the film is ready (an editor change
  /// reloads the preview: the user keeps their place).
  startAt?: number;
}) {
  const t = useT();
  const element = useRef<PlayerElement | null>(null);
  const [defined, setDefined] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const figure = useRef<HTMLElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const startRef = useRef(startAt);
  startRef.current = startAt;
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;

  useEffect(() => {
    let alive = true;
    loadPlayer()
      .then(() => alive && setDefined(true))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const onReady = () => {
      setReady(true);
      const at = startRef.current;
      if (at > 0) {
        node.seek?.(Math.min(at, Math.max(0, info.duration - 0.05)));
        onTimeRef.current?.(at);
      }
    };
    const onError = () => setFailed(true);
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ currentTime?: number }>).detail;
      if (typeof detail?.currentTime === "number") onTimeRef.current?.(detail.currentTime);
    };
    node.addEventListener("ready", onReady);
    node.addEventListener("error", onError);
    node.addEventListener("timeupdate", onUpdate);
    // Narrow the frame first, then load.
    node.iframeElement?.setAttribute("allow", FRAME_ALLOW);
    node.setAttribute("src", info.url);
    return () => {
      node.removeEventListener("ready", onReady);
      node.removeEventListener("error", onError);
      node.removeEventListener("timeupdate", onUpdate);
    };
  }, [defined, info.url, info.duration]);

  useImperativeHandle(
    handle,
    () => ({
      currentTime: () => element.current?.currentTime ?? 0,
      seek: (seconds: number) => {
        element.current?.seek?.(seconds);
        onTimeRef.current?.(seconds);
      },
      pause: () => element.current?.pause?.(),
    }),
    [],
  );

  // Full screen is an escape layer: Escape leaves it (and nothing behind it,
  // such as the side panel, closes on the same key).
  const layer = useEscapeLayer(fullscreen);
  useLayoutEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.defaultPrevented || !isTopLayer(layer)) return;
      e.preventDefault();
      setFullscreen(false);
    };
    // The webview left its own full screen (its Escape, a gesture).
    let wasNative = false;
    const onChange = () => {
      const now = nativeFullscreenElement() === figure.current;
      if (wasNative && !now) setFullscreen(false);
      wasNative = now;
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      exitNativeFullscreen();
    };
  }, [fullscreen, layer]);

  const toggleFullscreen = () => {
    if (fullscreen) {
      setFullscreen(false);
      return;
    }
    setFullscreen(true);
    if (figure.current) enterNativeFullscreen(figure.current);
  };

  const quiet = compact || autoplay;
  return (
    <figure
      ref={figure}
      className={`video-player${compact ? " compact" : ""}${fullscreen ? " fullscreen" : ""}`}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen ? "true" : undefined}
      aria-label={fullscreen ? t.video.playerLabel(info.title) : undefined}
    >
      <div
        className="video-stage"
        style={
          {
            aspectRatio: `${info.width} / ${info.height}`,
            "--video-ratio": String(info.width / info.height),
          } as CSSProperties
        }
        aria-busy={!ready && !failed ? "true" : undefined}
      >
        {failed ? (
          <p className="preview-note" role="alert">
            {t.video.playerFailed}
          </p>
        ) : defined ? (
          <hyperframes-player
            ref={element}
            className="video-element"
            sandbox-origin={PLAYER_SANDBOX_ORIGIN}
            width={info.width}
            height={info.height}
            controls={!compact}
            muted={quiet}
            loop={quiet}
            autoplay={quiet}
            disable-click-to-play={compact}
            disable-fullscreen
            aria-label={t.video.playerLabel(info.title)}
          />
        ) : null}
      </div>
      {!compact && (
        <figcaption className="video-meta">
          <span className="video-aspect" aria-label={t.video.aspectLabel(info.aspect)}>
            {info.aspect}
          </span>
          <span>{formatDuration(info.duration)}</span>
          <span>{t.video.fps(info.fps)}</span>
          {!autoplay && (
            <button
              type="button"
              className="icon-btn video-fullscreen"
              aria-label={fullscreen ? t.video.exitFullscreen : t.video.fullscreen}
              aria-pressed={fullscreen}
              title={fullscreen ? t.video.exitFullscreen : t.video.fullscreen}
              onClick={toggleFullscreen}
            >
              <IconFit size={15} />
            </button>
          )}
        </figcaption>
      )}
    </figure>
  );
}
