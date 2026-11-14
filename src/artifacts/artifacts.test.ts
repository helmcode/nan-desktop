// Shared artifacts (F2): the pure decisions (scopes per profile, risk and
// its acceptance reset rule, expiry options, email parsing, tolerant reply
// parsing, error mapping) and the IPC wrappers over the mocked Tauri core.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invokedWith, resetTauri } from "../test/tauriMock";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());

import {
  MAX_RECIPIENTS,
  RISK_VERSION,
  ackCovers,
  addEmails,
  buildMeta,
  canSubmit,
  defaultExpiry,
  expiryFor,
  expiryOptions,
  externalEmails,
  fetchAccess,
  fetchMembers,
  isValidEmail,
  linkState,
  listArtifacts,
  parseAccess,
  parseArtifact,
  parseArtifactList,
  parseMembers,
  parseShareReply,
  problemForError,
  problemForReply,
  revokeArtifact,
  riskFor,
  safeLink,
  scopeOptions,
  shareArtifact,
  shareSourceFor,
  type ShareDraft,
} from "./artifacts";

const ID = "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e";
const MEMBERS = [
  { userId: "u1", email: "ana@acme.com" },
  { userId: "u2", email: "bob@acme.com" },
];

function draft(patch: Partial<ShareDraft> = {}): ShareDraft {
  return { title: "Report", scope: "emails", emails: [], memberIds: [], expiresDays: 30, notify: true, ...patch };
}

describe("scopes and expiry", () => {
  it("enterprise offers four scopes, community two", () => {
    expect(scopeOptions("helmcode")).toEqual(["emails", "members", "org", "public"]);
    expect(scopeOptions("nan")).toEqual(["emails", "public"]);
  });

  it("expiry options, defaults and caps follow the design table", () => {
    expect(expiryOptions("public")).toEqual([1, 7, 30]);
    expect(expiryOptions("emails")).toEqual([1, 7, 30, 90]);
    expect(expiryOptions("members")).toEqual([7, 30, 90, null]);
    expect(expiryOptions("org")).toEqual([7, 30, 90, null]);
    expect(defaultExpiry("public")).toBe(7);
    expect(defaultExpiry("emails")).toBe(30);
    expect(defaultExpiry("org")).toBe(90);
    // A scope change keeps a valid choice, else falls back to the default.
    expect(expiryFor("public", 30)).toBe(30);
    expect(expiryFor("public", 90)).toBe(7);
    expect(expiryFor("emails", null)).toBe(30);
    expect(expiryFor("org", null)).toBeNull();
  });
});

describe("emails", () => {
  it("validates like the core", () => {
    for (const ok of ["a@x.io", "first.last+tag@sub.example.com"]) expect(isValidEmail(ok)).toBe(true);
    for (const bad of ["", "nope", "a@b", "a b@x.io", "a@x..io", "<a@x.io>", "a@@x.io", "ä@x.io", "@x.io"]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it("splits pastes, lowercases, deduplicates and keeps the invalid part", () => {
    const res = addEmails(["ana@acme.com"], "Ana@Acme.com, bob@other.io; nope\ncarl@x.io");
    expect(res.emails).toEqual(["ana@acme.com", "bob@other.io", "carl@x.io"]);
    expect(res.invalid).toEqual(["nope"]);
    expect(res.overflow).toBe(0);
  });

  it("caps recipients at 20", () => {
    const full = Array.from({ length: MAX_RECIPIENTS }, (_, i) => `u${i}@x.io`);
    const res = addEmails(full, "one@x.io two@x.io");
    expect(res.emails).toHaveLength(MAX_RECIPIENTS);
    expect(res.overflow).toBe(2);
  });
});

describe("risk warning", () => {
  it("public always needs acceptance, on both tenants", () => {
    expect(riskFor("helmcode", "public", [], MEMBERS)).toEqual({ kind: "public", external: [] });
    expect(riskFor("nan", "public", [], null)).toEqual({ kind: "public", external: [] });
  });

  it("enterprise: only external recipients need it", () => {
    expect(riskFor("helmcode", "emails", ["ana@acme.com"], MEMBERS)).toBeNull();
    expect(riskFor("helmcode", "emails", ["ana@acme.com", "eve@other.io"], MEMBERS)).toEqual({
      kind: "external",
      external: ["eve@other.io"],
    });
    expect(riskFor("helmcode", "members", [], MEMBERS)).toBeNull();
    expect(riskFor("helmcode", "org", [], MEMBERS)).toBeNull();
  });

  it("enterprise without a members list treats everyone as external", () => {
    expect(externalEmails("helmcode", ["ana@acme.com"], null)).toEqual(["ana@acme.com"]);
  });

  it("community: every email recipient is external", () => {
    expect(riskFor("nan", "emails", ["ana@acme.com"], MEMBERS)).toEqual({
      kind: "external",
      external: ["ana@acme.com"],
    });
    expect(riskFor("nan", "emails", [], null)).toBeNull();
  });

  it("the acceptance resets when the risk grows, never when it shrinks", () => {
    const one = { kind: "external" as const, external: ["a@x.io"] };
    const two = { kind: "external" as const, external: ["a@x.io", "b@y.io"] };
    const pub = { kind: "public" as const, external: [] };
    expect(ackCovers(one, one)).toBe(true);
    expect(ackCovers(two, one)).toBe(true);
    expect(ackCovers(one, two)).toBe(false);
    expect(ackCovers(one, pub)).toBe(false);
    expect(ackCovers(pub, one)).toBe(false);
    expect(ackCovers(null, pub)).toBe(false);
    expect(ackCovers(null, null)).toBe(true);
  });
});

describe("share meta", () => {
  it("confirm stays disabled until recipients and acceptance are there", () => {
    const risk = { kind: "external" as const, external: ["a@x.io"] };
    expect(canSubmit(draft(), null, false, false)).toBe(false);
    expect(canSubmit(draft({ emails: ["a@x.io"] }), risk, false, false)).toBe(false);
    expect(canSubmit(draft({ emails: ["a@x.io"] }), risk, true, false)).toBe(true);
    expect(canSubmit(draft({ emails: ["a@x.io"] }), risk, true, true)).toBe(false);
    expect(canSubmit(draft({ scope: "members" }), null, false, false)).toBe(false);
    expect(canSubmit(draft({ scope: "members", memberIds: ["u1"] }), null, false, false)).toBe(true);
    expect(canSubmit(draft({ scope: "org" }), null, false, false)).toBe(true);
    expect(canSubmit(draft({ scope: "org", title: "x".repeat(121) }), null, false, false)).toBe(false);
  });

  it("sends only the chosen scope's recipients and the versioned ack", () => {
    const meta = buildMeta(
      draft({ scope: "public", emails: ["a@x.io"], memberIds: ["u1"], expiresDays: 90 }),
      { kind: "public", external: [] },
      false,
    );
    expect(meta).toEqual({
      title: "Report",
      scope: "public",
      emails: [],
      member_ids: [],
      expires_days: 7,
      notify: false,
      risk_ack: { kind: "public", version: RISK_VERSION },
    });
    const members = buildMeta(draft({ scope: "members", memberIds: ["u1"], expiresDays: null }), null, true);
    expect(members).toEqual({
      title: "Report",
      scope: "members",
      emails: [],
      member_ids: ["u1"],
      expires_days: null,
      notify: true,
      secret_ack: true,
    });
  });
});

describe("source", () => {
  it("shares granted files of allowed types and generated images, never web pages", () => {
    expect(shareSourceFor({ kind: "file", ref: "/p/informe.PDF" })).toEqual({ kind: "file", path: "/p/informe.PDF" });
    expect(shareSourceFor({ kind: "file", ref: "/p/a.xlsx" })).not.toBeNull();
    expect(shareSourceFor({ kind: "media", ref: "/data/images/x.png" })).toEqual({
      kind: "media",
      path: "/data/images/x.png",
    });
    expect(shareSourceFor({ kind: "file", ref: "/p/script.sh" })).toBeNull();
    expect(shareSourceFor({ kind: "file", ref: "/p/a.svg" })).toBeNull();
    expect(shareSourceFor({ kind: "web", ref: "https://x.io/a.pdf" })).toBeNull();
  });
});

describe("reply parsing", () => {
  const row = {
    id: ID,
    title: "Informe Q3",
    filename: "informe-q3.pdf",
    content_type: "application/pdf",
    size: 1200,
    scope: "emails",
    recipient_count: 2,
    expires_at: "2026-12-14T00:00:00Z",
    created_at: "2026-11-14T00:00:00Z",
    view_count: 3,
    url: "https://share.helmcode.com/a/tok",
  };

  it("parses the design's artifact shape", () => {
    expect(parseArtifact(row)).toEqual({
      id: ID,
      title: "Informe Q3",
      filename: "informe-q3.pdf",
      contentType: "application/pdf",
      size: 1200,
      scope: "emails",
      recipientCount: 2,
      expiresAt: "2026-12-14T00:00:00Z",
      createdAt: "2026-11-14T00:00:00Z",
      revokedAt: null,
      viewCount: 3,
      url: "https://share.helmcode.com/a/tok",
      owner: null,
    });
  });

  it("tolerates camelCase, missing fields and owner objects", () => {
    const parsed = parseArtifact({ id: ID, fileName: "a.md", viewCount: 1, owner: { email: "ana@acme.com" } });
    expect(parsed?.title).toBe("");
    expect(parsed?.filename).toBe("a.md");
    expect(parsed?.viewCount).toBe(1);
    expect(parsed?.owner).toBe("ana@acme.com");
    expect(parseArtifact({ title: "no id" })).toBeNull();
    expect(parseArtifact(null)).toBeNull();
  });

  it("create reply needs an https url", () => {
    expect(parseShareReply({ artifact: row, url: "https://share.nan.builders/a/t" })?.url).toBe(
      "https://share.nan.builders/a/t",
    );
    expect(parseShareReply({ artifact: row, url: "http://share.nan.builders/a/t" })).toBeNull();
    expect(parseShareReply({ artifact: row, url: "javascript:alert(1)" })).toBeNull();
    expect(parseShareReply({ artifact: row })?.url).toBe("https://share.helmcode.com/a/tok");
    expect(parseShareReply(null)).toBeNull();
    expect(safeLink("not a url")).toBeNull();
  });

  it("lists accept {artifacts}, {items} or an array and skip junk rows", () => {
    expect(parseArtifactList({ artifacts: [row, { nope: 1 }] })).toHaveLength(1);
    expect(parseArtifactList({ items: [row] })).toHaveLength(1);
    expect(parseArtifactList([row])).toHaveLength(1);
    expect(parseArtifactList({ artifacts: "x" })).toEqual([]);
    expect(parseArtifactList(null)).toEqual([]);
  });

  it("members come from enterprise's {items: [{userId, email}]}", () => {
    expect(parseMembers({ items: [{ userId: "u1", email: "Ana@Acme.com", role: "admin" }, { email: "x" }] })).toEqual([
      { userId: "u1", email: "ana@acme.com" },
    ]);
    expect(parseMembers({ members: [{ user_id: "u2", email: "b@x.io" }] })).toEqual([{ userId: "u2", email: "b@x.io" }]);
    expect(parseMembers("x")).toBeNull();
  });

  it("link state: revoked beats expired beats active", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    const base = parseArtifact(row)!;
    expect(linkState(base, now)).toBe("active");
    expect(linkState({ ...base, expiresAt: "2026-11-15T00:00:00Z" }, now)).toBe("expired");
    expect(linkState({ ...base, revokedAt: "2026-11-16T00:00:00Z" }, now)).toBe("revoked");
    expect(linkState({ ...base, expiresAt: null }, now)).toBe("active");
  });
});

describe("availability", () => {
  it("enterprise: the org flag in /api/auth/me, either spelling", () => {
    expect(parseAccess("helmcode", { featureFlags: ["artifacts"] }).availability).toBe("on");
    expect(parseAccess("helmcode", { featureFlags: ["artifacts_sharing"] }).availability).toBe("on");
    expect(parseAccess("helmcode", { artifactsSharing: true }).availability).toBe("on");
    expect(parseAccess("helmcode", { org: { artifacts: true } }).availability).toBe("on");
    expect(parseAccess("helmcode", { featureFlags: ["skills_sharing"], skillsSharing: true }).availability).toBe("off");
    expect(parseAccess("helmcode", { artifacts: "yes" }).availability).toBe("off");
    expect(parseAccess("helmcode", null).availability).toBe("off");
  });

  it("enterprise admins are detected from the role", () => {
    expect(parseAccess("helmcode", { featureFlags: ["artifacts"], role: "admin" }).admin).toBe(true);
    expect(parseAccess("helmcode", { featureFlags: ["artifacts"], role: "member" }).admin).toBe(false);
  });

  it("community: capabilities.artifacts, paywall without it, hidden with no capabilities", () => {
    expect(parseAccess("nan", { capabilities: { artifacts: true } }).availability).toBe("on");
    expect(parseAccess("nan", { capabilities: ["inference", "artifacts"] }).availability).toBe("on");
    expect(parseAccess("nan", { user: { capabilities: { artifacts: true } } }).availability).toBe("on");
    expect(parseAccess("nan", { capabilities: { inference: true } }).availability).toBe("paywall");
    expect(parseAccess("nan", { email: "a@x.io" }).availability).toBe("off");
    // The enterprise flag never turns on the community feature.
    expect(parseAccess("nan", { featureFlags: ["artifacts"] }).availability).toBe("off");
  });
});

describe("error mapping", () => {
  it("server codes win over the status", () => {
    expect(problemForReply(201, {})).toBeNull();
    expect(problemForReply(413, { error: "too_large" })).toBe("too_large");
    expect(problemForReply(415, { error: "unsupported_type" })).toBe("unsupported_type");
    expect(problemForReply(409, { error: "quota_exceeded" })).toBe("quota_exceeded");
    expect(problemForReply(422, { error: "risk_ack_required" })).toBe("risk_ack_required");
    expect(problemForReply(422, { code: "possible_secret" })).toBe("possible_secret");
    expect(problemForReply(400, { problem: { code: "scope_not_allowed" } })).toBe("scope_not_allowed");
    expect(problemForReply(400, { error: { code: "recipient_not_member" } })).toBe("recipient_not_member");
    expect(problemForReply(400, { error: "too_many_recipients" })).toBe("too_many_recipients");
    expect(problemForReply(403, { error: "entitlement_required" })).toBe("paywall");
  });

  it("falls back on the status for unknown or missing codes", () => {
    expect(problemForReply(400, { error: "weird" })).toBe("invalid");
    expect(problemForReply(401, null)).toBe("expired");
    expect(problemForReply(403, null)).toBe("forbidden");
    expect(problemForReply(404, null)).toBe("disabled");
    expect(problemForReply(413, null)).toBe("too_large");
    expect(problemForReply(429, null)).toBe("rate_limited");
    expect(problemForReply(502, "<html>")).toBe("generic");
  });

  it("core refusals", () => {
    expect(problemForError({ code: "no_session", detail: "no_session" })).toBe("expired");
    expect(problemForError({ code: "offline" })).toBe("offline");
    expect(problemForError({ code: "unavailable" })).toBe("offline");
    expect(problemForError({ code: "source_refused", reason: "symlink" })).toBe("source_refused");
    expect(problemForError({ code: "empty" })).toBe("empty");
    expect(problemForError({ code: "possible_secret" })).toBe("possible_secret");
    expect(problemForError({ code: "request_invalid" })).toBe("invalid");
    expect(problemForError(new Error("boom"))).toBe("generic");
    expect(problemForError("x")).toBe("generic");
  });
});

describe("IPC", () => {
  beforeEach(() => resetTauri());

  it("share passes the source and meta to the core and returns the link", async () => {
    resetTauri({
      artifact_share: () => ({ status: 201, body: { artifact: { id: ID }, url: "https://share.nan.builders/a/t" } }),
    });
    const meta = buildMeta(draft({ scope: "public" }), { kind: "public", external: [] }, false);
    const res = await shareArtifact("nan", { kind: "file", path: "/p/a.pdf" }, meta);
    expect(res).toEqual({ ok: true, url: "https://share.nan.builders/a/t", artifact: expect.objectContaining({ id: ID }) });
    expect(invokedWith("artifact_share")[0]).toEqual({ profileId: "nan", source: { kind: "file", path: "/p/a.pdf" }, meta });
  });

  it("share maps server and core failures", async () => {
    resetTauri({ artifact_share: () => ({ status: 422, body: { error: "risk_ack_required" } }) });
    expect(await shareArtifact("nan", { kind: "file", path: "/p/a.pdf" }, buildMeta(draft(), null, false))).toEqual({
      ok: false,
      problem: "risk_ack_required",
    });
    resetTauri({
      artifact_share: () => {
        throw { code: "too_large", detail: "too_large" };
      },
    });
    expect(await shareArtifact("nan", { kind: "file", path: "/p/a.pdf" }, buildMeta(draft(), null, false))).toEqual({
      ok: false,
      problem: "too_large",
    });
    resetTauri({ artifact_share: () => ({ status: 201, body: { url: "http://insecure" } }) });
    expect(await shareArtifact("nan", { kind: "file", path: "/p/a.pdf" }, buildMeta(draft(), null, false))).toEqual({
      ok: false,
      problem: "generic",
    });
  });

  it("list and revoke use the closed routes", async () => {
    resetTauri({
      artifacts_request: (args) =>
        args?.method === "GET" ? { status: 200, body: { artifacts: [{ id: ID }] } } : { status: 204, body: null },
    });
    expect(await listArtifacts("helmcode")).toEqual({ ok: true, items: [expect.objectContaining({ id: ID })] });
    expect(await listArtifacts("helmcode", true)).toMatchObject({ ok: true });
    expect(await revokeArtifact("helmcode", ID)).toEqual({ ok: true });
    expect(await revokeArtifact("helmcode", ID, true)).toEqual({ ok: true });
    expect(invokedWith("artifacts_request")).toEqual([
      { profileId: "helmcode", method: "GET", path: "/api/artifacts" },
      { profileId: "helmcode", method: "GET", path: "/api/admin/artifacts" },
      { profileId: "helmcode", method: "DELETE", path: `/api/artifacts/${ID}` },
      { profileId: "helmcode", method: "DELETE", path: `/api/admin/artifacts/${ID}` },
    ]);
  });

  it("revoking an already gone link counts as done; other failures do not", async () => {
    resetTauri({ artifacts_request: () => ({ status: 404, body: null }) });
    expect(await revokeArtifact("nan", ID)).toEqual({ ok: true });
    resetTauri({ artifacts_request: () => ({ status: 429, body: null }) });
    expect(await revokeArtifact("nan", ID)).toEqual({ ok: false, problem: "rate_limited" });
    resetTauri({
      artifacts_request: () => {
        throw { code: "offline" };
      },
    });
    expect(await listArtifacts("nan")).toEqual({ ok: false, problem: "offline" });
  });

  it("availability and members fail closed", async () => {
    resetTauri({ artifacts_request: () => ({ status: 401, body: null }) });
    expect(await fetchAccess("helmcode")).toEqual({ availability: "off", admin: false });
    expect(await fetchMembers("helmcode")).toBeNull();
    resetTauri({
      artifacts_request: (args) =>
        args?.path === "/api/members"
          ? { status: 200, body: { items: MEMBERS } }
          : { status: 200, body: { featureFlags: ["artifacts"] } },
    });
    expect(await fetchAccess("helmcode")).toEqual({ availability: "on", admin: false });
    expect(await fetchMembers("helmcode")).toEqual(MEMBERS);
    // Community never asks for members.
    expect(await fetchMembers("nan")).toBeNull();
    expect(invokedWith("artifacts_request").some((args) => args?.profileId === "nan")).toBe(false);
  });
});
