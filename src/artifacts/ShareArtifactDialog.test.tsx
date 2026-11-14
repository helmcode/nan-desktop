// @vitest-environment jsdom
// Shared artifacts (F3): the share dialog flows. Scopes per profile, the
// bold risk warning and its required checkbox (Create link disabled until
// it is checked, reset when the risk grows), the success state with copy
// to clipboard, the error copy, and no key material in any log line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invokedWith, resetTauri } from "../test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());

import { I18nProvider } from "../i18n";
import type { Locale } from "../i18n/locale";
import { RISK_VERSION, type ShareSource } from "./artifacts";
import { ShareArtifactDialog } from "./ShareArtifactDialog";

const SOURCE: ShareSource = { kind: "file", path: "/Users/u/proj/informe-q3.pdf" };
const URL_OK = "https://share.helmcode.com/a/AbCdEf0123456789";
const MEMBERS = { items: [{ userId: "u1", email: "ana@acme.com" }, { userId: "u2", email: "bob@acme.com" }] };

type Table = Parameters<typeof resetTauri>[0];

function core(extra: Table = {}): Table {
  return {
    artifacts_request: (args) =>
      args?.path === "/api/members" ? { status: 200, body: MEMBERS } : { status: 200, body: {} },
    artifact_share: () => ({ status: 201, body: { artifact: { id: "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e" }, url: URL_OK } }),
    open_external: () => null,
    ...extra,
  };
}

function renderDialog({
  profileId = "helmcode",
  availability = "on" as const,
  locale = "en" as Locale,
  table = core(),
}: { profileId?: string; availability?: "on" | "paywall"; locale?: Locale; table?: Table } = {}) {
  resetTauri(table);
  const props = {
    onClose: vi.fn(),
    onManage: vi.fn(),
    onNotice: vi.fn(),
    onSignIn: vi.fn(),
    onDisabled: vi.fn(),
  };
  render(
    <I18nProvider initial={locale}>
      <ShareArtifactDialog profileId={profileId} source={SOURCE} availability={availability} {...props} />
    </I18nProvider>,
  );
  return props;
}

const create = () => screen.getByRole("button", { name: /Create link|Crear enlace/ });
const accept = () => screen.getByRole("checkbox", { name: /I understand the risk|Entiendo el riesgo/ });

function addEmail(value: string): void {
  const input = screen.getByRole("textbox", { name: /Email addresses|Direcciones de email/ });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
}

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("ShareArtifactDialog: scopes", () => {
  it("enterprise offers four scopes", async () => {
    renderDialog();
    const radios = screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);
    expect(radios).toEqual(["emails", "members", "org", "public"]);
    await waitFor(() => expect(invokedWith("artifacts_request")).toHaveLength(1));
  });

  it("community offers emails and public only, and never asks for members", () => {
    renderDialog({ profileId: "nan" });
    const radios = screen.getAllByRole("radio").map((radio) => (radio as HTMLInputElement).value);
    expect(radios).toEqual(["emails", "public"]);
    expect(invokedWith("artifacts_request")).toHaveLength(0);
  });

  it("opens prefilled with the file name, focus on Cancel", () => {
    renderDialog({ profileId: "nan" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("informe-q3.pdf");
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(create().hasAttribute("disabled")).toBe(true);
  });

  it("expiry options follow the scope", () => {
    renderDialog();
    const options = () =>
      Array.from(screen.getByRole("combobox").querySelectorAll("option")).map((o) => o.textContent);
    expect(options()).toEqual(["1 day", "7 days", "30 days", "90 days"]);
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    expect(options()).toEqual(["1 day", "7 days", "30 days"]);
    fireEvent.click(screen.getByRole("radio", { name: /Everyone in your organization/ }));
    expect(options()).toEqual(["7 days", "30 days", "90 days", "No expiry"]);
  });

  it("org scope shares without a warning", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /Everyone in your organization/ }));
    expect(screen.queryByTestId("artifact-risk")).toBeNull();
    expect(create().hasAttribute("disabled")).toBe(false);
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    const meta = invokedWith("artifact_share")[0]?.meta as Record<string, unknown>;
    expect(meta).toEqual({ title: "informe-q3.pdf", scope: "org", emails: [], member_ids: [], expires_days: 90, notify: false });
  });

  it("'No expiry' reaches the core as expires_days 0, not null (null = server default)", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /Everyone in your organization/ }));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    const never = Array.from(select.querySelectorAll("option")).find((o) => o.textContent === "No expiry");
    fireEvent.change(select, { target: { value: never?.value } });
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    const meta = invokedWith("artifact_share")[0]?.meta as Record<string, unknown>;
    expect(meta.expires_days).toBe(0);
  });

  it("members scope picks from the org list and sends user ids", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /Team members/ }));
    const bob = await screen.findByRole("checkbox", { name: "bob@acme.com" });
    expect(create().hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bo" } });
    expect(screen.queryByRole("checkbox", { name: "ana@acme.com" })).toBeNull();
    fireEvent.click(bob);
    expect(screen.getByText("1 member selected")).toBeTruthy();
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    expect((invokedWith("artifact_share")[0]?.meta as Record<string, unknown>).member_ids).toEqual(["u2"]);
  });
});

describe("ShareArtifactDialog: risk warning and consent", () => {
  it("public shows the bold warning and Create link waits for the checkbox", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    const risk = screen.getByTestId("artifact-risk");
    const alert = within(risk).getByRole("alert");
    expect(alert.querySelector("strong")?.textContent).toContain("Anyone with this link can open this file");
    expect(create().hasAttribute("disabled")).toBe(true);
    fireEvent.click(accept());
    expect(create().hasAttribute("disabled")).toBe(false);
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    const meta = invokedWith("artifact_share")[0]?.meta as Record<string, unknown>;
    expect(meta.risk_ack).toEqual({ kind: "public", version: RISK_VERSION });
    expect(meta.expires_days).toBe(7);
  });

  it("enterprise: internal recipients need no warning, an external one does", async () => {
    renderDialog();
    await waitFor(() => expect(invokedWith("artifacts_request")).toHaveLength(1));
    addEmail("ana@acme.com");
    expect(screen.queryByTestId("artifact-risk")).toBeNull();
    expect(create().hasAttribute("disabled")).toBe(false);
    addEmail("eve@other.io");
    expect(screen.getByText("External")).toBeTruthy();
    expect(screen.getByTestId("artifact-risk").textContent).toContain("1 recipient is outside your organization");
    expect(create().hasAttribute("disabled")).toBe(true);
    fireEvent.click(accept());
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    const meta = invokedWith("artifact_share")[0]?.meta as Record<string, unknown>;
    expect(meta.emails).toEqual(["ana@acme.com", "eve@other.io"]);
    expect(meta.risk_ack).toEqual({ kind: "external", version: RISK_VERSION });
    expect(meta.notify).toBe(true);
  });

  it("the acceptance resets when another external recipient is added or the scope turns public", async () => {
    renderDialog();
    await waitFor(() => expect(invokedWith("artifacts_request")).toHaveLength(1));
    addEmail("eve@other.io");
    fireEvent.click(accept());
    expect((accept() as HTMLInputElement).checked).toBe(true);
    addEmail("zed@else.io");
    expect((accept() as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId("artifact-risk").textContent).toContain("2 recipients are outside");
    fireEvent.click(accept());
    // Removing one keeps it.
    fireEvent.click(screen.getByRole("button", { name: "Remove zed@else.io" }));
    expect((accept() as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    expect((accept() as HTMLInputElement).checked).toBe(false);
    expect(create().hasAttribute("disabled")).toBe(true);
  });

  it("community: every email share carries the warning", () => {
    renderDialog({ profileId: "nan" });
    addEmail("Ana@Example.com, bob@x.io");
    expect(screen.getByText("ana@example.com")).toBeTruthy();
    expect(screen.queryByText("External")).toBeNull();
    expect(screen.getByTestId("artifact-risk").textContent).toContain(
      "These people will be able to open this file after verifying their email.",
    );
    expect(create().hasAttribute("disabled")).toBe(true);
    fireEvent.click(accept());
    expect(create().hasAttribute("disabled")).toBe(false);
  });

  it("a server 422 risk_ack_required shows the warning again, unchecked", async () => {
    let calls = 0;
    renderDialog({
      table: core({
        artifact_share: () => {
          calls += 1;
          return calls === 1
            ? { status: 422, body: { error: "risk_ack_required" } }
            : { status: 201, body: { url: URL_OK } };
        },
      }),
    });
    await waitFor(() => expect(invokedWith("artifacts_request")).toHaveLength(1));
    addEmail("ana@acme.com");
    fireEvent.click(create());
    const problem = await screen.findByTestId("artifact-problem");
    expect(problem.textContent).toContain("outside your organization");
    expect((accept() as HTMLInputElement).checked).toBe(false);
    expect(create().hasAttribute("disabled")).toBe(true);
    fireEvent.click(accept());
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    expect((invokedWith("artifact_share")[1]?.meta as Record<string, unknown>).risk_ack).toEqual({
      kind: "external",
      version: RISK_VERSION,
    });
  });

  it("a possible secret needs its own explicit confirmation", async () => {
    let calls = 0;
    renderDialog({
      table: core({
        artifact_share: () => {
          calls += 1;
          if (calls === 1) throw { code: "possible_secret", detail: "possible_secret" };
          return { status: 201, body: { url: URL_OK } };
        },
      }),
    });
    fireEvent.click(screen.getByRole("radio", { name: /Everyone in your organization/ }));
    fireEvent.click(create());
    const secret = await screen.findByTestId("artifact-secret");
    expect(secret.querySelector("strong")?.textContent).toContain("password, key or token");
    expect(create().hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(secret).getByRole("checkbox"));
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    expect((invokedWith("artifact_share")[1]?.meta as Record<string, unknown>).secret_ack).toBe(true);
  });

  it("Spanish copy: bold warning and the acceptance text", () => {
    renderDialog({ profileId: "nan", locale: "es" });
    fireEvent.click(screen.getByRole("radio", { name: /Público/ }));
    expect(screen.getByTestId("artifact-risk").querySelector("strong")?.textContent).toContain(
      "Cualquiera con este enlace podrá abrir este archivo",
    );
    expect(accept()).toBeTruthy();
    expect(create().hasAttribute("disabled")).toBe(true);
  });
});

describe("ShareArtifactDialog: emails", () => {
  it("keeps an invalid address in the input with an error", () => {
    renderDialog({ profileId: "nan" });
    addEmail("nope");
    expect(screen.getByText('"nope" is not a valid email address.')).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Email addresses" }) as HTMLInputElement).value).toBe("nope");
  });

  it("pasting a list splits it", () => {
    renderDialog({ profileId: "nan" });
    const input = screen.getByRole("textbox", { name: "Email addresses" });
    fireEvent.paste(input, { clipboardData: { getData: () => "a@x.io; b@y.io" } });
    expect(screen.getByText("a@x.io")).toBeTruthy();
    expect(screen.getByText("b@y.io")).toBeTruthy();
  });
});

describe("ShareArtifactDialog: success", () => {
  async function shareOrg() {
    const props = renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /Everyone in your organization/ }));
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    return props;
  }

  it("shows the link focused, copies it and confirms", async () => {
    const props = await shareOrg();
    const field = screen.getByLabelText("Link") as HTMLInputElement;
    expect(field.value).toBe(URL_OK);
    expect(field.readOnly).toBe(true);
    expect(document.activeElement).toBe(field);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(writeText).toHaveBeenCalledWith(URL_OK);
    expect(props.onNotice).toHaveBeenCalledWith("success", "Link copied");
    expect(screen.getByRole("status").textContent).toBe("Link copied");
  });

  it("a clipboard failure says how to copy by hand", async () => {
    await shareOrg();
    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    });
    expect(screen.getByRole("alert").textContent).toContain("Select it and copy it by hand");
  });

  it("opens in the browser and goes to Manage links", async () => {
    const props = await shareOrg();
    fireEvent.click(screen.getByRole("button", { name: /Open in browser/ }));
    expect(invokedWith("open_external")[0]).toEqual({ url: URL_OK });
    fireEvent.click(screen.getByRole("button", { name: "Manage links" }));
    expect(props.onManage).toHaveBeenCalled();
  });

  it("a public link repeats the reminder", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    fireEvent.click(accept());
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    expect(screen.getByText("Anyone with this link can open the file.").tagName).toBe("STRONG");
  });
});

describe("ShareArtifactDialog: errors", () => {
  async function failWith(reply: () => unknown, profileId = "helmcode") {
    const props = renderDialog({ profileId, table: core({ artifact_share: reply }) });
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    fireEvent.click(accept());
    fireEvent.click(create());
    return props;
  }

  it.each([
    [{ status: 413, body: { error: "too_large" } }, "too large to share (8 MB at most)"],
    [{ status: 415, body: { error: "unsupported_type" } }, "This file type cannot be shared"],
    [{ status: 409, body: { error: "quota_exceeded" } }, "limit of shared links"],
    [{ status: 429, body: null }, "Too many attempts"],
    [{ status: 500, body: "<html>" }, "Something went wrong"],
  ])("server %j reads friendly copy", async (reply, text) => {
    await failWith(() => reply);
    expect((await screen.findByTestId("artifact-problem")).textContent).toContain(text);
  });

  it("an expired session offers to sign in again", async () => {
    const props = await failWith(() => {
      throw { code: "no_session", detail: "no_session" };
    });
    const line = await screen.findByTestId("artifact-problem");
    fireEvent.click(within(line).getByRole("button", { name: "Sign in again" }));
    expect(props.onSignIn).toHaveBeenCalled();
  });

  it("a 404 means the feature is off: the caller hides it", async () => {
    const props = await failWith(() => ({ status: 404, body: null }));
    expect((await screen.findByTestId("artifact-problem")).textContent).toContain("not available");
    expect(props.onDisabled).toHaveBeenCalled();
  });

  it("entitlement_required switches to the membership copy", async () => {
    await failWith(() => ({ status: 403, body: { error: "entitlement_required" } }), "nan");
    expect(await screen.findByText("Sharing links is part of the membership")).toBeTruthy();
  });

  it("a file outside the grants reads as such", async () => {
    await failWith(() => {
      throw { code: "source_refused", detail: "source_refused", reason: "no_grant" };
    });
    expect((await screen.findByTestId("artifact-problem")).textContent).toContain("working folders");
  });
});

describe("ShareArtifactDialog: paywall and Escape", () => {
  it("paywall availability shows the membership copy instead of the form", () => {
    const props = renderDialog({ profileId: "nan", availability: "paywall" });
    expect(screen.getByText("Sharing links is part of the membership")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("Escape cancels", () => {
    const props = renderDialog({ profileId: "nan" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("ShareArtifactDialog: no key material in logs", () => {
  it("nothing sk-like, no Bearer and no link reaches the console", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
      });
    }
    renderDialog({
      table: core({
        artifact_share: () => ({
          status: 201,
          body: { artifact: { id: "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e" }, url: URL_OK, debug: "sk-hke_LEAKLEAKLEAK" },
        }),
      }),
    });
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    fireEvent.click(accept());
    fireEvent.click(create());
    await screen.findByText("Your link is ready");
    const joined = lines.join("\n");
    expect(joined).not.toMatch(/sk-/);
    expect(joined).not.toMatch(/bearer/i);
    expect(joined).not.toContain(URL_OK);
    // The dialog never renders anything but the https link from the reply.
    expect(document.body.textContent).not.toContain("sk-hke_");
  });
});
