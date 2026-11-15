// @vitest-environment jsdom
//
// R19-A: a crash never leaves a black window. The root boundary shows the
// recovery screen (Try again re-mounts, Restart the app reloads), the window crash
// guard brings it back when React gave up, and the log carries no tokens.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  AppErrorBoundary,
  installCrashGuard,
  logCrash,
  redactSecrets,
  startApp,
} from "./ErrorBoundary";
import { LOCALE_STORAGE_KEY } from "./i18n/locale";
import { readFileSync } from "node:fs";

// Read from disk (see brand.test.tsx: ?raw hands back "" for style files).
const css = readFileSync("src/App.css", "utf8");

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  window.localStorage.clear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  consoleError.mockRestore();
  vi.useRealTimers();
});

let shouldThrow = true;
let mounts = 0;
function Flaky() {
  const [id] = useState(() => ++mounts);
  if (shouldThrow) throw new Error("boom with sk-hke_abcdef1234567890 inside");
  return <p>alive {id}</p>;
}

function crashLog(): Record<string, string> | undefined {
  const call = consoleError.mock.calls.find(
    (args) => args[0] === "[renderer] crash",
  );
  return call?.[1] as Record<string, string> | undefined;
}

describe("AppErrorBoundary", () => {
  it("catches a throwing child, shows the recovery screen and logs a redacted report", () => {
    shouldThrow = true;
    render(
      <AppErrorBoundary onReload={() => {}}>
        <Flaky />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    const report = crashLog();
    expect(report?.source).toBe("render");
    expect(report?.message).toContain("boom");
    expect(report?.message).not.toContain("sk-hke_");
    expect(report?.componentStack).toContain("Flaky");
    expect(Number.isNaN(Date.parse(report?.at ?? ""))).toBe(false);
  });

  it("Try again re-mounts the app from scratch", () => {
    shouldThrow = true;
    mounts = 0;
    render(
      <AppErrorBoundary onReload={() => {}}>
        <Flaky />
      </AppErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText(/alive/)).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });

  it("Restart the app reloads, and says what it does in plain words", () => {
    shouldThrow = true;
    const reload = vi.fn();
    render(
      <AppErrorBoundary onReload={reload}>
        <Flaky />
      </AppErrorBoundary>,
    );
    // UX: "Try again" is the primary action; the restart is secondary and
    // carries a hint, so a non-technical user can tell the two apart.
    const tryAgain = screen.getByRole("button", { name: "Try again" });
    const restart = screen.getByRole("button", { name: "Restart the app" });
    expect(tryAgain.className).toContain("btn-primary");
    expect(restart.className).toContain("btn-ghost");
    expect(restart.getAttribute("aria-describedby")).toBe("crash-restart-hint");
    expect(document.getElementById("crash-restart-hint")?.textContent).toMatch(
      /closes the app and opens it again/,
    );
    fireEvent.click(restart);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("speaks the stored language without the i18n context", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "es");
    shouldThrow = true;
    render(
      <AppErrorBoundary onReload={() => {}}>
        <Flaky />
      </AppErrorBoundary>,
    );
    expect(screen.getByText("Algo no ha ido bien")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Probar de nuevo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cerrar y volver a abrir" })).toBeTruthy();
    expect(screen.getByText(/cierra la app y la vuelve a abrir/)).toBeTruthy();
  });
});

describe("installCrashGuard", () => {
  function rejection(reason: unknown): Event {
    const event = new Event("unhandledrejection");
    Object.assign(event, { reason, promise: Promise.resolve() });
    return event;
  }

  it("an unhandled rejection on a blank window brings the recovery up", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    const onBlank = vi.fn();
    const uninstall = installCrashGuard(window, root, onBlank);
    window.dispatchEvent(rejection(new Error("Bearer abc.def.ghi failed")));
    vi.runAllTimers();
    expect(onBlank).toHaveBeenCalledTimes(1);
    const report = crashLog();
    expect(report?.source).toBe("unhandledrejection");
    expect(report?.message).not.toContain("abc.def.ghi");
    uninstall();
  });

  it("a rejection while the app is alive is only logged", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    root.appendChild(document.createElement("main"));
    const onBlank = vi.fn();
    const uninstall = installCrashGuard(window, root, onBlank);
    window.dispatchEvent(rejection("nope"));
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "script error",
        error: new Error("x"),
      }),
    );
    vi.runAllTimers();
    expect(onBlank).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(2);
    uninstall();
  });

  it("uninstall removes both listeners", () => {
    vi.useFakeTimers();
    const onBlank = vi.fn();
    installCrashGuard(window, document.createElement("div"), onBlank)();
    window.dispatchEvent(rejection("late"));
    vi.runAllTimers();
    expect(onBlank).not.toHaveBeenCalled();
  });
});

describe("startApp", () => {
  it("a blank window after an unhandled rejection shows the recovery; Retry mounts a new app", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let renders = 0;
    let blank = true;
    const reload = vi.fn();
    const App = () => (blank ? null : <p>app is back</p>);
    let dispose = (): void => {};
    await act(async () => {
      dispose = startApp(
        root,
        () => {
          renders += 1;
          return <App />;
        },
        { onReload: reload },
      );
    });
    expect(root.childElementCount).toBe(0);

    await act(async () => {
      window.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: new Error("lost"),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      await screen.findByText("Something went wrong"),
    ).toBeTruthy();
    // UX blocker: the recovery layer is a direct <body> child pinned over
    // the window by `#crash-recovery` (position: fixed; inset: 0). A plain
    // sibling of the height:100% #root would sit below the visible window.
    const layer = document.getElementById("crash-recovery");
    expect(layer?.parentElement).toBe(document.body);
    expect(layer?.contains(screen.getByRole("alert"))).toBe(true);
    const rule = /(?:^|\n)#crash-recovery\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/position:\s*fixed;/);
    expect(rule).toMatch(/inset:\s*0;/);
    expect(rule).toMatch(/z-index:\s*\d+;/);

    fireEvent.click(screen.getByRole("button", { name: "Restart the app" }));
    expect(reload).toHaveBeenCalledTimes(1);

    blank = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    expect(await screen.findByText("app is back")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(renders).toBe(2);
    act(() => dispose());
    root.remove();
  });
});

// Every console.error argument flattened to text (Error message + stack too),
// so a token cannot hide inside an Error object React logs as-is.
function everythingLogged(): string {
  return consoleError.mock.calls
    .flat()
    .map((arg: unknown) =>
      arg instanceof Error
        ? `${arg.name} ${arg.message} ${arg.stack ?? ""}`
        : typeof arg === "string"
          ? arg
          : (() => {
              try {
                return JSON.stringify(arg);
              } catch {
                return String(arg);
              }
            })(),
    )
    .join("\n");
}

describe("startApp: caught errors take the redaction path", () => {
  it("a regional boundary catch never logs the raw token (React 19 default onCaughtError bypass)", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    function Leaky(): never {
      throw new Error("chat failed for sk-hke_leakleakleak123456");
    }
    let dispose = (): void => {};
    await act(async () => {
      dispose = startApp(root, () => (
        <ErrorBoundary resetKey="x" fallback={<p>regional fallback</p>}>
          <Leaky />
        </ErrorBoundary>
      ));
    });
    expect(screen.getByText("regional fallback")).toBeTruthy();
    const logged = everythingLogged();
    expect(logged).not.toContain("sk-hke_leakleakleak123456");
    expect(logged).toContain("[redacted]");
    const report = crashLog();
    expect(report?.source).toBe("render");
    expect(report?.message).toBe("chat failed for [redacted]");
    act(() => dispose());
    root.remove();
  });

  it("a root-boundary catch is logged exactly once, redacted", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    shouldThrow = true;
    let dispose = (): void => {};
    await act(async () => {
      dispose = startApp(root, () => <Flaky />, { onReload: () => {} });
    });
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(everythingLogged()).not.toContain("sk-hke_abcdef1234567890");
    const reports = consoleError.mock.calls.filter(
      (args) => args[0] === "[renderer] crash",
    );
    expect(reports).toHaveLength(1);
    act(() => dispose());
    root.remove();
  });
});

describe("startApp: no stale recovery over a healthy app", () => {
  function rejectionEvent(): Event {
    return Object.assign(new Event("unhandledrejection"), {
      reason: new Error("late"),
    });
  }
  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  // After "Try again" the new app paints a moment later: until then #root is
  // empty, exactly the window a stale crash check can land in.
  let mode: "blank" | "slow" = "blank";
  function SlowApp() {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      if (mode !== "slow") return;
      const t = setTimeout(() => setReady(true), 30);
      return () => clearTimeout(t);
    }, []);
    return ready ? <p>app is back</p> : null;
  }

  async function blankAppWithRecovery() {
    mode = "blank";
    const root = document.createElement("div");
    document.body.appendChild(root);
    let dispose = (): void => {};
    await act(async () => {
      dispose = startApp(root, () => <SlowApp />, { onReload: () => {} });
    });
    await act(async () => {
      window.dispatchEvent(rejectionEvent());
      await tick();
    });
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    return () => {
      act(() => dispose());
      root.remove();
    };
  }

  it("an error logged during the retry window leaves no recovery once the app is back", async () => {
    const dispose = await blankAppWithRecovery();
    mode = "slow";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    });
    // #root is still empty: this error's check pops the recovery up again...
    await act(async () => {
      window.dispatchEvent(rejectionEvent());
      await tick();
    });
    // ...but once the re-mounted app paints, it must not stay over it.
    await act(async () => {
      await tick(60);
    });
    expect(screen.getByText("app is back")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(document.getElementById("crash-recovery")).toBeNull();
    dispose();
  });

  it("a check scheduled right before Try again does not fire after the retry", async () => {
    const dispose = await blankAppWithRecovery();
    mode = "slow";
    await act(async () => {
      // Logged while the app is still blank: its check is pending...
      window.dispatchEvent(rejectionEvent());
      // ...and Try again lands before it runs.
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await tick();
    });
    // #root is still empty here, so a surviving check would have shown it.
    expect(document.getElementById("crash-recovery")).toBeNull();
    await act(async () => {
      await tick(60);
    });
    expect(screen.getByText("app is back")).toBeTruthy();
    expect(document.getElementById("crash-recovery")).toBeNull();
    dispose();
  });
});

describe("redaction", () => {
  it("strips keys, bearer headers and JWTs", () => {
    const text = redactSecrets(
      "key sk-abcdefghijkl hke_0123456789ab Authorization: Bearer tok3n eyJhbGc.eyJzdWIi.c2ln nan_abcdefghijk",
    );
    expect(text).not.toMatch(/sk-abcdef|hke_0123|tok3n|eyJhbGc|nan_abcdef/);
  });

  it("logging a non-Error never throws", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logCrash("error", circular)).not.toThrow();
    expect(() => logCrash("error", undefined)).not.toThrow();
  });
});

// R19-A root cause: "Save as skill" switches the main surface from the chat
// to Settings by itself. A throw while the chat subtree tears down skips the
// regional boundaries deleted with it; only a boundary that stays mounted
// across the switch (App.tsx main surface, then AppErrorBoundary) holds it.
describe("teardown errors during a view switch", () => {
  function TearsDownBadly() {
    useEffect(
      () => () => {
        throw new Error("teardown");
      },
      [],
    );
    return <p>chat area</p>;
  }
  let switchTo: (view: string) => void = () => {};
  function Surface({ stable }: { stable: boolean }) {
    const [view, setView] = useState("chat");
    switchTo = setView;
    const body =
      view === "chat" ? (
        <ErrorBoundary resetKey="chat" fallback={<p>regional fallback</p>}>
          <TearsDownBadly />
        </ErrorBoundary>
      ) : (
        <p>settings</p>
      );
    return stable ? (
      <ErrorBoundary resetKey={view} fallback={<p>surface fallback</p>}>
        {body}
      </ErrorBoundary>
    ) : (
      body
    );
  }

  it("an always-mounted surface boundary contains it and the sidebar stays", () => {
    render(
      <>
        <nav>sidebar</nav>
        <Surface stable />
      </>,
    );
    act(() => switchTo("settings"));
    expect(screen.getByText("sidebar")).toBeTruthy();
    expect(screen.getByText("surface fallback")).toBeTruthy();
    expect(screen.queryByText("regional fallback")).toBeNull();
  });

  it("without it the regional boundary is skipped; the root boundary shows the recovery, not a black window", () => {
    render(
      <AppErrorBoundary onReload={() => {}}>
        <nav>sidebar</nav>
        <Surface stable={false} />
      </AppErrorBoundary>,
    );
    act(() => switchTo("settings"));
    expect(screen.queryByText("regional fallback")).toBeNull();
    expect(screen.getByText("Something went wrong")).toBeTruthy();
  });
});
