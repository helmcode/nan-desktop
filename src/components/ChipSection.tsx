// A collapsed-by-default section under an answer (web sources, files the
// assistant produced). The header shows the label and the count; the chips
// render only once the user expands it, so long lists do not crowd the chat.

import { useId, useState, type ReactNode } from "react";
import { IconChevronDown } from "../icons";

export function ChipSection({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className={`sources${open ? " open" : ""}`} role="group" aria-label={label}>
      <button
        type="button"
        className="sources-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sources-label">{label}</span>
        <span className="sources-count">{count}</span>
        <IconChevronDown size={14} className="sources-chevron" />
      </button>
      {open && <ul id={listId}>{children}</ul>}
    </div>
  );
}
