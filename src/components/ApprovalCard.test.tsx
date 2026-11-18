// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { ApprovalCardState } from "../chat/approvals";
import { ApprovalCard } from "./ApprovalCard";
import { readFileSync } from "node:fs";

afterEach(cleanup);

const base: ApprovalCardState = {
  id: "act-1",
  conversationId: 1,
  action: "delete_path",
  target: "/Users/ana/Proyecto/old.txt",
  destination: null,
  cwd: null,
  diffPreview: null,
  permanent: false,
  anchorIndex: 1,
  status: "pending",
  failed: false,
};

function renderCard(card: Partial<ApprovalCardState> = {}, onRespond = vi.fn()) {
  render(
    <I18nProvider initial="en">
      <ApprovalCard card={{ ...base, ...card }} onRespond={onRespond} />
    </I18nProvider>,
  );
  return onRespond;
}

describe("ApprovalCard (S14)", () => {
  it("shows the action summary, target and both choices while pending", () => {
    renderCard();
    expect(screen.getByText("Delete a file")).toBeTruthy();
    expect(screen.getByText(base.target)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("forwards Allow and Deny with the pending-action id", () => {
    const onRespond = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onRespond.mock.calls).toEqual([
      ["act-1", true],
      ["act-1", false],
    ]);
  });

  it("shows the destination of a move", () => {
    renderCard({ action: "move_path", destination: "/Users/ana/Proyecto/new.txt" });
    expect(screen.getByText("Move a file")).toBeTruthy();
    expect(screen.getByText("/Users/ana/Proyecto/new.txt")).toBeTruthy();
  });

  it("labels every core action kind", () => {
    for (const [action, label] of [
      ["read_file", "Read a file"],
      ["list_files", "List a folder"],
      ["write_file", "Write a file"],
      ["replace_file", "Change a file"],
      ["run_command", "Run a command"],
      ["save_image", "Save an image"],
      // R20-D: the assistant's website, written to the session folder.
      ["write_website", "Save a website"],
    ]) {
      cleanup();
      renderCard({ action });
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("names the website action naturally in Spanish", () => {
    render(
      <I18nProvider initial="es">
        <ApprovalCard card={{ ...base, action: "write_website" }} onRespond={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText("Guardar un sitio web")).toBeTruthy();
  });

  it("shows the command folder, the permanent-delete warning and the diff", () => {
    renderCard({ action: "run_command", target: "ls", cwd: "/Users/ana/Proyecto" });
    expect(screen.getByText("/Users/ana/Proyecto")).toBeTruthy();
    cleanup();
    renderCard({ permanent: true });
    expect(screen.getByText(/cannot be undone/)).toBeTruthy();
    cleanup();
    renderCard({ action: "write_file", diffPreview: "+new line" });
    expect(screen.getByText("See the changes")).toBeTruthy();
    expect(screen.getByText("+new line")).toBeTruthy();
  });

  it("hides the buttons while the answer is being sent", () => {
    renderCard({ status: "sending" });
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
    expect(screen.getByText("Sending…")).toBeTruthy();
  });

  it("shows a retryable error when sending failed", () => {
    renderCard({ failed: true });
    expect(screen.getByRole("alert").textContent).toContain("Could not send");
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  it("collapses to a one-line outcome once resolved", () => {
    renderCard({ status: "denied" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Denied: Delete a file");
  });

  it("labels unknown actions generically and in Spanish", () => {
    render(
      <I18nProvider initial="es">
        <ApprovalCard card={{ ...base, action: "teleport" }} onRespond={() => {}} />
      </I18nProvider>,
    );
    expect(screen.getByText("Usar tus archivos")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Permitir" })).toBeTruthy();
  });

  it("names browser approvals in plain words, with one detail line", () => {
    renderCard({ action: "browser_site", target: "example.com" });
    expect(screen.getByText("Use this website in the browser")).toBeTruthy();
    expect(screen.getByText("example.com")).toBeTruthy();
    expect(screen.getByText("You will see what it does and can stop it.")).toBeTruthy();
    cleanup();
    renderCard({ action: "browser_payment", target: "shop.example" });
    expect(screen.getByText("Pay or buy on this website")).toBeTruthy();
    expect(screen.getByText("Check the browser window before allowing it.")).toBeTruthy();
    expect(screen.getByRole("group").className).toContain("danger");
    cleanup();
    renderCard({ action: "browser_login", target: "mail.example" });
    expect(screen.getByText("Sign in to your account")).toBeTruthy();
    expect(screen.getByRole("group").className).not.toContain("danger");
    cleanup();
    // Local network: neutral style, plain-words copy.
    renderCard({ action: "browser_local_site", target: "192.168.1.1" });
    expect(screen.getByText("Open an address on your local network (router, NAS…)")).toBeTruthy();
    expect(screen.getByRole("group").className).not.toContain("danger");
    cleanup();
    // File actions get no detail line.
    renderCard();
    expect(document.querySelector(".approval-detail")).toBeNull();
  });

  it("renders an allow-mode notice as a plain line with no buttons", () => {
    renderCard({ action: "browser_site_used", target: "example.com", status: "granted", notice: true });
    expect(screen.getByRole("status").textContent).toBe("Usingexample.com");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says why it asks when only the browsing protection made it ask", () => {
    renderCard({ action: "write_file", target: "/Users/ana/a.txt", afterBrowsing: true });
    expect(screen.getByText("Asked because the assistant visited web pages in this task.")).toBeTruthy();
    cleanup();
    renderCard({ action: "write_file", target: "/Users/ana/a.txt" });
    expect(screen.queryByText(/visited web pages/)).toBeNull();
  });
});

describe("ApprovalCard: share_artifact", () => {
  const share = {
    file_name: "informe.pdf",
    source: "folder",
    location: "~/clients/acme/informe.pdf",
    title: "Informe Q3",
    audience: "public",
    recipients: [] as string[],
    expires_days: 7,
    notify: false,
    risk: "public" as const,
  };

  it("names the file, who gets it, the expiry and the risk the Allow accepts", () => {
    const onRespond = renderCard({ action: "share_artifact", target: share.location, share });
    expect(screen.getByText("Share as a link")).toBeTruthy();
    // The whole path, so a look-alike file elsewhere cannot pass for yours.
    expect(screen.getByText("~/clients/acme/informe.pdf")).toBeTruthy();
    // The model's title is labeled, never a bare statement.
    expect(screen.getByText("Title: Informe Q3")).toBeTruthy();
    expect(screen.getByText("Public: anyone with the link")).toBeTruthy();
    expect(screen.getByText("Expires in 7 days")).toBeTruthy();
    const risk = screen.getByRole("note");
    expect(risk.textContent).toContain("Anyone with this link can open this file");
    expect(risk.textContent).toContain("By allowing it, you accept this risk.");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onRespond).toHaveBeenCalledWith("act-1", true);
  });

  it("keeps the file name and the whole location visible (no truncation)", () => {
    const deep = "~/clients/acme/contracts/2026/q4/legal/review/final/plan.pdf";
    renderCard({ action: "share_artifact", target: deep, share: { ...share, file_name: "plan.pdf", location: deep } });
    const card = screen.getByRole("group");
    expect(card.className).toContain("approval-card-share");
    const name = screen.getByText("plan.pdf");
    expect(name.tagName).toBe("STRONG");
    expect(screen.getByText(deep).className).toBe("approval-target");
    // The share card's target wraps instead of the default one-line ellipsis.
    const shareCss = readFileSync("src/components/ApprovalShare.css", "utf8");
    const rule = shareCss.slice(shareCss.indexOf(".approval-card-share .approval-target"));
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/text-overflow:\s*clip/);
  });

  it("labels a website built in this conversation", () => {
    renderCard({
      action: "share_artifact",
      target: "website-calc.html",
      share: { ...share, source: "website", location: "website-calc.html", file_name: "website-calc.html", title: "Calc" },
    });
    // Name on its own (bold) line, and the location under it.
    expect(screen.getAllByText("website-calc.html").map((el) => el.tagName)).toEqual(["STRONG", "CODE"]);
    expect(screen.getByText("The website built in this conversation")).toBeTruthy();
  });

  it("lists the recipients, the email notice and the community risk", () => {
    renderCard({
      action: "share_artifact",
      target: "notas.md",
      share: { ...share, file_name: "notas.md", title: "notas.md", audience: "emails", recipients: ["ana@acme.com", "bo@acme.com"], expires_days: 30, notify: true, risk: "external" },
    });
    expect(screen.getByText("With: ana@acme.com, bo@acme.com")).toBeTruthy();
    expect(screen.getByText("They will get the link by email.")).toBeTruthy();
    expect(screen.getByText("Expires in 30 days")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Only you and these people can open this file");
  });

  it("an organization share without expiry carries no risk copy (Spanish)", () => {
    render(
      <I18nProvider initial="es">
        <ApprovalCard
          card={{ ...base, action: "share_artifact", target: "informe.pdf", share: { ...share, audience: "org", expires_days: 0, risk: null } }}
          onRespond={vi.fn()}
        />
      </I18nProvider>,
    );
    expect(screen.getByText("Compartir como enlace")).toBeTruthy();
    expect(screen.getByText("Toda tu organización")).toBeTruthy();
    expect(screen.getByText("Sin caducidad")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("collapses to the outcome with the file name once answered", () => {
    renderCard({ action: "share_artifact", target: "informe.pdf", share, status: "granted" });
    expect(screen.getByRole("status").textContent).toContain("Share as a link");
    expect(screen.getByText("informe.pdf")).toBeTruthy();
  });
});
