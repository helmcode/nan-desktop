// Links the assistant created with share_artifact, under its reply: the
// title, who can open it, the expiry, the link itself, and "Copy link" /
// "Open". The core stored them on the message (device-local); the same
// links also live server-side, so they show in Shared links too.

import { useEffect, useRef, useState } from "react";
import { openExternal } from "../Markdown";
import { useI18n, useT } from "../i18n";
import { IconCopy, IconExternal, IconShare } from "../icons";
import type { SharedLink } from "../types";
import { copyLink } from "./ShareArtifactDialog";
import "./SharedLinkCards.css";

/** Only links the core vetted (https, no spaces) are ever opened. */
export function isOpenableLink(url: string): boolean {
  return /^https:\/\/[^\s]+$/.test(url);
}

/** "12 dic 2026"-style date in `locale`, or null when unparsable. */
export function formatExpiry(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(at));
}

type CopyState = "copied" | "failed";

export function SharedLinkCards({ links }: { links: SharedLink[] }) {
  const t = useT();
  const { locale } = useI18n();
  const [copy, setCopy] = useState<{ url: string; state: CopyState } | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const visible = links.filter((link) => isOpenableLink(link.url));
  if (visible.length === 0) return null;

  const onCopy = async (url: string) => {
    const ok = await copyLink(url);
    setCopy({ url, state: ok ? "copied" : "failed" });
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (ok) timer.current = window.setTimeout(() => setCopy(null), 2500);
  };

  return (
    <ul className="shared-links" aria-label={t.shareTool.region}>
      {visible.map((link) => {
        const scope =
          link.scope === "public"
            ? t.shareTool.scope.public
            : link.scope === "org"
              ? t.shareTool.scope.org
              : t.shareTool.scope.emails(link.recipients.length);
        const expiry = formatExpiry(link.expires_at, locale);
        const state = copy?.url === link.url ? copy.state : null;
        return (
          <li key={link.url} className="shared-link-card">
            <span className="shared-link-icon" aria-hidden="true">
              <IconShare size={16} />
            </span>
            <div className="shared-link-text">
              <strong className="shared-link-title">{link.title}</strong>
              <span className="shared-link-meta">
                {scope}
                {link.scope === "emails" && link.recipients.length > 0 && (
                  <span title={link.recipients.join(", ")}> ({link.recipients.join(", ")})</span>
                )}
                {expiry && <> · {t.shareTool.expiresOn(expiry)}</>}
              </span>
              <code className="shared-link-url" title={link.url}>
                {link.url}
              </code>
              {state === "failed" && (
                <span className="shared-link-error" role="alert">
                  {t.shareTool.copyFailed}
                </span>
              )}
            </div>
            <div className="shared-link-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t.shareTool.copyLabel(link.title)}
                onClick={() => void onCopy(link.url)}
              >
                <IconCopy size={14} />
                <span role={state === "copied" ? "status" : undefined}>
                  {state === "copied" ? t.shareTool.copied : t.shareTool.copy}
                </span>
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={t.shareTool.openLabel(link.title)}
                onClick={() => openExternal(link.url)}
              >
                <IconExternal size={14} />
                {t.shareTool.open}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
