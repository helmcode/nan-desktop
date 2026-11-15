// @vitest-environment jsdom
//
// R19-A: a crash never leaves a black window. The root boundary shows the
// recovery screen (Retry re-mounts, Reload app reloads), the window crash
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
    expect(screen.getByText("Something cut out unexpectedly")).toBeTruthy();
    const report = crashLog();
    expect(report?.source).toBe("render");
    expect(report?.message).toContain("boom");
    expect(report?.message).not.toContain("sk-hke_");
    expect(report?.componentStack).toContain("Flaky");
    expect(Number.isNaN(Date.parse(report?.at ?? ""))).toBe(false);
  });

  it("Retry re-mounts the app from scratch", () => {
    shouldThrow = true;
    mounts = 0;
    render(
      <AppErrorBoundary onReload={() => {}}>
        <Flaky />
      </AppErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText(/alive/)).toBeTruthy();
    expect(screen.queryByText("Something cut out unexpectedly")).toBeNull();
  });

  it("Reload app reloads", () => {
    shouldThrow = true;
    const reload = vi.fn();
    render(
      <AppErrorBoundary onReload={reload}>
        <Flaky />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reload app" }));
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
    expect(screen.getByText("Algo se ha cortado inesperadamente")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recargar app" })).toBeTruthy();
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
      await screen.findByText("Something cut out unexpectedly"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reload app" }));
    expect(reload).toHaveBeenCalledTimes(1);

    blank = false;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(await screen.findByText("app is back")).toBeTruthy();
    expect(screen.queryByText("Something cut out unexpectedly")).toBeNull();
    expect(renders).toBe(2);
    act(() => dispose());
    root.remove();
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
    expect(screen.getByText("Something cut out unexpectedly")).toBeTruthy();
  });
});
