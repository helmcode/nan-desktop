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
//   renders a calm recovery screen with "Retry" (re-mounts the app) and
//   "Reload app" (location.reload).
// - `installCrashGuard` listens for window `error` and `unhandledrejection`.
//   Every one is logged; when the app root is blank (React gave up), the
//   same recovery screen is shown instead of a dead window. A rejection
//   while the app is alive is only logged: it never hijacks a working UI.
//
// Logging stays local (console, which the core's webview log captures):
// message, stack, component stack and a timestamp, with anything that looks
// like a credential redacted. Zero telemetry.

import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
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
    <main className="center-screen crash-screen">
      <div className="center-card" role="alert" aria-labelledby="crash-title">
        <h1 id="crash-title">{s.title}</h1>
        <p className="lede">{s.body}</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {s.retry}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onReload}>
            {s.reload}
          </button>
        </div>
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

/**
 * Log every window `error` / `unhandledrejection` and call `onBlank` when
 * the app root is empty afterwards (checked after the current task, so
 * React has finished tearing down). Returns the uninstaller.
 */
export function installCrashGuard(
  target: Window,
  rootEl: HTMLElement,
  onBlank: () => void,
): () => void {
  const check = (): void => {
    setTimeout(() => {
      if (isBlank(rootEl)) onBlank();
    }, 0);
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
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

// ------------------------------------------------------------ bootstrap --

/**
 * Mount the app under the root boundary and the crash guard. When React
 * gives up anyway (an error that escaped every boundary) the recovery
 * screen is rendered in its own container: "Retry" mounts a brand-new app
 * root, "Reload app" reloads the page. Returns a disposer (tests).
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

  const mount = (): void => {
    appRoot = createRoot(rootEl, {
      onUncaughtError: (error, info) => {
        logCrash("uncaught", error, info.componentStack);
        setTimeout(() => {
          if (isBlank(rootEl)) showRecovery();
        }, 0);
      },
    });
    appRoot.render(
      <AppErrorBoundary onReload={onReload}>{renderApp()}</AppErrorBoundary>,
    );
  };

  const retry = (): void => {
    hideRecovery();
    appRoot?.unmount();
    mount();
  };

  function showRecovery(): void {
    if (recoveryRoot) return;
    recoveryEl = rootEl.ownerDocument.createElement("div");
    recoveryEl.id = "crash-recovery";
    rootEl.after(recoveryEl);
    recoveryRoot = createRoot(recoveryEl);
    recoveryRoot.render(<RecoveryScreen onRetry={retry} onReload={onReload} />);
  }

  const uninstall = installCrashGuard(target, rootEl, showRecovery);
  mount();
  return () => {
    uninstall();
    hideRecovery();
    appRoot?.unmount();
  };
}
