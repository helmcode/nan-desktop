// R20-E: when the app asks the core for updates (`update_check`).
//
// - On startup.
// - Every 2 hours (it was 6: with a laptop that sleeps most of the day, the
//   timers pause and the check rarely ran, so the 0.2.8 notice never came).
// - When the window comes back (focus, visible again, back online) after
//   more than 2 hours away: hidden, in the background, or asleep (a sleep
//   shows up as a last check older than the interval).
// - Never more than once per 30 minutes, and never two at a time.
//
// The decisions are pure and unit-tested; `startUpdateSchedule` wires them
// to the window. A failing check is silent (the caller's `run` decides
// what to show).

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The periodic check. */
export const UPDATE_CHECK_INTERVAL_MS = 2 * HOUR;
/** Away for longer than this, coming back checks right away. */
export const UPDATE_RESUME_AFTER_MS = 2 * HOUR;
/** The closest two checks may ever be. */
export const UPDATE_MIN_GAP_MS = 30 * MINUTE;

/** Whether a check may run now, given when the last one started. */
export function canCheckNow(now: number, lastCheckAt: number | null, minGapMs = UPDATE_MIN_GAP_MS): boolean {
  return lastCheckAt === null || now - lastCheckAt >= minGapMs;
}

/**
 * Coming back to the window: check when it was away for more than
 * [`UPDATE_RESUME_AFTER_MS`] (`awaySince`, null when it never left), or
 * when the last check is an interval old (the timers did not run: asleep).
 * Always within the 30-minute gap.
 */
export function shouldCheckOnReturn(
  now: number,
  lastCheckAt: number | null,
  awaySince: number | null,
  { resumeAfterMs = UPDATE_RESUME_AFTER_MS, minGapMs = UPDATE_MIN_GAP_MS } = {},
): boolean {
  if (!canCheckNow(now, lastCheckAt, minGapMs)) return false;
  if (lastCheckAt === null) return true;
  const away = awaySince === null ? 0 : now - awaySince;
  return away > resumeAfterMs || now - lastCheckAt >= resumeAfterMs;
}

type Win = Pick<EventTarget, "addEventListener" | "removeEventListener"> &
  Pick<Window, "setInterval" | "clearInterval">;
type Doc = Pick<EventTarget, "addEventListener" | "removeEventListener"> & { visibilityState: DocumentVisibilityState };

export interface UpdateScheduleOptions {
  /** One check; its failure is swallowed here. */
  run: () => Promise<unknown>;
  win?: Win;
  doc?: Doc;
  now?: () => number;
  intervalMs?: number;
  resumeAfterMs?: number;
  minGapMs?: number;
}

/** Start checking (one check now). Returns the stop function. */
export function startUpdateSchedule({
  run,
  win = window,
  doc = document,
  now = () => Date.now(),
  intervalMs = UPDATE_CHECK_INTERVAL_MS,
  resumeAfterMs = UPDATE_RESUME_AFTER_MS,
  // The gap never exceeds the interval (a short test interval still ticks).
  minGapMs = Math.min(UPDATE_MIN_GAP_MS, intervalMs),
}: UpdateScheduleOptions): () => void {
  let lastCheckAt: number | null = null;
  let awaySince: number | null = null;
  let inFlight = false;
  let stopped = false;

  const fire = (): void => {
    if (inFlight || stopped) return;
    inFlight = true;
    lastCheckAt = now();
    void Promise.resolve()
      .then(run)
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };

  const leave = (): void => {
    if (awaySince === null) awaySince = now();
  };
  const back = (): void => {
    const since = awaySince;
    awaySince = null;
    if (shouldCheckOnReturn(now(), lastCheckAt, since, { resumeAfterMs, minGapMs })) fire();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === "hidden") leave();
    else back();
  };

  fire();
  const timer = win.setInterval(() => {
    if (canCheckNow(now(), lastCheckAt, minGapMs)) fire();
  }, intervalMs);
  win.addEventListener("blur", leave);
  win.addEventListener("focus", back);
  win.addEventListener("online", back);
  doc.addEventListener("visibilitychange", onVisibility);

  return () => {
    stopped = true;
    win.clearInterval(timer);
    win.removeEventListener("blur", leave);
    win.removeEventListener("focus", back);
    win.removeEventListener("online", back);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
