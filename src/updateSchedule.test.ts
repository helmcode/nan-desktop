// R20-E: when the app asks for updates. The owner never got the 0.2.8
// notice: a 6-hour interval (paused while the Mac sleeps) plus a laptop
// that is mostly closed means the check rarely ran. Now: on startup, every
// 2 hours, and when the window comes back after more than 2 hours away
// (hidden, in the background, or asleep), never more than once per 30
// minutes and never two at a time.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_MIN_GAP_MS,
  UPDATE_RESUME_AFTER_MS,
  canCheckNow,
  shouldCheckOnReturn,
  startUpdateSchedule,
} from "./updateSchedule";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("the constants", () => {
  it("checks every 2 hours, on return after 2 hours away, at most every 30 minutes", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(2 * HOUR);
    expect(UPDATE_RESUME_AFTER_MS).toBe(2 * HOUR);
    expect(UPDATE_MIN_GAP_MS).toBe(30 * MIN);
  });
});

describe("canCheckNow", () => {
  it("allows the first check and anything 30 minutes after the last", () => {
    expect(canCheckNow(1000, null)).toBe(true);
    expect(canCheckNow(30 * MIN, 0)).toBe(true);
    expect(canCheckNow(30 * MIN - 1, 0)).toBe(false);
  });
});

describe("shouldCheckOnReturn", () => {
  const T = 10 * HOUR;
  it("away for more than 2 hours: check", () => {
    expect(shouldCheckOnReturn(T, T - 3 * HOUR, T - 2 * HOUR - 1)).toBe(true);
  });
  it("away for less than 2 hours with a fresh check: no", () => {
    expect(shouldCheckOnReturn(T, T - 40 * MIN, T - 1 * HOUR)).toBe(false);
  });
  it("away for long but checked in the last 30 minutes (the timer ran): no", () => {
    expect(shouldCheckOnReturn(T, T - 10 * MIN, T - 5 * HOUR)).toBe(false);
  });
  it("never marked away but the last check is 2 hours old (the Mac slept): check", () => {
    expect(shouldCheckOnReturn(T, T - 2 * HOUR, null)).toBe(true);
    expect(shouldCheckOnReturn(T, T - 2 * HOUR + 1, null)).toBe(false);
  });
  it("no check ever ran: check", () => {
    expect(shouldCheckOnReturn(T, null, null)).toBe(true);
  });
});

// A window and a document the schedule can listen to.
function fakeEnv() {
  const win = new EventTarget() as EventTarget & Pick<Window, "setInterval" | "clearInterval">;
  win.setInterval = ((fn: () => void, ms: number) => setInterval(fn, ms)) as Window["setInterval"];
  win.clearInterval = ((id: number) => clearInterval(id)) as Window["clearInterval"];
  const doc = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
  doc.visibilityState = "visible";
  return { win, doc };
}

describe("startUpdateSchedule", () => {
  let clock = 0;
  const now = () => clock;
  const advance = async (ms: number) => {
    clock += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000;
  });
  afterEach(() => vi.useRealTimers());

  it("checks on startup and then every 2 hours", async () => {
    const run = vi.fn(async () => {});
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(2 * HOUR - 1);
    expect(run).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(run).toHaveBeenCalledTimes(2);
    await advance(2 * HOUR);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
    await advance(10 * HOUR);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("hidden for more than 2 hours, then focused: one extra check right away", async () => {
    const run = vi.fn(async () => {});
    const { win, doc } = fakeEnv();
    // A long interval so only the return can explain the check.
    const stop = startUpdateSchedule({ run, win, doc, now, intervalMs: 100 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    await advance(2 * HOUR + MIN);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    // Visible and focus arrive together: still a single check.
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("in the background (blurred) for 3 hours, then focused: check", async () => {
    const run = vi.fn(async () => {});
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now, intervalMs: 100 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    win.dispatchEvent(new Event("blur"));
    await advance(3 * HOUR);
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a short absence does not check", async () => {
    const run = vi.fn(async () => {});
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now, intervalMs: 100 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    win.dispatchEvent(new Event("blur"));
    await advance(90 * MIN);
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("debounced: never more than one check per 30 minutes, however often it returns", async () => {
    const run = vi.fn(async () => {});
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now, intervalMs: 100 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    win.dispatchEvent(new Event("blur"));
    await advance(3 * HOUR);
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    // Away "for 3 hours" again by the clock, but the last check is fresh.
    win.dispatchEvent(new Event("blur"));
    await advance(10 * MIN);
    clock += 3 * HOUR; // a jump without timers (the machine slept)
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(3);
    win.dispatchEvent(new Event("blur"));
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it("after a sleep with no window events, coming back online checks", async () => {
    const run = vi.fn(async () => {});
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now, intervalMs: 100 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    clock += 5 * HOUR; // asleep: no timers ran
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("online right after a failed check runs a new check (no 30-minute wait)", async () => {
    let fail = true;
    const run = vi.fn(async () => {
      if (fail) throw new Error("offline");
    });
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now, intervalMs: 100 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    fail = false;
    await advance(MIN);
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    // That one worked: the next online within the gap is debounced again.
    win.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a failed check still debounces focus (no retry storm on every return)", async () => {
    const run = vi.fn(async () => {
      throw new Error("no feed");
    });
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now, intervalMs: 100 * HOUR });
    await vi.advanceTimersByTimeAsync(0);
    win.dispatchEvent(new Event("blur"));
    await advance(5 * MIN);
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("the interval respects the 30-minute gap after a return check", async () => {
    const run = vi.fn(async () => {});
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now });
    await vi.advanceTimersByTimeAsync(0);
    win.dispatchEvent(new Event("blur"));
    await advance(110 * MIN); // the interval clock is at 1h50
    clock += 20 * MIN; // asleep: the wall clock moves on, the timers do not
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    // The interval tick (2 h on the timer clock) lands 10 minutes after the
    // return check: skipped.
    await advance(10 * MIN);
    expect(run).toHaveBeenCalledTimes(2);
    // The next one, 2 h later, runs.
    await advance(2 * HOUR);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
  });

  it("never two at a time: a slow check absorbs a return in the meantime", async () => {
    let finish: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now, intervalMs: 100 * HOUR, minGapMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    win.dispatchEvent(new Event("blur"));
    clock += 3 * HOUR;
    win.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });

  it("a failing check never throws out of the schedule", async () => {
    const run = vi.fn(async () => {
      throw new Error("offline");
    });
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now });
    await vi.advanceTimersByTimeAsync(0);
    await advance(2 * HOUR);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop removes every listener", async () => {
    const run = vi.fn(async () => {});
    const { win, doc } = fakeEnv();
    const stop = startUpdateSchedule({ run, win, doc, now });
    await vi.advanceTimersByTimeAsync(0);
    stop();
    win.dispatchEvent(new Event("blur"));
    clock += 5 * HOUR;
    win.dispatchEvent(new Event("focus"));
    win.dispatchEvent(new Event("online"));
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
