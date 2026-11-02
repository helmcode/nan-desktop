// @vitest-environment jsdom
// Contract test: command names and argument keys must match the Rust core
// exactly (src-tauri/src/lib.rs generate_handler!, camelCase args).
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokedWith, resetTauri } from "./test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import {
  addGrant,
  fetchWebPreview,
  getGrantMode,
  readFileForPreview,
  respondToApproval,
  setGrantMode,
} from "./core";
import { effectiveMode, useWorkspace } from "./workspace";
import type { GrantView } from "./types";

const grant = (overrides: Partial<GrantView> = {}): GrantView => ({
  id: "g1",
  canonical_path: "/Users/ana/Proyecto",
  granted_at: "",
  profile_id: "nan",
  scope: "folder",
  mode: "ask",
  ...overrides,
});

describe("core IPC contract", () => {
  beforeEach(() => resetTauri());

  it("answers approvals with approvalId", async () => {
    resetTauri({ tools_approval_respond: () => undefined });
    await respondToApproval("a-1", false);
    expect(invokedWith("tools_approval_respond")).toEqual([{ approvalId: "a-1", granted: false }]);
  });

  it("uses tools_grant_set_mode / tools_grant_mode_get / tools_grant_add with mode", async () => {
    resetTauri({
      tools_grant_set_mode: () => grant({ mode: "allow" }),
      tools_grant_mode_get: () => "allow",
      tools_grant_add: () => grant(),
    });
    expect((await setGrantMode("g1", "allow")).mode).toBe("allow");
    expect(invokedWith("tools_grant_set_mode")).toEqual([{ grantId: "g1", mode: "allow" }]);
    expect(await getGrantMode("g1")).toBe("allow");
    expect(invokedWith("tools_grant_mode_get")).toEqual([{ grantId: "g1" }]);
    await addGrant("nan", "allow");
    expect(invokedWith("tools_grant_add")).toEqual([{ profileId: "nan", mode: "allow" }]);
  });

  it("fetches web previews and decodes file previews", async () => {
    const page = { url: "https://example.com/", title: null, content_type: "text/markdown", text: "hi" };
    resetTauri({
      web_preview_fetch: () => page,
      preview_read_file: () => ({ base64: btoa("\u0000ÿAB"), size: 4 }),
    });
    expect(await fetchWebPreview("nan", "https://example.com/")).toEqual(page);
    expect(invokedWith("web_preview_fetch")).toEqual([{ profileId: "nan", url: "https://example.com/" }]);
    expect(Array.from(await readFileForPreview("nan", "/Users/ana/Proyecto/a.bin"))).toEqual([0, 255, 65, 66]);
    expect(invokedWith("preview_read_file")).toEqual([{ profileId: "nan", path: "/Users/ana/Proyecto/a.bin" }]);
  });
});

describe("workspace modes", () => {
  it("computer-wide grants are always ask, whatever is stored", () => {
    expect(effectiveMode(grant({ scope: "computer_wide", mode: "allow" }))).toBe("ask");
    expect(effectiveMode(grant({ mode: "allow" }))).toBe("allow");
  });

  it("trusts the grant the core returns when the native confirmation is declined", async () => {
    let stored = grant();
    resetTauri({
      tools_grant_list: () => [stored],
      // Declined natively: the core returns the grant unchanged.
      tools_grant_set_mode: () => stored,
    });
    const { result } = renderHook(() => useWorkspace("nan"));
    await waitFor(() => expect(result.current.modes.g1).toBe("ask"));
    await act(() => result.current.setMode("g1", "allow"));
    expect(result.current.modes.g1).toBe("ask");

    // Confirmed: the stored grant is now allow.
    stored = grant({ mode: "allow" });
    await act(() => result.current.setMode("g1", "allow"));
    expect(result.current.modes.g1).toBe("allow");
  });

  it("adds a folder in one call with the requested mode", async () => {
    resetTauri({ tools_grant_list: () => [], tools_grant_add: () => grant({ id: "g2", mode: "allow" }) });
    const { result } = renderHook(() => useWorkspace("nan"));
    await act(async () => {
      expect(await result.current.addFolder("allow")).toBe(true);
    });
    expect(invokedWith("tools_grant_add")).toEqual([{ profileId: "nan", mode: "allow" }]);
    expect(invokedWith("tools_grant_set_mode")).toEqual([]);
  });
});
