// Shared skills (S4): "Share with my team" and the team library, on top of
// the local skills of S1. Helmcode only: the community profile has no orgs,
// so nothing here runs (or shows) on NaN.
//
// The session JWT never leaves the Rust core, so every library call goes
// through `skills_team_request` (a closed route allowlist: /api/auth/me and
// /api/skills[/{id}]) and the core adds the Bearer. The sync DECISIONS live
// here (ETag / 304, purge, error states) and the core keeps the offline
// cache (app_data/skills-cache/<profile>/): the last list, its ETag, one
// file per cached team bundle and the local -> shared links.
//
// A team skill is text exactly like a local one: "Use" sends `team:<id>` as
// the skill id and the core injects the cached bundle as the same delimited
// block, with a "Shared by <author> (team)" provenance line.

import { invoke } from "@tauri-apps/api/core";
import type { ReferenceFile, Skill } from "./skills";

/** The only tenant with orgs (and so with a team library). */
export const TEAM_PROFILE = "helmcode";
/** What `chat_send` receives as `skill_id` for a team skill. */
export const TEAM_PREFIX = "team:";
/** Background refresh of the team library while the app runs. */
export const TEAM_SYNC_INTERVAL_MS = 15 * 60 * 1000;
/**
 * Retries after a bundle round stopped early: a rate limit (429) or an
 * expired session (401) leaves the rows listed with no cached bundle, so the
 * next sync cannot wait the full refresh interval. One minute first, then
 * five, then the normal interval.
 */
export const TEAM_RETRY_DELAYS_MS = [60 * 1000, 5 * 60 * 1000] as const;
const SKILLS_PATH = "/api/skills";
const ME_PATH = "/api/auth/me";

export type TeamStatus = "pending" | "approved" | "rejected" | "hidden";

/** One row of `GET /api/skills`. */
export type TeamMeta = {
  id: string;
  name: string;
  title: string;
  description: string;
  status: TeamStatus | string;
  featured: boolean;
  author_name: string;
  updated_at: string;
  bundle_bytes: number;
  reject_reason?: string | null;
};

/**
 * A local skill that was shared: what was sent and when. `remote_name` is
 * the slug the row was first published under (the library never renames a
 * row, so every reshare must send it); links stored before round 16 lack it.
 */
export type ShareLink = { remote_id: string; remote_name?: string; sha: string; local_updated_at: number };

/** The core's cache as it stands. `cached`: id -> the updated_at it holds. */
export type CacheView = {
  etag: string | null;
  skills: TeamMeta[];
  cached: Record<string, unknown>;
  links: Record<string, ShareLink>;
};

/** A cached team skill (View, Use, Duplicate). */
export type TeamSkill = {
  id: string;
  title: string;
  description: string;
  author_name: string;
  instructions: string;
  references: ReferenceFile[];
};

export type TeamResponse = { status: number; etag: string | null; body: unknown };

/**
 * Why the library is not (fully) usable right now:
 * - disabled: 404, the org has skills sharing off
 * - expired: 401 (or no session in the vault), the session-expired flow
 * - forbidden: 403
 * - rate_limited: 429, a gentle "wait a moment"
 * - offline: the request did not complete (the cache keeps working)
 * - invalid: the bundle failed the validator (the core's or the server's)
 * - stale: 409, the shared row changed meanwhile (hidden, no longer pending)
 * - name_taken: 409, the org already has a skill with this slug
 * - library_full: 429 skill_limit_reached, the library holds its maximum
 * - limit_reached: 429 pending_limit_reached, too many awaiting review
 * - name_mismatch: 400, the slug sent is not the row's (it never changes)
 * - generic: anything else
 */
export type TeamProblem =
  | "disabled"
  | "expired"
  | "forbidden"
  | "rate_limited"
  | "offline"
  | "invalid"
  | "stale"
  | "name_taken"
  | "library_full"
  | "limit_reached"
  | "name_mismatch"
  | "generic";

export type TeamState = { view: CacheView; problem: TeamProblem | null };

/** When to sync again: the wait and the consecutive interrupted rounds. */
export type TeamSyncPlan = { delayMs: number; failures: number };

export const EMPTY_VIEW: CacheView = { etag: null, skills: [], cached: {}, links: {} };

// ------------------------------------------------------------------ IPC --

function request(
  profileId: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown = null,
  ifNoneMatch: string | null = null,
): Promise<TeamResponse> {
  return invoke<TeamResponse>("skills_team_request", { profileId, method, path, body, ifNoneMatch });
}

export function loadCache(profileId: string): Promise<CacheView> {
  return invoke<CacheView>("skills_team_cache_load", { profileId });
}

function storeList(profileId: string, etag: string | null, skills: TeamMeta[]): Promise<CacheView> {
  return invoke<CacheView>("skills_team_cache_store_list", { profileId, etag, skills });
}

function cachePut(profileId: string, skill: WireSkill): Promise<TeamSkill> {
  return invoke<TeamSkill>("skills_team_cache_put", { profileId, skill });
}

function cacheGet(profileId: string, id: string): Promise<TeamSkill> {
  return invoke<TeamSkill>("skills_team_cache_get", { profileId, id });
}

function cacheClear(profileId: string): Promise<void> {
  return invoke<void>("skills_team_cache_clear", { profileId });
}

export function setLink(profileId: string, localId: string, link: ShareLink | null): Promise<CacheView> {
  return invoke<CacheView>("skills_team_link", { profileId, localId, link });
}

/**
 * The canonical bundle of a local skill, generated by the core. `name`
 * overrides the SKILL.md frontmatter name (a reshare sends the row's slug,
 * which a later title edit no longer matches locally); the body is the same.
 */
export function localBundle(
  id: string,
  name?: string,
): Promise<{ files: Array<{ path: string; content: string }>; sha: string }> {
  return invoke("skills_bundle", name === undefined ? { id } : { id, name });
}

// --------------------------------------------------------------- errors --

export function problemForStatus(status: number): TeamProblem | null {
  if ((status >= 200 && status < 300) || status === 304) return null;
  switch (status) {
    case 401:
      return "expired";
    case 403:
      return "forbidden";
    case 404:
      return "disabled";
    case 429:
      return "rate_limited";
    default:
      return "generic";
  }
}

/**
 * A core refusal as a problem. The core sends `{code, detail, reason?}`
 * (skills_team.rs `TeamError`); a bare string (an older core, or Tauri's
 * own argument errors) is matched by substring so it never reads generic
 * when it does say what failed.
 */
export function problemForError(err: unknown): TeamProblem {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  switch (code) {
    case "no_session":
      return "expired";
    case "offline":
    case "unavailable":
      return "offline";
    case "bundle":
      return "invalid";
    case undefined:
      break;
    default:
      return "generic";
  }
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  if (/no_?session/i.test(text)) return "expired";
  if (/offline|unavailable/i.test(text)) return "offline";
  if (/bundle|not cached/i.test(text)) return "invalid";
  return "generic";
}

/** The human detail of a failure: the core's `detail`, or the raw text. */
export function parseErrorDetail(err: unknown): string | null {
  if (typeof err === "string") return err || null;
  if (err instanceof Error) return err.message || null;
  if (err && typeof err === "object") {
    const detail = (err as { detail?: unknown }).detail;
    if (typeof detail === "string" && detail) return detail;
  }
  return null;
}

/** The validator refusal (`SkillError`-shaped) carried by a bundle error. */
function bundleReason(err: unknown): { code: string; path?: string } | null {
  if (!err || typeof err !== "object") return null;
  const { code, reason } = err as { code?: unknown; reason?: unknown };
  if (code !== "bundle" || !reason || typeof reason !== "object") return null;
  return typeof (reason as { code?: unknown }).code === "string" ? (reason as { code: string; path?: string }) : null;
}

/** Longest title the library accepts (enterprise-api `maxSkillTitleRunes`,
 * mirrored by skills_team.rs `MAX_SHARED_TITLE_CHARS`). */
export const MAX_SHARED_TITLE_CHARS = 80;

/** Why a share failed: the problem, the validator reason when there is one,
 * and the raw detail for anything the UI cannot name. */
export type ShareFailure = {
  problem: TeamProblem;
  reason: { code: string; path?: string } | null;
  detail: string | null;
};

/** enterprise-api validation codes (internal/skills/validate.go) as the
 * core's `SkillError` codes, so one localized mapping covers both. */
const SERVER_REASONS: Record<string, string> = {
  secret_detected: "secret_detected",
  file_too_large: "file_too_large",
  bundle_too_large: "bundle_too_large",
  payload_too_large: "bundle_too_large",
  too_many_files: "too_many_files",
  duplicate_path: "duplicate_file",
  invalid_path: "path_invalid",
  invalid_layout: "path_invalid",
  missing_skill_md: "path_invalid",
  invalid_extension: "extension_not_allowed",
  invalid_encoding: "not_utf8",
  invalid_description: "description_too_long",
  invalid_title: "invalid_title",
  invalid_name: "name_invalid",
};

/** A non-2xx publish reply (`{error, detail}`) as a share failure. */
export function shareFailureForReply(status: number, body: unknown): ShareFailure {
  const reply = body && typeof body === "object" ? (body as { error?: unknown; detail?: unknown }) : {};
  const code = typeof reply.error === "string" ? reply.error : "";
  const serverDetail = typeof reply.detail === "string" ? reply.detail : "";
  const detail = [`HTTP ${status}`, code, serverDetail].filter(Boolean).join(" ");
  const mapped = SERVER_REASONS[code];
  if (mapped && (status === 400 || status === 413)) {
    // The server quotes the offending path in its detail: "\"references/a.md\" ...".
    const path = /"([^"]+)"/.exec(serverDetail)?.[1] ?? (code === "missing_skill_md" ? "SKILL.md" : undefined);
    return { problem: "invalid", reason: path ? { code: mapped, path } : { code: mapped }, detail };
  }
  if (status === 400 && code === "name_mismatch") return { problem: "name_mismatch", reason: null, detail };
  if (status === 409) {
    return { problem: code === "name_taken" ? "name_taken" : "stale", reason: null, detail };
  }
  if (status === 429 && code === "skill_limit_reached") return { problem: "library_full", reason: null, detail };
  if (status === 429 && code === "pending_limit_reached") return { problem: "limit_reached", reason: null, detail };
  if (status === 400) return { problem: "invalid", reason: null, detail };
  return { problem: problemForStatus(status) ?? "generic", reason: null, detail };
}

/** A thrown core refusal as a share failure. */
export function shareFailureForError(err: unknown): ShareFailure {
  return { problem: problemForError(err), reason: bundleReason(err), detail: parseErrorDetail(err) };
}

// ----------------------------------------------------------------- flag --

/** The enterprise-api feature flag that gates the whole library. */
export const SKILLS_SHARING_FLAG = "skills_sharing";

/**
 * The org's `skills_sharing` flag from `GET /api/auth/me`. enterprise-api
 * answers `{skillsSharing: bool, featureFlags: ["skills_sharing", ...]}`
 * (handlers/auth.go Me); either one turns it on. Legacy snake_case shapes
 * (top level or under `org`, `organization`, `features`, `flags`,
 * `feature_flags`) are still accepted. Anything else is false.
 */
export function parseSkillsSharing(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const me = body as Record<string, unknown>;
  if (me.skillsSharing === true || me.skills_sharing === true) return true;
  if (Array.isArray(me.featureFlags) && me.featureFlags.includes(SKILLS_SHARING_FLAG)) return true;
  for (const key of ["org", "organization", "features", "flags", "feature_flags"]) {
    const nested = me[key];
    if (nested && typeof nested === "object" && (nested as Record<string, unknown>).skills_sharing === true) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the share action is enabled: helmcode AND the org flag on.
 * `null` when /api/auth/me could not answer (offline, expired, ...): the
 * flag is unknown, so the UI neither enables nor explains a disabled share.
 */
export async function fetchSkillsSharing(profileId: string): Promise<boolean | null> {
  if (profileId !== TEAM_PROFILE) return false;
  try {
    const res = await request(profileId, "GET", ME_PATH);
    return res.status === 200 ? parseSkillsSharing(res.body) : null;
  } catch {
    return null;
  }
}

/** The signed-in user's email (round 13: the bottom-left chip shows it).
 * Both tenants answer /api/auth/me; enterprise is flat, community may nest
 * it under a user object, and a miss simply asks the chip for its fallback. */
export async function fetchIdentity(profileId: string): Promise<{ email: string | null }> {
  try {
    const res = await request(profileId, "GET", ME_PATH);
    if (res.status !== 200 || res.body === null || typeof res.body !== "object") return { email: null };
    const body = res.body as Record<string, unknown>;
    const user = body.user as Record<string, unknown> | undefined;
    const email =
      typeof body.email === "string" && body.email
        ? body.email
        : user && typeof user.email === "string" && user.email
          ? user.email
          : null;
    return { email };
  } catch {
    return { email: null };
  }
}

// ----------------------------------------------------------------- sync --

function asMeta(value: unknown): TeamMeta | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  const text = (key: string): string => (typeof row[key] === "string" ? (row[key] as string) : "");
  return {
    id: row.id,
    name: text("name"),
    title: text("title") || text("name"),
    description: text("description"),
    status: text("status"),
    featured: row.featured === true,
    author_name: text("author_name"),
    updated_at: text("updated_at"),
    bundle_bytes: typeof row.bundle_bytes === "number" ? row.bundle_bytes : 0,
    reject_reason: typeof row.reject_reason === "string" ? row.reject_reason : null,
  };
}

/** `{skills: [...], etag}`; `null` for a body of another shape. */
export function parseList(body: unknown): { skills: TeamMeta[]; etag: string | null } | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { skills?: unknown }).skills)) return null;
  const raw = body as { skills: unknown[]; etag?: unknown };
  return {
    skills: raw.skills.map(asMeta).filter((meta): meta is TeamMeta => meta !== null),
    etag: typeof raw.etag === "string" ? raw.etag : null,
  };
}

function sameVersion(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether the cache holds the row's current bundle (Use needs it on disk). */
export function isBundleCached(view: CacheView, meta: TeamMeta): boolean {
  return meta.id in view.cached && sameVersion(view.cached[meta.id], meta.updated_at);
}

/** Approved rows whose bundle is missing from the cache or outdated. */
export function bundlesToFetch(view: CacheView): TeamMeta[] {
  return view.skills.filter((meta) => meta.status === "approved" && !isBundleCached(view, meta));
}

/**
 * The wait before the next sync. A round that stored a list but stopped
 * before caching every bundle (`rate_limited` / `expired`) retries in 60s
 * and then 5 minutes, so the composer picker fills as soon as the limit
 * passes; after that, and after any round that completed, it waits the
 * normal refresh interval and the counter starts over.
 */
export function planNextSync(problem: TeamProblem | null, failures: number): TeamSyncPlan {
  const interrupted = problem === "rate_limited" || problem === "expired";
  if (!interrupted) return { delayMs: TEAM_SYNC_INTERVAL_MS, failures: 0 };
  const count = failures + 1;
  const retry = count <= TEAM_RETRY_DELAYS_MS.length ? TEAM_RETRY_DELAYS_MS[count - 1] : null;
  return { delayMs: retry ?? TEAM_SYNC_INTERVAL_MS, failures: count };
}

/** The bundle version the sync serves: only what an admin approved. */
export const APPROVED_VERSION = "approved";

/** `GET /api/skills/{id}?version=approved`: the one bundle request. */
export function bundlePath(id: string): string {
  return `${SKILLS_PATH}/${encodeURIComponent(id)}?version=${APPROVED_VERSION}`;
}

/** What `skills_team_cache_put` receives: the row plus its bundle files. */
export type WireSkill = TeamMeta & { files: Array<{ path: string; content: string }> };

function isWireFile(value: unknown): value is { path: string; content: string } {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return typeof file.path === "string" && typeof file.content === "string";
}

/**
 * The single-skill reply of enterprise-api (`handlers/skills.go` Get):
 * `{skill, version, sha256, bundle: {files: [{path, content}]}}`. The
 * metadata (`skill`) never carries the files; the bundle only comes with an
 * explicit `?version=`, and `version`/`sha256`/`bundle` are null otherwise.
 * Anything but an approved bundle with its hash is `null` (never cached).
 * The hash is part of the contract (a reply without it is refused) but the
 * caller has no use for its value, so only the skill is returned.
 */
export function parseBundleResponse(body: unknown): WireSkill | null {
  if (!body || typeof body !== "object") return null;
  const reply = body as Record<string, unknown>;
  const meta = asMeta(reply.skill);
  if (!meta || reply.version !== APPROVED_VERSION) return null;
  if (typeof reply.sha256 !== "string" || !reply.sha256) return null;
  const bundle = reply.bundle;
  if (!bundle || typeof bundle !== "object") return null;
  const files = (bundle as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0 || !files.every(isWireFile)) return null;
  return { ...meta, files: files.map(({ path, content }) => ({ path, content })) };
}

/** Fetch and cache one approved bundle. */
async function fetchBundle(profileId: string, id: string): Promise<{ skill: TeamSkill } | { problem: TeamProblem }> {
  let res: TeamResponse;
  try {
    res = await request(profileId, "GET", bundlePath(id));
  } catch (err) {
    return { problem: problemForError(err) };
  }
  const problem = problemForStatus(res.status);
  if (problem) return { problem };
  // A reply without the bundle is a contract problem, never a silent skip:
  // the row stays "Preparing" and the banner says the library failed.
  const wire = parseBundleResponse(res.body);
  if (!wire || wire.id !== id) return { problem: "invalid" };
  try {
    return { skill: await cachePut(profileId, wire) };
  } catch (err) {
    return { problem: problemForError(err) };
  }
}

/**
 * One sync of the team library: `GET /api/skills` with the stored ETag.
 * 304 keeps the cache; 200 stores the list (the core purges every bundle no
 * longer listed as approved: revocation is effective) and fetches the
 * missing or outdated approved bundles so "Use" works offline. 404 (the org
 * turned sharing off) clears the cache. Other failures keep the cache.
 */
export async function syncTeam(profileId: string): Promise<TeamState> {
  let view = await loadCache(profileId);
  let res: TeamResponse;
  try {
    res = await request(profileId, "GET", SKILLS_PATH, null, view.etag);
  } catch (err) {
    return { view, problem: problemForError(err) };
  }
  if (res.status === 404) {
    await cacheClear(profileId);
    return { view: await loadCache(profileId), problem: "disabled" };
  }
  if (res.status === 200) {
    const list = parseList(res.body);
    if (!list) return { view, problem: "generic" };
    view = await storeList(profileId, res.etag ?? list.etag, list.skills);
  } else if (res.status !== 304) {
    return { view, problem: problemForStatus(res.status) };
  }
  let problem: TeamProblem | null = null;
  for (const meta of bundlesToFetch(view)) {
    const fetched = await fetchBundle(profileId, meta.id);
    if ("problem" in fetched) {
      // A rate limit or an expired session stops the round; a single bad
      // bundle does not stop it.
      if (fetched.problem === "rate_limited" || fetched.problem === "expired") {
        problem = fetched.problem;
        break;
      }
      // The others still report (the first one wins) so a missing bundle is
      // never silent: the row keeps "Preparing" and the banner explains.
      problem = problem ?? fetched.problem;
      continue;
    }
    view = { ...view, cached: { ...view.cached, [meta.id]: meta.updated_at } };
  }
  return { view, problem };
}

/** A team skill for View / Use / Duplicate: the cache, else a fetch. */
export async function loadTeamSkill(
  profileId: string,
  id: string,
): Promise<{ skill: TeamSkill } | { problem: TeamProblem }> {
  try {
    return { skill: await cacheGet(profileId, id) };
  } catch {
    return fetchBundle(profileId, id);
  }
}

// ---------------------------------------------------------------- share --

export type ShareResult =
  | { ok: true; meta: TeamMeta; view: CacheView }
  | ({ ok: false } & ShareFailure);

/**
 * "Share with my team" (POST) or "Share again" (PUT, back to pending): the
 * core builds the canonical bundle {files:[SKILL.md, references...]} with
 * the SAME generator as every local save; this sends it with the skill's
 * slug and title (enterprise-api's publish contract is `{name, title,
 * files}`) and records the link. A PUT on a row the admin deleted (404)
 * falls back to a new POST; a POST 404 means the org has sharing off.
 * A failure carries what went wrong (round 16), never just "generic".
 *
 * A reshare sends the row's slug (`remoteNameFor`), not the local one: a
 * title edit renames the local slug, and enterprise-api refuses any other
 * name for an existing row (400 name_mismatch). `rows` is the cached list,
 * the fallback for links stored before `remote_name` existed.
 */
export async function shareSkill(
  profileId: string,
  skill: Skill,
  link: ShareLink | null,
  rows: TeamMeta[] = [],
): Promise<ShareResult> {
  const name = link ? remoteNameFor(link, rows, skill) : skill.name;
  let bundle: Awaited<ReturnType<typeof localBundle>>;
  try {
    bundle = await localBundle(skill.id, link ? name : undefined);
  } catch (err) {
    // The core refused to build the bundle (skills_bundle re-validates a
    // record saved before a rule landed): a `SkillError` `{code, path?}`.
    const reason = err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
      ? (err as { code: string; path?: string })
      : null;
    return { ok: false, problem: reason ? "invalid" : "generic", reason, detail: parseErrorDetail(err) };
  }
  try {
    const body = { name, title: skill.title, files: bundle.files };
    let res = link
      ? await request(profileId, "PUT", `${SKILLS_PATH}/${encodeURIComponent(link.remote_id)}`, body)
      : await request(profileId, "POST", SKILLS_PATH, body);
    if (link && res.status === 404) res = await request(profileId, "POST", SKILLS_PATH, body);
    if (problemForStatus(res.status)) return { ok: false, ...shareFailureForReply(res.status, res.body) };
    const meta = asMeta(res.body && typeof res.body === "object" ? (res.body as { skill?: unknown }).skill : null);
    if (!meta) return { ok: false, problem: "generic", reason: null, detail: `HTTP ${res.status} unexpected reply` };
    const view = await setLink(profileId, skill.id, {
      remote_id: meta.id,
      remote_name: name,
      sha: bundle.sha,
      local_updated_at: skill.updated_at,
    });
    return { ok: true, meta, view: withRow(view, meta) };
  } catch (err) {
    return { ok: false, ...shareFailureForError(err) };
  }
}

/**
 * The slug a reshare must send: the one stored at the first share; for a
 * link stored before that existed, the cached row's name (the library's
 * truth; the remote id is a UUID, never a slug); the local slug last.
 */
export function remoteNameFor(link: ShareLink, rows: TeamMeta[], skill: Skill): string {
  if (link.remote_name) return link.remote_name;
  const row = rows.find((meta) => meta.id === link.remote_id);
  return row?.name || skill.name;
}

/** The view with `meta` replacing (or added as) its row. */
export function withRow(view: CacheView, meta: TeamMeta): CacheView {
  const exists = view.skills.some((row) => row.id === meta.id);
  return {
    ...view,
    skills: exists ? view.skills.map((row) => (row.id === meta.id ? meta : row)) : [...view.skills, meta],
  };
}

// ---------------------------------------------------- what the UI shows --

export type ShareState =
  | { kind: "local" }
  | { kind: "pending" | "approved" | "rejected" | "hidden"; edited: boolean; reason: string | null };

/** The share state of a local skill: local, in review, shared, not approved. */
export function shareStateFor(skill: Skill, view: CacheView): ShareState {
  const link = view.links[skill.id];
  if (!link) return { kind: "local" };
  const row = view.skills.find((meta) => meta.id === link.remote_id);
  if (!row) return { kind: "local" };
  const kind = row.status === "approved" || row.status === "rejected" || row.status === "hidden" ? row.status : "pending";
  return { kind, edited: skill.updated_at > link.local_updated_at, reason: row.reject_reason ?? null };
}

/** The team library: approved rows, featured first (server order kept). */
export function teamLibrary(view: CacheView): TeamMeta[] {
  const approved = view.skills.filter((meta) => meta.status === "approved");
  return [...approved.filter((meta) => meta.featured), ...approved.filter((meta) => !meta.featured)];
}

/** Cached team skills as activatable entries for the pill and the picker. */
export function usableTeamSkills(view: CacheView): Skill[] {
  return teamLibrary(view)
    .filter((meta) => meta.id in view.cached)
    .map((meta) => teamAsSkill(meta));
}

export function teamAsSkill(meta: TeamMeta): Skill {
  return {
    id: `${TEAM_PREFIX}${meta.id}`,
    name: meta.name,
    title: meta.title,
    description: meta.description,
    instructions: "",
    references: [],
    created_at: 0,
    updated_at: 0,
  };
}

export function isTeamSkillId(id: string): boolean {
  return id.startsWith(TEAM_PREFIX);
}
