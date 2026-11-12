// Round 15 (F6): long tool-heavy turns must not look hung. While a turn runs
// (awaiting the model or a tool, even with no stream chunk for a while) the
// chat shows animated dots and the elapsed seconds, ticking once a second.
// It goes away on done, stop or error (the conversation leaves the
// streaming set).
//
// Round 16: ONE activity line, inside the chat flow, directly under the last
// message (where the streaming "Thinking" line lives): "Thinking · 4 s",
// "Working · 1 min 05 s". The old composer-footer line floated far from both
// the message and the composer and duplicated the bubble's activity; it is
// gone. The label says what the assistant does, the dots say it is alive,
// the clock says for how long. While text streams the caret replaces it.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";

/** Whole seconds between `startedAt` and `now`, never negative. */
export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * When each running turn started: ids that join `running` get `now()`, ids
 * that leave are forgotten. Pure so the clock survives switching chats (the
 * map lives in the shell, not in the indicator).
 */
export function trackTurnStarts(
  starts: ReadonlyMap<number, number>,
  running: ReadonlySet<number>,
  now: () => number,
): Map<number, number> {
  const next = new Map<number, number>();
  for (const id of running) next.set(id, starts.get(id) ?? now());
  return next;
}

/** The start time of every running turn, kept across renders. */
export function useTurnStarts(running: ReadonlySet<number>): ReadonlyMap<number, number> {
  const starts = useRef<Map<number, number>>(new Map());
  starts.current = trackTurnStarts(starts.current, running, Date.now);
  return starts.current;
}

/** Drops a trailing ellipsis or full stop: the animated dots already say
 * "ongoing", and a stop before them reads "minute. ••• · 12 s". */
export function activityLabel(label: string): string {
  return label.replace(/(…|\.+)\s*$/, "");
}

export function TurnIndicator({
  label,
  icon,
  startedAt,
}: {
  label: string;
  icon?: ReactNode;
  startedAt?: number;
}) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <p className="activity turn-activity" role="status" data-testid="turn-indicator">
      {icon}
      <span className="turn-indicator-label">{activityLabel(label)}</span>
      <span className="turn-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {/* Ticks every second: hidden from assistive tech so the polite status
          is not re-read on each tick; the label says what is happening. */}
      {startedAt !== undefined && (
        <span className="turn-elapsed" aria-hidden="true">
          {"· "}
          {t.chat.turnElapsed(elapsedSeconds(startedAt, now))}
        </span>
      )}
    </p>
  );
}
