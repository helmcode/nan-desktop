// In-app browser bar (computer use, phase 1). The assistant's browser is a
// separate native window; this bar in the chat window shows what it is on
// (read-only address), gives the user back / forward / reload, brings the
// window to the front, stops the assistant's reply and closes the browser
// (closing also stops the reply driving it). The core owns the browser:
// this component only renders its state and forwards the user's clicks.

import { useEffect, useState } from "react";
import {
  CLOSED_BROWSER,
  controlBrowser,
  displayAddress,
  getBrowserState,
  onBrowserDownloadBlocked,
  onBrowserState,
  setBrowserLanguage,
  type BrowserControl,
  type BrowserView,
} from "../core";
import { useI18n, useT } from "../i18n";
import { IconArrowLeft, IconExternal, IconGlobe, IconReload, IconStop, IconX } from "../icons";

/// Keeps the browser state in sync with the core (initial read + events)
/// and tells the core the UI language (the browser window title).
export function useBrowserView(): { view: BrowserView; downloadBlocked: boolean; dismissDownload: () => void } {
  const { locale } = useI18n();
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
  useEffect(() => {
    setBrowserLanguage(locale).catch(() => {});
  }, [locale]);
  // A blocked download notice goes away once the browser closes.
  useEffect(() => {
    if (!view.open) setDownloadBlocked(false);
  }, [view.open]);
  return { view, downloadBlocked, dismissDownload: () => setDownloadBlocked(false) };
}

export function BrowserBar({
  view,
  activeConversationId,
  downloadBlocked,
  onDismissDownload,
  onStopAssistant,
}: {
  view: BrowserView;
  /// The conversation on screen (the Stop button says when the driving
  /// reply belongs to another one).
  activeConversationId: number | null;
  downloadBlocked: boolean;
  onDismissDownload: () => void;
  /// Stop the reply that is driving the browser (`chat_stop`).
  onStopAssistant: (conversationId: number) => void;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  // A failed control's alert goes away on the next browser change.
  useEffect(() => {
    setFailed(false);
  }, [view]);
  if (!view.open) return null;

  const run = (action: BrowserControl) => {
    setFailed(false);
    controlBrowser(action).catch(() => setFailed(true));
  };
  const address = displayAddress(view.url);
  const agent = view.agent_conversation;
  const stopLabel = agent !== null && agent !== activeConversationId ? t.browser.stopOther : t.browser.stop;

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
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => run("reload")} aria-label={t.browser.reload} title={t.browser.reload}>
            <IconReload size={14} />
          </button>
        </div>
        {/* Read-only and NOT a live region: navigations are not announced. */}
        <input
          className="browser-bar-address"
          readOnly
          value={address || t.browser.noPage}
          aria-label={t.browser.address}
          title={view.url ?? undefined}
        />
        {view.loading && <span className="browser-bar-loading">{t.browser.loading}</span>}
        <div className="browser-bar-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => run("show")} aria-label={t.browser.show} title={t.browser.show}>
            <IconExternal size={13} /> <span className="browser-bar-label">{t.browser.show}</span>
          </button>
          {agent !== null && (
            <button type="button" className="btn btn-sm btn-warn-solid" onClick={() => onStopAssistant(agent)}>
              <IconStop size={13} /> {stopLabel}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => run("close")} aria-label={t.browser.close} title={t.browser.close}>
            <IconX size={14} />
          </button>
        </div>
      </div>
      {agent !== null && <p className="browser-bar-status">{t.browser.agentActive}</p>}
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
