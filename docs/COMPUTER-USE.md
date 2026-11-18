# Computer use: design note

Status: **phase 1 shipped** (the in-app browser, see
[ARCHITECTURE.md](ARCHITECTURE.md#in-app-browser-computer-use-phase-1) and
[SECURITY.md](../SECURITY.md#in-app-browser)). **Phase 2** (control of the
whole desktop) is a design only; nothing below is implemented.

## Why two phases

Users asked the assistant to "look at my Chrome window" and act in it. The
assistant had no way to see or act outside the app. Phase 1 gives it a
controlled environment first: a browser inside the app that the user sees,
can take over and can stop, with no access to the rest of the computer.
Phase 2 extends the same loop to the whole desktop, which needs OS
permissions and a stricter consent model.

## The shared loop

Both phases are the same observe, act, observe loop:

1. **Observe**: the model gets the current state (phase 1: the page as
   text with numbered elements, or a screenshot; phase 2: a screenshot of
   a display, plus an accessibility tree where the OS offers one).
2. **Act**: the model calls one action (click, type, scroll, key, open).
3. **Gate**: the core decides run / ask / refuse before acting (site or
   app approval, secret fields, sign-ins and payments).
4. **Observe again**: the action returns the new state.

What phase 2 reuses from phase 1 as-is:

- the driver lock (one action at a time) and `AgentGuard` (who is driving,
  cleared on stop);
- the inline approval broker and the audit log (target only, never content);
- the untrusted-content wrapping of everything observed (nonce markers,
  system prompt rules);
- the "never type secrets, ask the user" rule and the sign-in / payment
  gate, keyed on what is focused;
- the vision check (screenshots only for models that see images);
- telemetry by tool name, outcome and duration only.

## Phase 2 sketch

**Availability.** Only when the user has granted **whole-computer** access
(the existing computer-wide grant) and switched on a separate "Let the
assistant control this computer" setting, off by default, asked through a
native dialog the renderer cannot fake (like the computer-wide grant).

**Observe.**
- macOS: `ScreenCaptureKit` (needs the **Screen Recording** permission),
  scaled down; the Accessibility API (`AXUIElement`) for a text tree of the
  frontmost app where available.
- Windows: `Windows.Graphics.Capture` / DXGI duplication; UI Automation for
  the element tree.
- Linux: X11 (`XGetImage`, AT-SPI); Wayland requires the
  `xdg-desktop-portal` ScreenCast portal (the user picks what to share each
  session) and has no global input injection: phase 2 on Wayland may stay
  read-only.

**Act.**
- macOS: `CGEvent` mouse and keyboard events (needs the **Accessibility**
  permission); Windows: `SendInput`; Linux X11: XTest.
- Coordinates come from the last screenshot (scaled back), never free-form.

**Extra rules for phase 2.**
- Per-app approval (instead of per-site): the first action in each app
  asks; some apps always ask (password managers, banking, terminals,
  System Settings) and the app's own windows are never targets.
- A visible "the assistant is controlling your computer" overlay with a
  stop button and a global hotkey that stops immediately; any physical
  mouse or keyboard input from the user pauses the agent.
- Secure input fields (macOS `IsSecureEventInputEnabled`, password fields
  in the accessibility tree) block typing, as in phase 1.
- Screenshots are never stored; they go only to the profile's inference
  API for the current reply.

**Open questions for phase 2.** Permission onboarding UX on macOS (two
system prompts and a restart of the app), Wayland support, how to show
consent per app to non-technical users, and whether to require a
vision-capable model for every phase 2 action.
