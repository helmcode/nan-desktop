// Round 15 (F6): long tool-heavy turns must not look hung. While a turn runs
// (awaiting the model or a tool, even with no stream chunk for a while) the
// composer shows a persistent "In progress" line with animated dots and the
// elapsed seconds, ticking once a second. It goes away on done, stop or error
// (the conversation leaves the streaming set).
//
// D5: the label is deliberately NOT "Working": the streaming bubble already
// says what the assistant is doing ("Working…", "Searching…"); the composer
// line only says the turn is still running and for how long, so the two
// never read the same at once.

import { useEffect, useRef, useState } from "react";
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

export function TurnIndicator({ startedAt }: { startedAt: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return (
    <p className="turn-indicator" data-testid="turn-indicator">
      <span className="turn-indicator-label">{t.chat.turnWorking}</span>
      <span className="turn-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {/* Ticks every second: hidden from assistive tech so it is not read
          out on each tick; the label above says what is happening. */}
      <span className="turn-elapsed" aria-hidden="true">
        {t.chat.turnElapsed(elapsedSeconds(startedAt, now))}
      </span>
    </p>
  );
}
