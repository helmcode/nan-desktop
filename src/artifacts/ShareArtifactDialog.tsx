// Shared artifacts (F3): the "Share as a link" dialog (design 5.2). Built on
// the ShareDialog modal pattern: backdrop, role=dialog, Escape cancels as
// the innermost layer, initial focus on Cancel, a role=alert problem line.
//
// Scopes per tenant (R21): enterprise shares with picked org members, the
// whole org or the public; community with specific NaN members by email
// (they sign in with their NaN account to open it) or the public.
//
// The risk warning (public, or community email recipients) is bold, sits in
// a role=alert block and comes with a required checkbox: "Create link"
// stays disabled until it is checked, and it unchecks itself whenever the
// risk grows (switching to public, a recipient added). The core does the
// reading and the upload; this component never sees the bytes.

import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { folderName } from "../copy";
import { isTopLayer, useEscapeLayer } from "../escapeLayers";
import { useT, type Strings } from "../i18n";
import { IconCopy, IconExternal, IconFile, IconShare, IconWarning, IconX } from "../icons";
import { openExternal } from "../Markdown";
import { extensionOf } from "../preview/kind";
import {
  ENTERPRISE_PROFILE,
  MAX_ARTIFACT_MB,
  MAX_RECIPIENTS,
  MAX_TITLE_CHARS,
  ackCovers,
  addEmails,
  buildMeta,
  canSubmit,
  defaultExpiry,
  expiryOptions,
  NO_EXPIRY,
  fetchMembers,
  pickableMembers,
  riskFor,
  scopeOptions,
  shareArtifact,
  type ArtifactProblem,
  type Availability,
  type Member,
  type Risk,
  type ShareScope,
  type ShareSource,
} from "./artifacts";

/** Localized text for an artifacts problem. */
export function artifactProblemText(t: Strings, problem: ArtifactProblem): string {
  const p = t.artifacts.problems;
  switch (problem) {
    case "too_large":
      return p.too_large(MAX_ARTIFACT_MB);
    case "too_many_recipients":
      return p.too_many_recipients(MAX_RECIPIENTS);
    case "recipient_not_user":
      return p.recipient_not_user;
    default:
      return p[problem];
  }
}

export function ArtifactProblemLine({
  problem,
  onSignIn,
  text,
}: {
  problem: ArtifactProblem;
  onSignIn: () => void;
  /** Overrides the problem's own copy (a more specific message). */
  text?: string;
}) {
  const t = useT();
  const soft = problem === "rate_limited" || problem === "offline";
  return (
    <p className={soft ? "skills-notice" : "inline-error"} role="alert" data-testid="artifact-problem">
      {text ?? artifactProblemText(t, problem)}
      {problem === "expired" && (
        <>
          {" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSignIn}>
            {t.artifacts.signIn}
          </button>
        </>
      )}
    </p>
  );
}

/** Copy `url` to the clipboard; resolves whether it worked. */
export async function copyLink(url: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    return false;
  }
}

/** The modal shell shared by the form, the success and the paywall views. */
function useModalEscape(onClose: () => void): void {
  const layer = useEscapeLayer(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (!isTopLayer(layer)) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [layer, onClose]);
}

type Success = { url: string; scope: ShareScope };

export function ShareArtifactDialog({
  profileId,
  source,
  availability,
  onClose,
  onManage,
  onNotice,
  onSignIn,
  onDisabled,
  selfEmail = null,
}: {
  profileId: string;
  source: ShareSource;
  /** The signed-in account: never offered in the member picker (R20-B). */
  selfEmail?: string | null;
  /** `paywall` shows the membership copy instead of the form. */
  availability: Exclude<Availability, "off">;
  onClose: () => void;
  /** "Manage links": opens the Shared links view. */
  onManage: () => void;
  /** A transient notice (the copy confirmation). */
  onNotice: (kind: "success" | "error", text: string) => void;
  onSignIn: () => void;
  /** The server says the feature is off (404): the caller hides the action. */
  onDisabled: () => void;
}) {
  const t = useT();
  const a = t.artifacts;
  const enterprise = profileId === ENTERPRISE_PROFILE;
  const fileName = folderName(source.path);
  const [paywall, setPaywall] = useState(availability === "paywall");
  const [success, setSuccess] = useState<Success | null>(null);

  // ---- the form --------------------------------------------------------
  const [title, setTitle] = useState(fileName);
  const [scope, setScope] = useState<ShareScope>(() => scopeOptions(profileId)[0]);
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [emailError, setEmailError] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [memberQuery, setMemberQuery] = useState("");
  // undefined: loading; null: unavailable.
  const [members, setMembers] = useState<Member[] | null | undefined>(enterprise ? undefined : null);
  const [expiresDays, setExpiresDays] = useState<number>(() => defaultExpiry(scopeOptions(profileId)[0]));
  const [notify, setNotify] = useState(true);
  const [ackedRisk, setAckedRisk] = useState<Risk | null>(null);
  // The emails the server said are not NaN users (recipient_not_user).
  const [rejected, setRejected] = useState<string[]>([]);
  const [secretWarning, setSecretWarning] = useState(false);
  const [secretAck, setSecretAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ArtifactProblem | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useModalEscape(onClose);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!enterprise) return;
    let alive = true;
    void fetchMembers(profileId).then((list) => {
      if (alive) setMembers(list);
    });
    return () => {
      alive = false;
    };
  }, [enterprise, profileId]);

  const risk: Risk | null = useMemo(() => riskFor(scope, emails), [scope, emails]);
  const acked = ackedRisk !== null && ackCovers(ackedRisk, risk);

  // The acceptance resets as soon as the risk grows past what was accepted.
  useEffect(() => {
    if (ackedRisk !== null && !ackCovers(ackedRisk, risk)) setAckedRisk(null);
  }, [ackedRisk, risk]);

  // Still listed and rejected: the chips to mark and the names to show.
  const notUsers = emails.filter((email) => rejected.includes(email));

  const draft = { title, scope, emails, memberIds, expiresDays, notify };
  const titleTooLong = [...title.trim()].length > MAX_TITLE_CHARS;
  const ready = canSubmit(draft, risk, acked, busy) && (!secretWarning || secretAck);

  const chooseScope = (next: ShareScope): void => {
    setScope(next);
    // Each scope starts from its own default (design 3.5): public the
    // shortest, never a longer one carried over from another scope.
    setExpiresDays(defaultExpiry(next));
    setProblem(null);
  };

  const commitEmails = (text: string): void => {
    if (!text.trim()) return;
    const res = addEmails(emails, text);
    setEmails(res.emails);
    setEmailInput(res.invalid.join(", "));
    setEmailError(
      res.invalid.length > 0 ? a.emailInvalid(res.invalid[0]) : res.overflow > 0 ? a.emailsFull(MAX_RECIPIENTS) : "",
    );
  };

  const onEmailKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Enter" || e.key === "," || e.key === ";") {
      e.preventDefault();
      commitEmails(emailInput);
    } else if (e.key === "Backspace" && emailInput === "" && emails.length > 0) {
      removeEmail(emails[emails.length - 1]);
    }
  };

  const onEmailPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData("text");
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault();
      commitEmails(`${emailInput} ${text}`);
    }
  };

  const toggleMember = (userId: string): void => {
    setMemberIds((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  };

  const removeEmail = (email: string): void => {
    const next = emails.filter((item) => item !== email);
    setEmails(next);
    // Once every named rejected email is gone, so is its message. A rejection
    // that named nobody stays until the next submit: the bad email may remain.
    if (
      problem === "recipient_not_user" &&
      rejected.includes(email) &&
      !next.some((item) => rejected.includes(item))
    ) {
      setRejected([]);
      setProblem(null);
    }
  };

  const confirm = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    setRejected([]);
    const result = await shareArtifact(profileId, source, buildMeta(draft, risk, secretWarning && secretAck));
    setBusy(false);
    if (result.ok) {
      setSuccess({ url: result.url, scope });
      return;
    }
    switch (result.problem) {
      case "risk_ack_required":
        // The server wants the warning accepted again: show it unchecked.
        setAckedRisk(null);
        break;
      case "recipient_not_user":
        setRejected(result.rejected ?? []);
        break;
      case "possible_secret":
        setSecretWarning(true);
        setSecretAck(false);
        break;
      case "paywall":
        setPaywall(true);
        return;
      case "disabled":
        onDisabled();
        break;
    }
    setProblem(result.problem);
  };

  if (paywall) return <PaywallDialog onClose={onClose} />;
  if (success) {
    return <SuccessDialog success={success} onClose={onClose} onManage={onManage} onNotice={onNotice} />;
  }

  const others = pickableMembers(members ?? [], selfEmail);
  const filteredMembers = others.filter((member) => member.email.includes(memberQuery.trim().toLowerCase()));
  const riskText = risk?.kind === "public" ? a.riskV1.public : a.riskV1.community;
  const problemText =
    problem === "recipient_not_user" && notUsers.length > 0 ? a.notUsers(notUsers.join(", "), notUsers.length) : undefined;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal share-dialog artifact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-title"
        aria-describedby={risk ? "artifact-risk" : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="artifact-title">{a.dialogTitle}</h2>
        <p className="artifact-file">
          <IconFile size={15} />
          <span className="artifact-file-name" title={fileName}>
            {fileName}
          </span>
          <span className="artifact-file-kind">
            {a.fileSummary(extensionOf(source.path).toUpperCase(), "")}
          </span>
        </p>

        <label className="artifact-field">
          <span className="artifact-label">{a.titleLabel}</span>
          <input
            className="text-input"
            type="text"
            value={title}
            maxLength={MAX_TITLE_CHARS * 2}
            aria-invalid={titleTooLong}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        {titleTooLong && (
          <p className="inline-error" role="alert">
            {a.titleTooLong(MAX_TITLE_CHARS)}
          </p>
        )}

        <fieldset className="artifact-scopes">
          <legend className="artifact-label">{a.scopeLegend}</legend>
          {scopeOptions(profileId).map((option) => (
            <label key={option} className="artifact-radio">
              <input
                type="radio"
                name="artifact-scope"
                value={option}
                checked={scope === option}
                onChange={() => chooseScope(option)}
              />
              <span>{a.scopes[option]}</span>
            </label>
          ))}
        </fieldset>

        {scope === "emails" && (
          <div className="artifact-field">
            <label className="artifact-label" htmlFor="artifact-emails">
              {a.emailsLabel}
            </label>
            {emails.length > 0 && (
              <ul className="artifact-chips" aria-label={a.emailsLabel}>
                {emails.map((email) => (
                  <li key={email} className="artifact-chip">
                    <span>{email}</span>
                    {notUsers.includes(email) && <span className="skill-badge artifact-external">{a.notUser}</span>}
                    <button
                      type="button"
                      className="artifact-chip-remove"
                      aria-label={a.removeEmail(email)}
                      onClick={() => removeEmail(email)}
                    >
                      <IconX size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <input
              id="artifact-emails"
              className="text-input"
              type="email"
              inputMode="email"
              autoComplete="off"
              placeholder={a.emailsPlaceholder}
              value={emailInput}
              aria-describedby="artifact-emails-hint"
              aria-invalid={emailError !== ""}
              onChange={(e) => {
                setEmailInput(e.target.value);
                setEmailError("");
              }}
              onKeyDown={onEmailKey}
              onPaste={onEmailPaste}
              onBlur={() => commitEmails(emailInput)}
            />
            <span id="artifact-emails-hint" className="skill-hint">
              {a.emailsHint}
            </span>
            {emailError && (
              <p className="inline-error" role="alert">
                {emailError}
              </p>
            )}
          </div>
        )}

        {scope === "members" && (
          <div className="artifact-field">
            <span className="artifact-label">{a.membersLabel}</span>
            {members === undefined ? (
              <p className="skills-notice">{a.membersLoading}</p>
            ) : members === null ? (
              <p className="inline-error" role="alert">
                {a.membersUnavailable}
              </p>
            ) : (
              <>
                <input
                  className="text-input"
                  type="search"
                  placeholder={a.membersSearch}
                  aria-label={a.membersSearch}
                  value={memberQuery}
                  onChange={(e) => setMemberQuery(e.target.value)}
                />
                <ul className="artifact-members" aria-label={a.membersLabel}>
                  {filteredMembers.length === 0 && (
                    <li className="skills-notice">{others.length === 0 ? a.membersOnlyYou : a.membersNone}</li>
                  )}
                  {filteredMembers.map((member) => (
                    <li key={member.userId}>
                      <label className="artifact-radio">
                        <input
                          type="checkbox"
                          checked={memberIds.includes(member.userId)}
                          onChange={() => toggleMember(member.userId)}
                        />
                        <span>{member.email}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <span className="skill-hint">{a.membersSelected(memberIds.length)}</span>
              </>
            )}
          </div>
        )}

        {(scope === "emails" || scope === "members") && (
          <label className="artifact-radio">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>{a.notify}</span>
          </label>
        )}

        <label className="artifact-field artifact-inline">
          <span className="artifact-label">{a.expiresLabel}</span>
          <select
            className="text-input artifact-select"
            value={String(expiresDays)}
            onChange={(e) => setExpiresDays(Number(e.target.value))}
          >
            {expiryOptions(scope).map((days) => (
              <option key={days} value={String(days)}>
                {days === NO_EXPIRY ? a.expiresNever : a.expiresDays(days)}
              </option>
            ))}
          </select>
        </label>

        {risk && (
          <div className="artifact-risk" data-testid="artifact-risk">
            <p id="artifact-risk" role="alert">
              <IconWarning size={15} />
              <strong>{riskText}</strong>
            </p>
            <label className="artifact-radio artifact-accept">
              <input
                type="checkbox"
                checked={acked}
                required
                onChange={(e) => setAckedRisk(e.target.checked ? risk : null)}
              />
              <strong>{a.riskV1.accept}</strong>
            </label>
          </div>
        )}

        {secretWarning && (
          <div className="artifact-risk" data-testid="artifact-secret">
            <p role="alert">
              <IconWarning size={15} />
              <strong>{a.secretWarning}</strong>
            </p>
            <label className="artifact-radio artifact-accept">
              <input type="checkbox" checked={secretAck} onChange={(e) => setSecretAck(e.target.checked)} />
              <strong>{a.secretAccept}</strong>
            </label>
          </div>
        )}

        {problem && problem !== "possible_secret" && (
          <ArtifactProblemLine problem={problem} onSignIn={onSignIn} text={problemText} />
        )}

        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onClose}>
            {t.app.cancel}
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready} onClick={() => void confirm()}>
            <IconShare size={14} />
            {busy ? a.creating : a.create}
          </button>
        </div>
      </div>
    </div>
  );
}

function SuccessDialog({
  success,
  onClose,
  onManage,
  onNotice,
}: {
  success: Success;
  onClose: () => void;
  onManage: () => void;
  onNotice: (kind: "success" | "error", text: string) => void;
}) {
  const a = useT().artifacts;
  const linkRef = useRef<HTMLInputElement | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    linkRef.current?.focus();
    linkRef.current?.select();
  }, []);

  const copy = async (): Promise<void> => {
    const ok = await copyLink(success.url);
    setCopyState(ok ? "copied" : "failed");
    if (ok) onNotice("success", a.copied);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal share-dialog artifact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-ready"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="artifact-ready">{a.linkReady}</h2>
        <label className="artifact-field">
          <span className="artifact-label">{a.linkLabel}</span>
          <input
            ref={linkRef}
            className="text-input artifact-link"
            type="text"
            readOnly
            value={success.url}
            onFocus={(e) => e.target.select()}
          />
        </label>
        {success.scope === "public" && (
          <p className="share-warning">
            <strong>{a.publicReminder}</strong>
          </p>
        )}
        <p className="skills-notice" role="status" aria-live="polite">
          {copyState === "copied" ? a.copied : ""}
        </p>
        {copyState === "failed" && (
          <p className="inline-error" role="alert">
            {a.copyFailed}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onManage}>
            {a.manage}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => openExternal(success.url)}>
            <IconExternal size={14} />
            {a.openLink}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
            <IconCopy size={14} />
            {a.copy}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {a.done}
          </button>
        </div>
      </div>
    </div>
  );
}

function PaywallDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const a = t.artifacts;
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalEscape(onClose);
  useEffect(() => closeRef.current?.focus(), []);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal artifact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="artifact-paywall"
        aria-describedby="artifact-paywall-body"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="artifact-paywall">{a.paywallTitle}</h2>
        <p id="artifact-paywall-body" className="modal-note">
          {a.paywallBody}
        </p>
        <div className="modal-actions">
          <button ref={closeRef} type="button" className="btn btn-primary" onClick={onClose}>
            {a.paywallOk}
          </button>
        </div>
      </div>
    </div>
  );
}
