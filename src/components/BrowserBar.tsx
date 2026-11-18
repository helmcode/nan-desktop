// In-app browser bar (computer use, phase 1). The assistant's browser is a
// separate native window; this bar in the chat window shows what it is on
// (read-only address), gives the user back / forward / reload, brings the
// window to the front, stops the assistant's reply and closes the browser.
// The core owns the browser: this component only renders its state and
// forwards the user's clicks.

import { useEffect, useState } from "react";
import {
  CLOSED_BROWSER,
  controlBrowser,
  displayAddress,
  getBrowserState,
  onBrowserDownloadBlocked,
  onBrowserState,
  type BrowserControl,
  type BrowserView,
} from "../core";
import { useT } from "../i18n";
import { IconArrowLeft, IconExternal, IconGlobe, IconStop, IconX } from "../icons";

/// Keeps the browser state in sync with the core (initial read + events).
export function useBrowserView(): { view: BrowserView; downloadBlocked: boolean; dismissDownload: () => void } {
  const [view, setView] = useState<BrowserView>(CLOSED_BROWSER);
  const [downloadBlocked, setDownloadBlocked] = useState(false);
  useEffect(() => {
    let alive = true;
    const unlisteners: Array<() => void> = [];
    void onBrowserState((next) => {
      if (alive) setView(next);
    }).then((un) => (alive ? unlisteners.push(un) : un()));
    void onBrowserDownloadBlocked(() => {
      if (alive) setDownloadBlocked(true);
    }).then((un) => (alive ? unlisteners.push(un) : un()));
    getBrowserState()
      .then((initial) => {
        if (alive) setView(initial);
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisteners.forEach((un) => un());
    };
  }, []);
  // A blocked download notice goes away once the browser closes.
  useEffect(() => {
    if (!view.open) setDownloadBlocked(false);
  }, [view.open]);
  return { view, downloadBlocked, dismissDownload: () => setDownloadBlocked(false) };
}

export function BrowserBar({
  view,
  downloadBlocked,
  onDismissDownload,
  onStopAssistant,
}: {
  view: BrowserView;
  downloadBlocked: boolean;
  onDismissDownload: () => void;
  /// Stop the reply that is driving the browser (`chat_stop`).
  onStopAssistant: (conversationId: number) => void;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  if (!view.open) return null;

  const run = (action: BrowserControl) => {
    setFailed(false);
    controlBrowser(action).catch(() => setFailed(true));
  };
  const address = displayAddress(view.url);
  const agent = view.agent_conversation;

  return (
    <section className="browser-bar" role="region" aria-label={t.browser.region}>
      <div className="browser-bar-row">
        <span className="browser-bar-icon" aria-hidden="true">
          <IconGlobe size={15} />
        </span>
        <div className="browser-bar-nav">
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => run("back")} aria-label={t.browser.back} title={t.browser.back}>
            <IconArrowLeft size={14} />
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm browser-bar-forward"
            onClick={() => run("forward")}
            aria-label={t.browser.forward}
            title={t.browser.forward}
          >
            <IconArrowLeft size={14} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => run("reload")}>
            {t.browser.reload}
          </button>
        </div>
        <output className="browser-bar-address" aria-label={t.browser.address} title={view.url ?? undefined}>
          {address || t.browser.noPage}
          {view.loading && <span className="browser-bar-loading"> · {t.browser.loading}</span>}
        </output>
        <div className="browser-bar-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => run("show")}>
            <IconExternal size={13} /> {t.browser.show}
          </button>
          {agent !== null && (
            <button type="button" className="btn btn-sm btn-warn-solid" onClick={() => onStopAssistant(agent)}>
              <IconStop size={13} /> {t.browser.stop}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => run("close")} aria-label={t.browser.close} title={t.browser.close}>
            <IconX size={14} />
          </button>
        </div>
      </div>
      <p className="browser-bar-status" role="status">
        {agent !== null ? t.browser.agentActive : t.browser.userTurn}
      </p>
      {downloadBlocked && (
        <p className="browser-bar-notice" role="status">
          {t.browser.downloadBlocked}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onDismissDownload} aria-label={t.browser.dismiss}>
            <IconX size={12} />
          </button>
        </p>
      )}
      {failed && (
        <p className="browser-bar-notice" role="alert">
          {t.browser.failed}
        </p>
      )}
    </section>
  );
}
