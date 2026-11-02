// Shared Tauri IPC mock for component tests: commands resolve from a
// per-test handler table; events are captured so tests can emit them.
//
// Usage in a test file (factories import this module lazily):
//   vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());
//   vi.mock("@tauri-apps/api/event", async () => (await import("../test/tauriMock")).eventModule());

import { vi } from "vitest";

type Handler = (args: Record<string, unknown> | undefined) => unknown;
type Listener = (event: { payload: unknown }) => void;

const handlers = new Map<string, Handler>();
const listeners = new Map<string, Listener[]>();

export const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
  const handler = handlers.get(cmd);
  if (!handler) throw new Error(`unmocked command ${cmd}`);
  return handler(args);
});

export const listen = vi.fn(async (name: string, cb: Listener) => {
  listeners.set(name, [...(listeners.get(name) ?? []), cb]);
  return () => {
    listeners.set(
      name,
      (listeners.get(name) ?? []).filter((fn) => fn !== cb),
    );
  };
});

export function coreModule() {
  return { invoke, convertFileSrc: (path: string) => `asset://localhost/${path}` };
}

export function eventModule() {
  return { listen };
}

export function emit(name: string, payload: unknown): void {
  for (const cb of listeners.get(name) ?? []) cb({ payload });
}

export function resetTauri(table: Record<string, Handler> = {}): void {
  handlers.clear();
  listeners.clear();
  invoke.mockClear();
  listen.mockClear();
  for (const [cmd, handler] of Object.entries(table)) handlers.set(cmd, handler);
}

export function invokedWith(cmd: string): Array<Record<string, unknown> | undefined> {
  return invoke.mock.calls.filter((call) => call[0] === cmd).map((call) => call[1]);
}
