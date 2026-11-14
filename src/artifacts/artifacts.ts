// Shared artifacts (F2 of the artifacts design): a link to ONE immutable
// snapshot of a file a chat produced (or any granted file in the preview).
//
// The session JWT and the file bytes never reach the renderer: the core
// reads the file itself (grant-checked, 8 MiB, type sniff, credential
// pre-scan) and uploads it (`artifact_share`), and every list/revoke call
// goes through a closed route allowlist (`artifacts_request`). What lives
// here are the DECISIONS, pure and unit-tested: which scopes a profile
// offers, when the risk warning shows and when its acceptance resets, the
// expiry options, the email parsing, the tolerant reply parsing and the
// error -> copy mapping.

import { invoke } from "@tauri-apps/api/core";
import { extensionOf, type PreviewTarget } from "../preview/kind";

/** The only tenant with orgs (members and org scopes, the admin list). */
export const ENTERPRISE_PROFILE = "helmcode";
/** The risk copy version the user accepts (design 3.4). A wording change
 *  that changes the meaning bumps it, together with the i18n key. */
export const RISK_VERSION = "artifacts-risk-v1";
/** Most email recipients per share. */
export const MAX_RECIPIENTS = 20;
/** Longest title (runes). */
export const MAX_TITLE_CHARS = 120;
/** Largest file (the preview cap, so anything previewable is shareable). */
export const MAX_ARTIFACT_MB = 8;

const ARTIFACTS_PATH = "/api/artifacts";
const ADMIN_ARTIFACTS_PATH = "/api/admin/artifacts";
const MEMBERS_PATH = "/api/members";
const ME_PATH = "/api/auth/me";
/** The enterprise flag names accepted from `/api/auth/me`: the design's
 *  `artifacts` and the `artifacts_sharing` spelling (tolerant client). */
export const ARTIFACTS_FLAGS = ["artifacts", "artifacts_sharing"] as const;

export type ShareScope = "emails" | "members" | "org" | "public";
export type RiskKind = "public" | "external";

/** What needs an explicit acceptance: the kind and, for external, which
 *  recipients made it external (an added one resets the acceptance). */
export type Risk = { kind: RiskKind; external: string[] };

/** What the core reads: a granted file, or an image this app generated. */
export type ShareSource = { kind: "file" | "media"; path: string };

/** One org member (`GET /api/members`). */
export type Member = { userId: string; email: string };

/** Whether the share action shows, and what it opens:
 *  - on: the dialog
 *  - paywall: community member without the capability (the paywall copy)
 *  - off: hidden (flag off, unknown, or not deployed for this tenant) */
export type Availability = "on" | "paywall" | "off";

export type ArtifactsAccess = { availability: Availability; admin: boolean };

/** One link as the list and the create reply describe it (tolerant). */
export type SharedArtifact = {
  id: string;
  title: string;
  filename: string;
  contentType: string;
  size: number;
  scope: ShareScope | string;
  recipientCount: number;
  expiresAt: string | null;
  createdAt: string | null;
  revokedAt: string | null;
  viewCount: number;
  url: string | null;
  owner: string | null;
};

export type LinkState = "active" | "expired" | "revoked";

/**
 * Why a share, list or revoke did not work (each has its own copy):
 * server codes from wire contract 8.1 plus the core's own refusals.
 */
export type ArtifactProblem =
  | "too_large"
  | "unsupported_type"
  | "empty"
  | "quota_exceeded"
  | "risk_ack_required"
  | "possible_secret"
  | "scope_not_allowed"
  | "recipient_not_member"
  | "too_many_recipients"
  | "invalid"
  | "source_refused"
  | "paywall"
  | "expired"
  | "forbidden"
  | "disabled"
  | "rate_limited"
  | "offline"
  | "generic";

// ------------------------------------------------------------- scopes --

/** The scopes the dialog offers (design 2): the backend stays the judge. */
export function scopeOptions(profileId: string): ShareScope[] {
  return profileId === ENTERPRISE_PROFILE ? ["emails", "members", "org", "public"] : ["emails", "public"];
}

/** Expiry options per scope in days; `null` is "no expiry" (design 3.5). */
export function expiryOptions(scope: ShareScope): Array<number | null> {
  switch (scope) {
    case "public":
      return [1, 7, 30];
    case "emails":
      return [1, 7, 30, 90];
    default:
      return [7, 30, 90, null];
  }
}

export function defaultExpiry(scope: ShareScope): number | null {
  return scope === "public" ? 7 : scope === "emails" ? 30 : 90;
}

/** Keep the chosen expiry when the new scope offers it, else its default. */
export function expiryFor(scope: ShareScope, current: number | null): number | null {
  return expiryOptions(scope).includes(current) ? current : defaultExpiry(scope);
}

// -------------------------------------------------------------- emails --

/** RFC-lite, the same rules as the core (`artifacts::is_valid_email`). */
export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254 || !/^[\x21-\x7e]+$/.test(email)) return false;
  if (/[<>()[\],;:\\"]/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || email.indexOf("@", at + 1) !== -1) return false;
  const labels = email.slice(at + 1).split(".");
  return labels.length >= 2 && labels.every((label) => /^[A-Za-z0-9-]+$/.test(label));
}

/** Split pasted text on commas, semicolons and whitespace; lowercase. */
export function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Add the addresses in `text` to `current`: valid ones are appended once
 * (deduplicated) up to [`MAX_RECIPIENTS`]; `invalid` keeps what could not be
 * read (so the input can keep it for correction), `overflow` counts what
 * did not fit.
 */
export function addEmails(
  current: string[],
  text: string,
): { emails: string[]; invalid: string[]; overflow: number } {
  const emails = [...current];
  const invalid: string[] = [];
  let overflow = 0;
  for (const email of splitEmails(text)) {
    if (!isValidEmail(email)) invalid.push(email);
    else if (emails.includes(email)) continue;
    else if (emails.length >= MAX_RECIPIENTS) overflow += 1;
    else emails.push(email);
  }
  return { emails, invalid, overflow };
}

// ---------------------------------------------------------------- risk --

/**
 * The recipients outside the org, for the warning and the "External"
 * badge. Community: everyone (there is no org). Enterprise: the ones that
 * are not in the cached members list; with no list (it failed to load),
 * everyone counts as external, which only ever shows MORE warning. The
 * server recomputes this and answers 422 if it disagrees.
 */
export function externalEmails(profileId: string, emails: string[], members: Member[] | null): string[] {
  if (profileId !== ENTERPRISE_PROFILE || members === null) return [...emails];
  const internal = new Set(members.map((member) => member.email.toLowerCase()));
  return emails.filter((email) => !internal.has(email));
}

/** What the share needs accepted, or null (design 3.4). */
export function riskFor(
  profileId: string,
  scope: ShareScope,
  emails: string[],
  members: Member[] | null,
): Risk | null {
  if (scope === "public") return { kind: "public", external: [] };
  if (scope !== "emails") return null;
  const external = externalEmails(profileId, emails, members);
  return external.length > 0 ? { kind: "external", external } : null;
}

/**
 * Whether an acceptance given for `acked` still covers `current`. The
 * checkbox resets whenever the risk set grows: a different kind (switching
 * to public) or an external recipient that was not there when it was
 * checked. Removing recipients keeps it.
 */
export function ackCovers(acked: Risk | null, current: Risk | null): boolean {
  if (current === null) return true;
  if (acked === null || acked.kind !== current.kind) return false;
  return current.external.every((email) => acked.external.includes(email));
}

// -------------------------------------------------------------- source --

const SHAREABLE_EXTENSIONS = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "gif", "md", "markdown", "txt", "csv", "html", "htm", "docx", "xlsx",
]);

/** A preview target that can be shared (design 1.1 allowlist). Web pages
 *  never are; generated images always are. */
export function shareSourceFor(target: PreviewTarget): ShareSource | null {
  if (target.kind === "media") return { kind: "media", path: target.ref };
  if (target.kind === "file" && SHAREABLE_EXTENSIONS.has(extensionOf(target.ref))) {
    return { kind: "file", path: target.ref };
  }
  return null;
}

// ---------------------------------------------------------------- meta --

export type ShareDraft = {
  title: string;
  scope: ShareScope;
  emails: string[];
  memberIds: string[];
  expiresDays: number | null;
  notify: boolean;
};

/** The `meta` part of `POST /api/artifacts` (wire contract 8.1). */
export type WireMeta = {
  title: string;
  scope: ShareScope;
  emails: string[];
  member_ids: string[];
  expires_days: number | null;
  notify: boolean;
  risk_ack?: { kind: RiskKind; version: string };
  secret_ack?: boolean;
};

/** Whether the confirm button may enable (design 5.2). */
export function canSubmit(draft: ShareDraft, risk: Risk | null, acked: boolean, busy: boolean): boolean {
  if (busy) return false;
  if ([...draft.title.trim()].length > MAX_TITLE_CHARS) return false;
  if (draft.scope === "emails" && draft.emails.length === 0) return false;
  if (draft.scope === "members" && draft.memberIds.length === 0) return false;
  if (risk !== null && !acked) return false;
  return true;
}

/** The wire meta for a draft: only the recipients of the chosen scope,
 *  the acceptance only when a risk was shown and accepted. */
export function buildMeta(draft: ShareDraft, risk: Risk | null, secretAck: boolean): WireMeta {
  const meta: WireMeta = {
    title: draft.title.trim(),
    scope: draft.scope,
    emails: draft.scope === "emails" ? draft.emails : [],
    member_ids: draft.scope === "members" ? draft.memberIds : [],
    expires_days: expiryFor(draft.scope, draft.expiresDays),
    notify: (draft.scope === "emails" || draft.scope === "members") && draft.notify,
  };
  if (risk) meta.risk_ack = { kind: risk.kind, version: RISK_VERSION };
  if (secretAck) meta.secret_ack = true;
  return meta;
}

// ----------------------------------------------------- reply parsing --

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  return undefined;
}

/** Only an https link is ever shown, copied or opened. */
export function safeLink(value: unknown): string | null {
  const url = str(value);
  if (!url || url.length > 2048) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The admin list's owner: a name/email string or `{name, email}`. */
function ownerOf(value: unknown): string | null {
  if (typeof value === "string") return str(value);
  if (!value || typeof value !== "object") return null;
  const owner = value as Record<string, unknown>;
  return str(owner.name) ?? str(owner.email);
}

/** One artifact row (snake_case per the design; camelCase tolerated). */
export function parseArtifact(raw: unknown, url?: unknown): SharedArtifact | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!id) return null;
  const owner = ownerOf(pick(row, "owner_name", "ownerName", "owner_email", "ownerEmail", "owner"));
  return {
    id,
    title: str(row.title) ?? str(row.filename) ?? "",
    filename: str(pick(row, "filename", "file_name", "fileName")) ?? "",
    contentType: str(pick(row, "content_type", "contentType")) ?? "",
    size: num(row.size),
    scope: str(row.scope) ?? "",
    recipientCount: num(pick(row, "recipient_count", "recipientCount")),
    expiresAt: str(pick(row, "expires_at", "expiresAt")),
    createdAt: str(pick(row, "created_at", "createdAt")),
    revokedAt: str(pick(row, "revoked_at", "revokedAt")),
    viewCount: num(pick(row, "view_count", "viewCount")),
    url: safeLink(url ?? row.url),
    owner,
  };
}

/** `201 {artifact, url}`: the link must be https or the share is unusable. */
export function parseShareReply(body: unknown): { artifact: SharedArtifact | null; url: string } | null {
  if (!body || typeof body !== "object") return null;
  const reply = body as Record<string, unknown>;
  const url = safeLink(reply.url ?? (reply.artifact as Record<string, unknown> | undefined)?.url);
  if (!url) return null;
  return { artifact: parseArtifact(reply.artifact, url), url };
}

/** `GET /api/artifacts` (or the admin list): `{artifacts: []}`, `{items: []}`
 *  or a bare array; unreadable rows are skipped. */
export function parseArtifactList(body: unknown): SharedArtifact[] {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((body as Record<string, unknown>).artifacts ?? (body as Record<string, unknown>).items)
      : null;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => parseArtifact(row)).filter((row): row is SharedArtifact => row !== null);
}

/** `GET /api/members`: enterprise answers `{items: [{userId, email}]}`. */
export function parseMembers(body: unknown): Member[] | null {
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object"
      ? ((body as Record<string, unknown>).items ?? (body as Record<string, unknown>).members)
      : null;
  if (!Array.isArray(rows)) return null;
  const members: Member[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const userId = str(pick(row, "userId", "user_id", "id"));
    const email = str(row.email);
    if (userId && email) members.push({ userId, email: email.toLowerCase() });
  }
  return members;
}

export function linkState(artifact: SharedArtifact, now = Date.now()): LinkState {
  if (artifact.revokedAt) return "revoked";
  if (artifact.expiresAt) {
    const at = Date.parse(artifact.expiresAt);
    if (!Number.isNaN(at) && at <= now) return "expired";
  }
  return "active";
}

// ------------------------------------------------------ availability --

function hasFlag(me: Record<string, unknown>): boolean {
  for (const flag of ARTIFACTS_FLAGS) {
    if (me[flag] === true) return true;
  }
  if (me.artifactsSharing === true) return true;
  if (Array.isArray(me.featureFlags) && ARTIFACTS_FLAGS.some((flag) => (me.featureFlags as unknown[]).includes(flag))) {
    return true;
  }
  for (const key of ["org", "organization", "features", "flags", "feature_flags"]) {
    const nested = me[key];
    if (Array.isArray(nested) && ARTIFACTS_FLAGS.some((flag) => nested.includes(flag))) return true;
    if (nested && typeof nested === "object" && ARTIFACTS_FLAGS.some((flag) => (nested as Record<string, unknown>)[flag] === true)) {
      return true;
    }
  }
  return false;
}

function capabilitiesOf(me: Record<string, unknown>): unknown {
  if (me.capabilities !== undefined) return me.capabilities;
  const user = me.user;
  return user && typeof user === "object" ? (user as Record<string, unknown>).capabilities : undefined;
}

/**
 * The share action's availability from `/api/auth/me` (design 2 / 5.1).
 * Enterprise: the org flag on, else hidden. Community: `capabilities`
 * holding `artifacts` turns it on; a capabilities object without it shows
 * the paywall copy; no capabilities at all means the tenant does not offer
 * artifacts yet, so it stays hidden.
 */
export function parseAccess(profileId: string, body: unknown): ArtifactsAccess {
  if (!body || typeof body !== "object") return { availability: "off", admin: false };
  const me = body as Record<string, unknown>;
  if (profileId === ENTERPRISE_PROFILE) {
    const org = me.org && typeof me.org === "object" ? (me.org as Record<string, unknown>) : {};
    const admin = me.role === "admin" || org.role === "admin";
    return { availability: hasFlag(me) ? "on" : "off", admin };
  }
  const caps = capabilitiesOf(me);
  if (Array.isArray(caps)) return { availability: caps.includes("artifacts") ? "on" : "paywall", admin: false };
  if (caps && typeof caps === "object") {
    return { availability: (caps as Record<string, unknown>).artifacts === true ? "on" : "paywall", admin: false };
  }
  return { availability: "off", admin: false };
}

// ------------------------------------------------------------ errors --

function serverCode(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const reply = body as Record<string, unknown>;
  for (const candidate of [reply.error, reply.code, (reply.problem as Record<string, unknown> | undefined)?.code]) {
    if (typeof candidate === "string") return candidate;
  }
  const nested = reply.error;
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).code === "string") {
    return (nested as Record<string, unknown>).code as string;
  }
  return "";
}

const SERVER_CODES: Record<string, ArtifactProblem> = {
  too_large: "too_large",
  unsupported_type: "unsupported_type",
  quota_exceeded: "quota_exceeded",
  risk_ack_required: "risk_ack_required",
  possible_secret: "possible_secret",
  scope_not_allowed: "scope_not_allowed",
  recipient_not_member: "recipient_not_member",
  too_many_recipients: "too_many_recipients",
  invalid_request: "invalid",
  entitlement_required: "paywall",
  rate_limited: "rate_limited",
};

/** A server reply as a problem, or null when it succeeded. */
export function problemForReply(status: number, body: unknown): ArtifactProblem | null {
  if (status >= 200 && status < 300) return null;
  const mapped = SERVER_CODES[serverCode(body)];
  if (mapped) return mapped;
  switch (status) {
    case 400:
      return "invalid";
    case 401:
      return "expired";
    case 403:
      return "forbidden";
    case 404:
      return "disabled";
    case 409:
      return "quota_exceeded";
    case 413:
      return "too_large";
    case 415:
      return "unsupported_type";
    case 429:
      return "rate_limited";
    default:
      return "generic";
  }
}

const CORE_CODES: Record<string, ArtifactProblem> = {
  no_session: "expired",
  offline: "offline",
  unavailable: "offline",
  too_large: "too_large",
  unsupported_type: "unsupported_type",
  empty: "empty",
  possible_secret: "possible_secret",
  risk_ack_required: "risk_ack_required",
  source_refused: "source_refused",
  request_invalid: "invalid",
};

/** A thrown core refusal (`{code, detail}`) as a problem. */
export function problemForError(err: unknown): ArtifactProblem {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return (typeof code === "string" && CORE_CODES[code]) || "generic";
}

// ---------------------------------------------------------------- IPC --

type CoreReply = { status: number; body: unknown };

function request(profileId: string, method: "GET" | "DELETE", path: string): Promise<CoreReply> {
  return invoke<CoreReply>("artifacts_request", { profileId, method, path });
}

export type Outcome<T> = ({ ok: true } & T) | { ok: false; problem: ArtifactProblem };

/** The share action's availability for the active profile. */
export async function fetchAccess(profileId: string): Promise<ArtifactsAccess> {
  try {
    const reply = await request(profileId, "GET", ME_PATH);
    return reply.status === 200 ? parseAccess(profileId, reply.body) : { availability: "off", admin: false };
  } catch {
    return { availability: "off", admin: false };
  }
}

/** Upload the snapshot (the core reads the file) and return the link. */
export async function shareArtifact(
  profileId: string,
  source: ShareSource,
  meta: WireMeta,
): Promise<Outcome<{ url: string; artifact: SharedArtifact | null }>> {
  try {
    const reply = await invoke<CoreReply>("artifact_share", { profileId, source, meta });
    const problem = problemForReply(reply.status, reply.body);
    if (problem) return { ok: false, problem };
    const parsed = parseShareReply(reply.body);
    return parsed ? { ok: true, ...parsed } : { ok: false, problem: "generic" };
  } catch (err) {
    return { ok: false, problem: problemForError(err) };
  }
}

/** My links (or, for an org admin, the whole org's). */
export async function listArtifacts(
  profileId: string,
  admin = false,
): Promise<Outcome<{ items: SharedArtifact[] }>> {
  try {
    const reply = await request(profileId, "GET", admin ? ADMIN_ARTIFACTS_PATH : ARTIFACTS_PATH);
    const problem = problemForReply(reply.status, reply.body);
    return problem ? { ok: false, problem } : { ok: true, items: parseArtifactList(reply.body) };
  } catch (err) {
    return { ok: false, problem: problemForError(err) };
  }
}

/** Revoke a link. A 404 means it is already gone, which is the goal. */
export async function revokeArtifact(profileId: string, id: string, admin = false): Promise<Outcome<object>> {
  try {
    const reply = await request(profileId, "DELETE", `${admin ? ADMIN_ARTIFACTS_PATH : ARTIFACTS_PATH}/${id}`);
    if (reply.status === 404) return { ok: true };
    const problem = problemForReply(reply.status, reply.body);
    return problem ? { ok: false, problem } : { ok: true };
  } catch (err) {
    return { ok: false, problem: problemForError(err) };
  }
}

/** The org members (enterprise), or null when the list is unavailable. */
export async function fetchMembers(profileId: string): Promise<Member[] | null> {
  if (profileId !== ENTERPRISE_PROFILE) return null;
  try {
    const reply = await request(profileId, "GET", MEMBERS_PATH);
    return reply.status === 200 ? parseMembers(reply.body) : null;
  } catch {
    return null;
  }
}
