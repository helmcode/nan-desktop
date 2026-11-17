// R19-A: the last line of defence against a black window.
//
// React unmounts the WHOLE tree when an error escapes every boundary: a
// throw during render, or a throw in an effect cleanup of a subtree that is
// being deleted (the regional boundaries in App.tsx are deleted with it, so
// they cannot catch it). The window then shows only the body background:
// black, with the macOS traffic lights. This module makes sure that never
// happens silently:
//
// - `AppErrorBoundary` wraps the whole app (main.tsx). A crash anywhere
//   renders a calm recovery screen with "Try again" (primary: re-mounts the
//   app) and "Restart the app" (secondary, with a hint saying what it does:
//   location.reload, the closest thing to closing and reopening).
// - `installCrashGuard` listens for window `error` and `unhandledrejection`.
//   Every one is logged; when the app root is blank (React gave up), the
//   same recovery screen is shown instead of a dead window. A rejection
//   while the app is alive is only logged: it never hijacks a working UI.
//
// Logging stays local (console, which the core's webview log captures):
// message, stack, component stack and a timestamp, with anything that looks
// like a credential redacted. The only thing that leaves the renderer is the
// error NAME (`TypeError`, ...), handed to the core's crash telemetry
// (`reportRendererCrash`); never the message, stack or component stack.

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { reportRendererCrash } from "./core";
import { STRINGS } from "./i18n";
import { DEFAULT_LOCALE, storedLocale } from "./i18n/locale";
import type { Strings } from "./i18n/en";

// ------------------------------------------------------------- logging --

const SECRET_PATTERNS: RegExp[] = [
  // API keys: sk-..., sk-hke_..., hke_..., nan_...
  /\b(?:sk|hke|nan)[-_][A-Za-z0-9_-]{8,}/g,
  // Authorization headers.
  /Bearer\s+[^\s"'`]+/gi,
  // JWTs (three base64url segments starting with a JSON header).
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/** Remove anything that looks like a token before a string is logged. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, pattern) => out.replace(pattern, "[redacted]"),
    text,
  );
}

export interface CrashReport {
  at: string;
  source: "render" | "uncaught" | "error" | "unhandledrejection";
  name: string;
  message: string;
  stack: string;
  componentStack: string;
}

function describe(reason: unknown): {
  name: string;
  message: string;
  stack: string;
} {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      stack: reason.stack ?? "",
    };
  }
  let message: string;
  try {
    message =
      typeof reason === "string"
        ? reason
        : (JSON.stringify(reason) ?? String(reason));
  } catch {
    message = String(reason);
  }
  return { name: typeof reason, message, stack: "" };
}

/** Build the (redacted) report and write it to the console. Never throws. */
export function logCrash(
  source: CrashReport["source"],
  reason: unknown,
  componentStack?: string | null,
): CrashReport {
  const { name, message, stack } = describe(reason);
  const report: CrashReport = {
    at: new Date().toISOString(),
    source,
    name: redactSecrets(name),
    message: redactSecrets(message),
    stack: redactSecrets(stack),
    componentStack: redactSecrets(componentStack ?? ""),
  };
  try {
    console.error("[renderer] crash", report);
  } catch {
    // A console that throws must not turn a crash into a second crash.
  }
  reportRendererCrash(name);
  return report;
}

// ------------------------------------------------------ recovery screen --

/** The strings for the user's language, read without the (maybe dead) i18n context. */
export function crashStrings(): Strings["crash"] {
  return STRINGS[storedLocale() ?? DEFAULT_LOCALE].crash;
}

export function RecoveryScreen({
  onRetry,
  onReload,
}: {
  onRetry: () => void;
  onReload: () => void;
}) {
  const s = crashStrings();
  return (
    <main className="center-screen">
      <div className="center-card" role="alert" aria-labelledby="crash-title">
        <h1 id="crash-title">{s.title}</h1>
        <p className="lede">{s.body}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {s.retry}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onReload}
            aria-describedby="crash-restart-hint"
          >
            {s.restart}
          </button>
        </div>
        <p className="hint" id="crash-restart-hint">
          {s.restartHint}
        </p>
      </div>
    </main>
  );
}

export function reloadApp(): void {
  window.location.reload();
}

// ------------------------------------------------------- root boundary --

interface Props {
  children: ReactNode;
  /** Injected in tests; defaults to location.reload. */
  onReload?: () => void;
}

interface State {
  failed: boolean;
  /** Bumped by "Retry": the children re-mount from scratch. */
  generation: number;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, generation: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    logCrash("render", error, info.componentStack);
  }

  private retry = (): void => {
    this.setState((prev) => ({
      failed: false,
      generation: prev.generation + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <RecoveryScreen
          onRetry={this.retry}
          onReload={this.props.onReload ?? reloadApp}
        />
      );
    }
    return (
      <Fragment key={this.state.generation}>{this.props.children}</Fragment>
    );
  }
}

// ---------------------------------------------------------- crash guard --

/** True when React has nothing on screen: the black-window state. */
export function isBlank(rootEl: HTMLElement): boolean {
  return rootEl.childElementCount === 0;
}

/** The uninstaller, plus a way to drop checks that have not run yet. */
export interface CrashGuard {
  (): void;
  /** Cancel every blank check still waiting to run. */
  cancelPending: () => void;
}

/**
 * Log every window `error` / `unhandledrejection` and call `onBlank` when
 * the app root is empty afterwards (checked after the current task, so
 * React has finished tearing down). Returns the uninstaller, which also
 * cancels pending checks.
 */
export function installCrashGuard(
  target: Window,
  rootEl: HTMLElement,
  onBlank: () => void,
): CrashGuard {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const check = (): void => {
    const id = setTimeout(() => {
      pending.delete(id);
      if (isBlank(rootEl)) onBlank();
    }, 0);
    pending.add(id);
  };
  const cancelPending = (): void => {
    pending.forEach((id) => clearTimeout(id));
    pending.clear();
  };
  const onError = (event: ErrorEvent): void => {
    logCrash("error", event.error ?? event.message);
    check();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    logCrash("unhandledrejection", event.reason);
    check();
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  const uninstall = (): void => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    cancelPending();
  };
  return Object.assign(uninstall, { cancelPending });
}

// ------------------------------------------------------------ bootstrap --

/**
 * Mount the app under the root boundary and the crash guard. When React
 * gives up anyway (an error that escaped every boundary) the recovery
 * screen is rendered in its own container: "Try again" mounts a brand-new
 * app root, "Restart the app" reloads the page. Returns a disposer (tests).
 *
 * INVARIANT: the detached recovery only ever covers a blank #root. Blank
 * checks still pending when "Try again" starts are canceled, and the moment
 * #root has content again (the re-mounted app painted) pending checks are
 * canceled and the recovery is hidden. Without this, an error logged while
 * #root is transiently empty during a retry would pop the recovery over the
 * healthy app, with nothing to take it down.
 *
 * Every error React reports (caught by any boundary, or uncaught) goes
 * through `logCrash`: React 19's default `onCaughtError` console.errors the
 * raw error, which would put unredacted tokens in the webview log.
 */
export function startApp(
  rootEl: HTMLElement,
  renderApp: () => ReactNode,
  options: { onReload?: () => void; target?: Window } = {},
): () => void {
  const target = options.target ?? window;
  const onReload = options.onReload ?? reloadApp;
  let appRoot: Root | null = null;
  let recoveryEl: HTMLElement | null = null;
  let recoveryRoot: Root | null = null;

  const hideRecovery = (): void => {
    recoveryRoot?.unmount();
    recoveryEl?.remove();
    recoveryRoot = null;
    recoveryEl = null;
  };

  let guard: CrashGuard | null = null;
  const uncaughtChecks = new Set<ReturnType<typeof setTimeout>>();
  const cancelChecks = (): void => {
    uncaughtChecks.forEach((id) => clearTimeout(id));
    uncaughtChecks.clear();
    guard?.cancelPending();
  };

  const mount = (): void => {
    appRoot = createRoot(rootEl, {
      onCaughtError: (error, info) => {
        // AppErrorBoundary.componentDidCatch already logs its own catches.
        if (info.errorBoundary instanceof AppErrorBoundary) return;
        logCrash("render", error, info.componentStack);
      },
      onUncaughtError: (error, info) => {
        logCrash("uncaught", error, info.componentStack);
        const id = setTimeout(() => {
          uncaughtChecks.delete(id);
          if (isBlank(rootEl)) showRecovery();
        }, 0);
        uncaughtChecks.add(id);
      },
    });
    appRoot.render(
      <AppErrorBoundary onReload={onReload}>{renderApp()}</AppErrorBoundary>,
    );
  };

  const retry = (): void => {
    cancelChecks();
    hideRecovery();
    appRoot?.unmount();
    mount();
  };

  function showRecovery(): void {
    if (recoveryRoot) return;
    // INVARIANT: a direct child of <body> styled by `#crash-recovery` in
    // App.css (position: fixed; inset: 0; z-index above everything).
    // #root is height:100% and body is overflow:hidden, so a plain sibling
    // after #root would render BELOW the visible window: the user would
    // still see black. jsdom cannot do layout, so the test pins the
    // placement and the CSS rule; release checklist: force a throw once in
    // the real app and check the screen is visible.
    const doc = rootEl.ownerDocument;
    recoveryEl = doc.createElement("div");
    recoveryEl.id = "crash-recovery";
    doc.body.appendChild(recoveryEl);
    recoveryRoot = createRoot(recoveryEl);
    recoveryRoot.render(<RecoveryScreen onRetry={retry} onReload={onReload} />);
  }

  // #root has content again: the app is alive, so no recovery may cover it.
  const observer = new MutationObserver(() => {
    if (isBlank(rootEl)) return;
    cancelChecks();
    hideRecovery();
  });
  observer.observe(rootEl, { childList: true });

  guard = installCrashGuard(target, rootEl, showRecovery);
  mount();
  return () => {
    observer.disconnect();
    guard?.();
    cancelChecks();
    hideRecovery();
    appRoot?.unmount();
  };
}
