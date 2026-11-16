// @vitest-environment jsdom
// Shared artifacts (F4): the Shared links view. My links (and the org's for
// an admin), the Active / Expired-revoked filter, Copy link, Open, and
// Revoke behind a confirmation that says access ends immediately.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invokedWith, resetTauri } from "../test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());

import { I18nProvider } from "../i18n";
import type { Locale } from "../i18n/locale";
import { relativeTime, SharedLinksView } from "./SharedLinksView";

const DAY = 86400000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const A = "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e";
const B = "1b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e";
const C = "2b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e";

const ROWS = [
  {
    id: A,
    title: "Informe Q3",
    filename: "informe-q3.pdf",
    scope: "public",
    recipient_count: 0,
    expires_at: iso(5),
    created_at: iso(-2),
    view_count: 3,
    url: "https://share.helmcode.com/a/aaa",
  },
  {
    id: B,
    title: "Notes",
    filename: "notes.md",
    scope: "emails",
    recipient_count: 2,
    expires_at: iso(-1),
    created_at: iso(-40),
    view_count: 1,
    url: "https://share.helmcode.com/a/bbb",
  },
  { id: C, title: "Old", filename: "old.csv", scope: "org", revoked_at: iso(-3), created_at: iso(-9), view_count: 0 },
];

type Table = Parameters<typeof resetTauri>[0];

function table(extra: Table = {}): Table {
  return {
    artifacts_request: (args) => {
      if (args?.method === "DELETE") return { status: 204, body: null };
      if (args?.path === "/api/admin/artifacts") {
        return { status: 200, body: { artifacts: [{ ...ROWS[0], id: B, title: "Team deck", owner_email: "bob@acme.com" }] } };
      }
      return { status: 200, body: { artifacts: ROWS } };
    },
    open_external: () => null,
    ...extra,
  };
}

function renderView({ admin = false, locale = "en" as Locale, core = table(), profileId = "helmcode" } = {}) {
  resetTauri(core);
  const props = { onBack: vi.fn(), onNotice: vi.fn(), onSignIn: vi.fn() };
  render(
    <I18nProvider initial={locale}>
      <SharedLinksView profileId={profileId} admin={admin} {...props} />
    </I18nProvider>,
  );
  return props;
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("SharedLinksView", () => {
  it("lists active links with scope, expiry, views and created", async () => {
    renderView();
    const rows = await screen.findAllByTestId("link-row");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.textContent).toContain("Informe Q3");
    expect(row.textContent).toContain("Public");
    expect(row.textContent).toContain("Expires in 5 days");
    expect(row.textContent).toContain("3 views");
    expect(row.textContent).toContain("Created 2 days ago");
    expect(invokedWith("artifacts_request")[0]).toEqual({ profileId: "helmcode", method: "GET", path: "/api/artifacts" });
  });

  it("a paged list (enterprise total / X-Total-Count) says how many it shows", async () => {
    renderView({
      core: table({ artifacts_request: () => ({ status: 200, body: { artifacts: ROWS, total: 57 } }) }),
    });
    await screen.findAllByTestId("link-row");
    expect(screen.getByText("Showing the 3 most recent of 57 links.")).toBeTruthy();
  });

  it("a header-only total works too; a complete list shows no hint", async () => {
    renderView({ core: table({ artifacts_request: () => ({ status: 200, body: { artifacts: ROWS }, total: 9 }) }) });
    expect(await screen.findByText("Showing the 3 most recent of 9 links.")).toBeTruthy();
    cleanup();
    renderView();
    await screen.findAllByTestId("link-row");
    expect(screen.queryByText(/most recent of/)).toBeNull();
  });

  it("community rows with a null url still list; the inactive one has no Copy", async () => {
    renderView({
      profileId: "nan",
      core: table({
        artifacts_request: () => ({
          status: 200,
          body: { artifacts: [{ ...ROWS[0], url: "https://share.nan.builders/a/x", status: "active" }, { ...ROWS[2], url: null, status: "revoked" }] },
        }),
      }),
    });
    const rows = await screen.findAllByTestId("link-row");
    expect(rows).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Expired or revoked" }));
    const inactive = screen.getAllByTestId("link-row");
    expect(inactive[0].textContent).toContain("Revoked");
    expect(within(inactive[0]).queryByRole("button")).toBeNull();
  });

  it("the filter shows expired and revoked links, without actions", async () => {
    renderView();
    await screen.findAllByTestId("link-row");
    fireEvent.click(screen.getByRole("button", { name: "Expired or revoked" }));
    const rows = screen.getAllByTestId("link-row");
    expect(rows.map((row) => row.querySelector(".links-row-title")?.textContent)).toEqual(["Notes", "Old"]);
    expect(rows[0].textContent).toContain("2 people");
    expect(rows[0].textContent).toContain("Expired");
    expect(rows[1].textContent).toContain("Revoked");
    expect(within(rows[0]).queryByRole("button")).toBeNull();
  });

  it("copies a link and confirms", async () => {
    const props = renderView();
    await screen.findAllByTestId("link-row");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the link of Informe Q3" }));
    });
    expect(writeText).toHaveBeenCalledWith("https://share.helmcode.com/a/aaa");
    expect(props.onNotice).toHaveBeenCalledWith("success", "Link copied");
  });

  it("opens a link in the browser", async () => {
    renderView();
    await screen.findAllByTestId("link-row");
    fireEvent.click(screen.getByRole("button", { name: "Open Informe Q3 in the browser" }));
    expect(invokedWith("open_external")[0]).toEqual({ url: "https://share.helmcode.com/a/aaa" });
  });

  it("revoke asks first, then revokes and refreshes", async () => {
    const props = renderView();
    await screen.findAllByTestId("link-row");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Informe Q3" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("People with this link will lose access immediately.");
    expect(document.activeElement?.textContent).toBe("Cancel");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Revoke link" }));
    });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(invokedWith("artifacts_request")).toContainEqual({
      profileId: "helmcode",
      method: "DELETE",
      path: `/api/artifacts/${A}`,
    });
    expect(props.onNotice).toHaveBeenCalledWith("success", "Informe Q3 is no longer shared.");
    // Refreshed after the revoke.
    expect(invokedWith("artifacts_request").filter((args) => args?.method === "GET")).toHaveLength(2);
  });

  it("cancelling the confirmation revokes nothing", async () => {
    renderView();
    await screen.findAllByTestId("link-row");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Informe Q3" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(invokedWith("artifacts_request").some((args) => args?.method === "DELETE")).toBe(false);
  });

  it("a failed revoke keeps the dialog with the reason", async () => {
    renderView({
      core: table({
        artifacts_request: (args) =>
          args?.method === "DELETE" ? { status: 429, body: null } : { status: 200, body: { artifacts: ROWS } },
      }),
    });
    await screen.findAllByTestId("link-row");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Informe Q3" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
    });
    expect(within(screen.getByRole("alertdialog")).getByTestId("artifact-problem").textContent).toContain(
      "Too many attempts",
    );
  });

  it("admins get the Organization tab with owners and admin revoke", async () => {
    renderView({ admin: true });
    await screen.findAllByTestId("link-row");
    fireEvent.click(screen.getByRole("tab", { name: "Organization" }));
    const row = (await screen.findAllByTestId("link-row")).find((r) => r.textContent?.includes("Team deck"));
    expect(row?.textContent).toContain("By bob@acme.com");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Team deck" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Revoke link" }));
    });
    expect(invokedWith("artifacts_request")).toContainEqual({
      profileId: "helmcode",
      method: "DELETE",
      path: `/api/admin/artifacts/${B}`,
    });
  });

  it("members see no Organization tab", async () => {
    renderView();
    await screen.findAllByTestId("link-row");
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("an empty list explains how to create one", async () => {
    renderView({ core: table({ artifacts_request: () => ({ status: 200, body: { artifacts: [] } }) }) });
    expect(await screen.findByText(/No shared links yet/)).toBeTruthy();
  });

  it("an expired session offers sign in; offline offers retry", async () => {
    const props = renderView({ core: table({ artifacts_request: () => ({ status: 401, body: null }) }) });
    const line = await screen.findByTestId("artifact-problem");
    fireEvent.click(within(line).getByRole("button", { name: "Sign in again" }));
    expect(props.onSignIn).toHaveBeenCalled();
    cleanup();
    renderView({
      core: table({
        artifacts_request: () => {
          throw { code: "offline" };
        },
      }),
    });
    expect((await screen.findByTestId("artifact-problem")).textContent).toContain("Could not connect");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("Spanish copy", async () => {
    renderView({ locale: "es" });
    expect(await screen.findByRole("heading", { name: "Enlaces compartidos" })).toBeTruthy();
    const row = (await screen.findAllByTestId("link-row"))[0];
    expect(row.textContent).toContain("Público");
    expect(row.textContent).toContain("3 visitas");
  });
});

describe("relativeTime", () => {
  it("formats minutes, hours and days in the locale", () => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    expect(relativeTime("2026-11-14T12:10:00Z", "en", now)).toBe("in 10 minutes");
    expect(relativeTime("2026-11-14T09:00:00Z", "en", now)).toBe("3 hours ago");
    expect(relativeTime("2026-11-17T12:00:00Z", "es", now)).toBe("dentro de 3 días");
    expect(relativeTime("nope", "en", now)).toBe("");
    expect(relativeTime(null, "en", now)).toBe("");
  });
});

// R20-A audit: no first open of an artifacts surface may throw, whatever
// the list looks like (the real wire shapes included) or however the core
// answers. A throw here would show the crashed-section fallback.
describe("SharedLinksView: first open never throws (R20-A)", () => {
  const ENTERPRISE_ROW = {
    id: A,
    title: "Informe",
    filename: "informe.pdf",
    kind: "document",
    content_type: "application/pdf",
    size: 1024,
    sha256: "ab",
    scope: "members",
    status: "active",
    recipient_count: 2,
    external_count: 0,
    risk_ack_kind: null,
    expires_at: null,
    created_at: "2026-11-10T10:00:00.123456Z",
    revoked_at: null,
    revoked_reason: null,
    view_count: 0,
    last_viewed_at: null,
  };
  const COMMUNITY_ROW = {
    id: B,
    title: "Notas",
    filename: "notas.md",
    content_type: "text/markdown",
    kind: "document",
    size: 10,
    scope: "emails",
    recipient_count: 1,
    recipients: ["a@b.io"],
    expires_at: iso(3),
    created_at: iso(-1),
    view_count: 2,
    last_viewed_at: null,
    revoked_at: null,
    status: "active",
    url: null,
  };

  const replies: Array<[string, unknown]> = [
    ["an empty enterprise list", { status: 200, body: { artifacts: [], total: 0 } }],
    ["a real enterprise list", { status: 200, body: { artifacts: [ENTERPRISE_ROW], total: 1 } }],
    ["a real community list with null urls", { status: 200, body: { artifacts: [COMMUNITY_ROW] } }],
    ["a null list", { status: 200, body: { artifacts: null } }],
    ["a null body", { status: 200, body: null }],
    ["no reply at all", undefined],
    ["rows of junk", { status: 200, body: { artifacts: [null, 3, "x", { id: 5 }, { id: A, title: { x: 1 } }] } }],
    ["a server code shaped like a prototype key", { status: 400, body: { error: "constructor" } }],
  ];

  for (const [name, reply] of replies) {
    for (const admin of [false, true]) {
      it(`${name}${admin ? " (admin, then the Organization tab)" : ""}`, async () => {
        renderView({ admin, locale: "es", core: table({ artifacts_request: () => reply }) });
        expect(await screen.findByRole("heading", { name: "Enlaces compartidos", level: 1 })).toBeTruthy();
        await waitFor(() => expect(screen.queryByText("Cargando enlaces…")).toBeNull());
        if (admin) {
          fireEvent.click(screen.getByRole("tab", { name: "Organización" }));
          await waitFor(() => expect(screen.queryByText("Cargando enlaces…")).toBeNull());
        }
        expect(screen.getByRole("button", { name: "Actualizar" })).toBeTruthy();
      });
    }
  }

  it("a core refusal that is not an object (a bare string) reads as a generic problem", async () => {
    renderView({
      core: table({
        artifacts_request: () => {
          throw "no_session";
        },
      }),
    });
    expect(await screen.findByTestId("artifact-problem")).toBeTruthy();
  });
});
