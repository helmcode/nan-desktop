// S14: inline approval card in the chat stream. Pending: icon + action
// summary + Deny/Allow in place. Resolved: a single line with the outcome.
// The card is an affordance only; the core mediates every decision.

import type { ReactNode } from "react";
import type { ApprovalCardState } from "../chat/approvals";
import { isOpen } from "../chat/approvals";
import { useT } from "../i18n";
import { IconCheck, IconFile, IconFolder, IconGlobe, IconImage, IconMove, IconTerminal, IconTrash, IconX } from "../icons";

// Action kinds are the core's ToolAction::kind() values.
function actionIcon(action: string): ReactNode {
  switch (action) {
    case "delete_path":
      return <IconTrash size={16} />;
    case "run_command":
      return <IconTerminal size={16} />;
    case "move_path":
      return <IconMove size={16} />;
    case "save_image":
      return <IconImage size={16} />;
    case "write_website":
    case "browser_site":
    case "browser_site_used":
    case "browser_local_site":
    case "browser_login":
    case "browser_payment":
      return <IconGlobe size={16} />;
    case "read_file":
    case "list_files":
      return <IconFolder size={16} />;
    default:
      return <IconFile size={16} />;
  }
}

export function ApprovalCard({
  card,
  onRespond,
}: {
  card: ApprovalCardState;
  onRespond: (id: string, granted: boolean) => void;
}) {
  const t = useT();
  const summary = t.approval.actions[card.action] ?? t.approval.actions.unknown;
  const danger = card.action === "delete_path" || card.action === "run_command" || card.action === "browser_payment";
  const detail = t.approval.details[card.action];

  if (card.notice) {
    return (
      <div className="approval-line granted" role="status">
        {actionIcon(card.action)}
        <span className="approval-line-text">{summary}</span>
        <code className="approval-line-target" title={card.target}>
          {card.target}
        </code>
      </div>
    );
  }

  if (!isOpen(card)) {
    const granted = card.status === "granted";
    return (
      <div className={`approval-line${granted ? " granted" : " denied"}`} role="status">
        {granted ? <IconCheck size={14} /> : <IconX size={14} />}
        <span className="approval-line-text">
          {granted ? t.approval.allowed : t.approval.denied}: {summary}
        </span>
        <code className="approval-line-target" title={card.target}>
          {card.target}
        </code>
      </div>
    );
  }

  const sending = card.status === "sending";
  return (
    <div className={`approval-card${danger ? " danger" : ""}`} role="group" aria-label={t.approval.region}>
      <span className="approval-icon" aria-hidden="true">
        {actionIcon(card.action)}
      </span>
      <div className="approval-text">
        <strong>{summary}</strong>
        <code className="approval-target" title={card.target}>
          {card.target}
        </code>
        {card.destination && (
          <span className="approval-destination">
            {t.approval.to} <code title={card.destination}>{card.destination}</code>
          </span>
        )}
        {card.cwd && (
          <span className="approval-destination">
            {t.approval.inFolder} <code title={card.cwd}>{card.cwd}</code>
          </span>
        )}
        {detail && <span className="approval-detail">{detail}</span>}
        {card.permanent && <span className="approval-permanent">{t.approval.permanent}</span>}
        {card.diffPreview && (
          <details className="approval-diff">
            <summary>{t.approval.changes}</summary>
            <pre>{card.diffPreview}</pre>
          </details>
        )}
        {card.failed && (
          <span className="approval-error" role="alert">
            {t.approval.failed}
          </span>
        )}
      </div>
      <div className="approval-actions">
        {sending ? (
          <span className="approval-sending" role="status">
            {t.approval.sending}
          </span>
        ) : (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRespond(card.id, false)}>
              {t.approval.deny}
            </button>
            <button
              type="button"
              className={`btn btn-sm ${danger ? "btn-warn-solid" : "btn-primary"}`}
              onClick={() => onRespond(card.id, true)}
            >
              {t.approval.allow}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
