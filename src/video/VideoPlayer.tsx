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
// would reload the frame).

import { useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type Ref } from "react";
import { useT } from "../i18n";
import { formatTime, type VideoPreviewInfo } from "./api";
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
}

let playerModule: Promise<unknown> | null = null;
function loadPlayer(): Promise<unknown> {
  playerModule ??= import("@hyperframes/player");
  return playerModule;
}

export function VideoPlayer({
  info,
  handle,
  onTime,
  compact = false,
}: {
  info: VideoPreviewInfo;
  handle?: Ref<PlayerHandle>;
  onTime?: (seconds: number) => void;
  /// Hides the meta line (gallery thumbnails).
  compact?: boolean;
}) {
  const t = useT();
  const element = useRef<PlayerElement | null>(null);
  const [defined, setDefined] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

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
    const onReady = () => setReady(true);
    const onError = () => setFailed(true);
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ currentTime?: number }>).detail;
      if (typeof detail?.currentTime === "number") onTime?.(detail.currentTime);
    };
    node.addEventListener("ready", onReady);
    node.addEventListener("error", onError);
    node.addEventListener("timeupdate", onUpdate);
    return () => {
      node.removeEventListener("ready", onReady);
      node.removeEventListener("error", onError);
      node.removeEventListener("timeupdate", onUpdate);
    };
  }, [defined, onTime]);

  useImperativeHandle(
    handle,
    () => ({
      currentTime: () => element.current?.currentTime ?? 0,
      seek: (seconds: number) => element.current?.seek?.(seconds),
      pause: () => element.current?.pause?.(),
    }),
    [],
  );

  return (
    <figure className={`video-player${compact ? " compact" : ""}`}>
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
            src={info.url}
            width={info.width}
            height={info.height}
            controls
            aria-label={t.video.playerLabel(info.title)}
          />
        ) : null}
      </div>
      {!compact && (
        <figcaption className="video-meta">
          <span className="video-aspect" aria-label={t.video.aspectLabel(info.aspect)}>
            {info.aspect}
          </span>
          <span>{formatTime(info.duration)}</span>
          <span>{t.video.fps(info.fps)}</span>
        </figcaption>
      )}
    </figure>
  );
}
