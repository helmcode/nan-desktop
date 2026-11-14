// Shared artifacts (F4): the "Shared links" view (design 5.3), a Settings
// section. Lists my links (and, for an org admin on Helmcode, the whole
// org's) with Copy link, Open and Revoke. Revoking asks first: "People with
// this link will lose access immediately."

import { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeLayer, isTopLayer } from "../escapeLayers";
import { useI18n, type Strings } from "../i18n";
import { IconArrowLeft, IconCopy, IconExternal, IconTrash } from "../icons";
import { openExternal } from "../Markdown";
import {
  linkState,
  listArtifacts,
  revokeArtifact,
  type ArtifactProblem,
  type SharedArtifact,
} from "./artifacts";
import { ArtifactProblemLine, copyLink } from "./ShareArtifactDialog";

type Tab = "mine" | "org";
type Filter = "active" | "inactive";
type Load = { status: "loading" } | { status: "ready"; items: SharedArtifact[]; total: number } | { status: "error"; problem: ArtifactProblem };

/** "in 3 days" / "2 days ago" in the UI locale; "" for an unreadable date. */
export function relativeTime(value: string | null, locale: string, now = Date.now()): string {
  if (!value) return "";
  const at = Date.parse(value);
  if (Number.isNaN(at)) return "";
  const diff = at - now;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(diff / 3600000);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  return rtf.format(Math.round(diff / 86400000), "day");
}

/** The scope chip text of a link. */
export function scopeLabel(t: Strings, artifact: SharedArtifact): string {
  const l = t.artifacts.links;
  switch (artifact.scope) {
    case "public":
      return l.scopePublic;
    case "members":
      return l.scopeMembers;
    case "org":
      return l.scopeOrg;
    default:
      return l.scopePeople(artifact.recipientCount);
  }
}

export function SharedLinksView({
  profileId,
  admin,
  onBack,
  backLabel,
  onNotice,
  onSignIn,
}: {
  profileId: string;
  /** An org admin on Helmcode: shows the Organization tab. */
  admin: boolean;
  onBack: () => void;
  backLabel?: string;
  onNotice: (kind: "success" | "error", text: string) => void;
  onSignIn: () => void;
}) {
  const { t, locale } = useI18n();
  const l = t.artifacts.links;
  const [tab, setTab] = useState<Tab>("mine");
  const [filter, setFilter] = useState<Filter>("active");
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [revoking, setRevoking] = useState<SharedArtifact | null>(null);
  const activeTab: Tab = admin ? tab : "mine";

  const refresh = useCallback(async (): Promise<void> => {
    setLoad({ status: "loading" });
    const res = await listArtifacts(profileId, activeTab === "org");
    setLoad(res.ok ? { status: "ready", items: res.items, total: res.total } : { status: "error", problem: res.problem });
  }, [profileId, activeTab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = async (artifact: SharedArtifact): Promise<void> => {
    if (!artifact.url) return;
    const ok = await copyLink(artifact.url);
    onNotice(ok ? "success" : "error", ok ? t.artifacts.copied : t.artifacts.copyFailed);
  };

  const now = Date.now();
  const items =
    load.status === "ready"
      ? load.items.filter((item) => (linkState(item, now) === "active") === (filter === "active"))
      : [];

  return (
    <section className="settings links-view" aria-labelledby="links-title">
      <header className="settings-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft size={16} />
          {backLabel ?? t.settings.back}
        </button>
        <h1 id="links-title">{l.title}</h1>
        <p className="section-lede">{l.lede}</p>
        {admin && (
          <div className="skills-tabs" role="tablist" aria-label={l.title}>
            {(["mine", "org"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={activeTab === key}
                className={`skills-tab${activeTab === key ? " active" : ""}`}
                onClick={() => setTab(key)}
              >
                {key === "mine" ? l.mine : l.organization}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="settings-body">
        <div className="links-toolbar">
          <div className="links-filter" role="group" aria-label={l.filterLabel}>
            {(["active", "inactive"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className="btn btn-ghost btn-sm"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
              >
                {key === "active" ? l.active : l.inactive}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>
            {l.refresh}
          </button>
        </div>

        {load.status === "loading" && <p className="skills-notice">{l.loading}</p>}
        {load.status === "error" && (
          <>
            <ArtifactProblemLine problem={load.problem} onSignIn={onSignIn} />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>
              {l.retry}
            </button>
          </>
        )}
        {load.status === "ready" && items.length === 0 && (
          <p className="skills-notice">{filter === "active" ? l.empty : l.emptyInactive}</p>
        )}
        {load.status === "ready" && load.total > load.items.length && (
          <p className="skills-notice links-partial">{l.partial(load.items.length, load.total)}</p>
        )}
        {items.length > 0 && (
          <ul className="links-list" aria-label={l.title}>
            {items.map((item) => {
              const state = linkState(item, now);
              const name = item.title || item.filename;
              return (
                <li key={item.id} className="links-row" data-testid="link-row">
                  <div className="links-row-main">
                    <span className="links-row-title" title={name}>
                      {name}
                    </span>
                    <span className="links-row-meta">
                      <span className="skill-badge">{scopeLabel(t, item)}</span>
                      <span>
                        {state === "revoked"
                          ? l.revoked
                          : state === "expired"
                            ? l.expired
                            : item.expiresAt
                              ? l.expires(relativeTime(item.expiresAt, locale, now))
                              : l.never}
                      </span>
                      <span>{l.views(item.viewCount)}</span>
                      {item.createdAt && <span>{l.created(relativeTime(item.createdAt, locale, now))}</span>}
                      {activeTab === "org" && item.owner && <span>{l.by(item.owner)}</span>}
                    </span>
                  </div>
                  {state === "active" && (
                    <div className="links-row-actions">
                      {item.url && (
                        <>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={l.copyLabel(name)}
                            onClick={() => void copy(item)}
                          >
                            <IconCopy size={14} />
                            {l.copy}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={l.openLabel(name)}
                            onClick={() => openExternal(item.url ?? "")}
                          >
                            <IconExternal size={14} />
                            {l.open}
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        aria-label={l.revokeLabel(name)}
                        onClick={() => setRevoking(item)}
                      >
                        <IconTrash size={14} />
                        {l.revoke}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {revoking && (
        <RevokeDialog
          profileId={profileId}
          artifact={revoking}
          admin={activeTab === "org"}
          onSignIn={onSignIn}
          onCancel={() => setRevoking(null)}
          onRevoked={(artifact) => {
            setRevoking(null);
            onNotice("success", l.revoked_notice(artifact.title || artifact.filename));
            void refresh();
          }}
        />
      )}
    </section>
  );
}

function RevokeDialog({
  profileId,
  artifact,
  admin,
  onSignIn,
  onCancel,
  onRevoked,
}: {
  profileId: string;
  artifact: SharedArtifact;
  admin: boolean;
  onSignIn: () => void;
  onCancel: () => void;
  onRevoked: (artifact: SharedArtifact) => void;
}) {
  const t = useI18n().t;
  const l = t.artifacts.links;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ArtifactProblem | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const layer = useEscapeLayer(true);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (!isTopLayer(layer)) return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [layer, onCancel]);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const res = await revokeArtifact(profileId, artifact.id, admin);
    setBusy(false);
    if (res.ok) onRevoked(artifact);
    else setProblem(res.problem);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="modal modal-warn"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="revoke-title"
        aria-describedby="revoke-body"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="revoke-title">{l.revokeTitle}</h2>
        <p className="modal-note">
          <strong>{artifact.title || artifact.filename}</strong>
        </p>
        <p id="revoke-body" className="share-warning">
          {l.revokeBody}
        </p>
        {problem && <ArtifactProblemLine problem={problem} onSignIn={onSignIn} />}
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onCancel}>
            {t.app.cancel}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
            {busy ? l.revoking : l.revokeConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
