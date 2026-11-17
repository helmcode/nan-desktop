// @vitest-environment jsdom
// Crash telemetry from the renderer: only the error NAME reaches the core
// (`telemetry_renderer_crash { name }`), never the message, stack or any
// other property; a failing report never throws or rejects.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import { crashName, reportRendererCrash } from "./core";
import { logCrash } from "./ErrorBoundary";

describe("renderer crash telemetry", () => {
  beforeEach(() => {
    resetTauri({ telemetry_renderer_crash: () => undefined });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("reports only the error name of a crash", () => {
    const err = new TypeError("cannot read /Users/alice/secret.txt sk-abcdefghijkl");
    logCrash("error", err);
    expect(invokedWith("telemetry_renderer_crash")).toEqual([{ name: "TypeError" }]);
    const sent = JSON.stringify(invoke.mock.calls);
    expect(sent).not.toMatch(/alice|secret|sk-abc|cannot read/);
  });

  it("collapses any name outside the allowlist to Error", () => {
    for (const bad of ["", "Type Error", "a/b", "1x", "x".repeat(65), 42, null, "Error: msg", "AliceProjectError"]) {
      expect(crashName(bad)).toBe("Error");
    }
    expect(crashName("RangeError")).toBe("RangeError");
    // A non-Error rejection reports its typeof.
    logCrash("unhandledrejection", "just a string with /a/path");
    expect(invokedWith("telemetry_renderer_crash")).toEqual([{ name: "string" }]);
  });

  it("never throws or leaves a rejected promise when the core is unavailable", async () => {
    resetTauri(); // the command is unmocked: invoke rejects
    expect(() => reportRendererCrash("TypeError")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    invoke.mockImplementationOnce(() => {
      throw new Error("no ipc");
    });
    expect(() => reportRendererCrash("TypeError")).not.toThrow();
  });
});
