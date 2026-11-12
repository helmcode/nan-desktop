// A fake core for the shared-skills commands (S4), used with tauriMock:
// `skills_team_request` is answered by a per-test API route table (the
// "fetch mock" of /api/auth/me and /api/skills), and the cache commands
// mirror the Rust cache semantics (skills_team.rs): storing a list purges
// every cached bundle no longer listed as approved, a bundle can only be
// cached or read while listed as approved, clearing keeps the links.

import type { Skill } from "../skills/skills";
import type { CacheView, ShareLink, TeamMeta, TeamSkill } from "../skills/team";

export type ApiRequest = {
  method: string;
  path: string;
  body: unknown;
  ifNoneMatch: string | null;
};

/** A reply, or `{ fail: code }` for a request that did not complete. */
export type ApiReply = { status: number; etag?: string | null; body?: unknown } | { fail: string };

export type ApiRoute = (req: ApiRequest) => ApiReply;

type Args = Record<string, unknown> | undefined;

export function meta(id: string, patch: Partial<TeamMeta> = {}): TeamMeta {
  return {
    id,
    name: id.replace(/[^a-z0-9-]/g, "-"),
    title: `Title ${id}`,
    description: `Description ${id}`,
    status: "approved",
    featured: false,
    author_name: "Ana",
    updated_at: "2026-11-01T10:00:00Z",
    bundle_bytes: 100,
    reject_reason: null,
    ...patch,
  };
}

export function skillMd(name: string, description: string, instructions: string): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`;
}

/** The bundle files of a row (SKILL.md + one reference). */
export function bundleFiles(row: TeamMeta, instructions = `Instructions of ${row.id}`) {
  return [
    { path: "SKILL.md", content: skillMd(row.name, row.description, instructions) },
    { path: "references/notes.md", content: "Notes" },
  ];
}

/** `/api/skills/{id}?version=approved` -> `{id, query}`; `null` off the item route. */
export function skillRoute(path: string): { id: string; query: string } | null {
  if (!path.startsWith("/api/skills/")) return null;
  const [id, query = ""] = path.slice("/api/skills/".length).split("?");
  return { id, query };
}

/**
 * `GET /api/skills/{id}` exactly as enterprise-api answers it
 * (handlers/skills.go Get): `skill` is metadata only; the bundle comes
 * under `bundle: {files}` with its `version` and `sha256`, and only with an
 * explicit `?version=approved` here (the default branch is not relied on).
 */
export function wireSkill(row: TeamMeta, instructions = `Instructions of ${row.id}`, query = "version=approved") {
  if (query !== "version=approved") return { skill: { ...row }, version: null, sha256: null, bundle: null };
  return {
    skill: { ...row },
    version: "approved",
    sha256: `sha256-${row.id}`,
    bundle: { files: bundleFiles(row, instructions) },
  };
}

/** The canonical bundle the core generates for a local skill. */
export function localBundleOf(skill: Skill) {
  return {
    files: [
      { path: "SKILL.md", content: skillMd(skill.name, skill.description, skill.instructions) },
      ...[...skill.references]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((r) => ({ path: `references/${r.name}`, content: r.content })),
    ],
    sha: `sha-${skill.id}-${skill.updated_at}`,
  };
}

function body(md: string): string {
  const end = md.indexOf("\n---\n", 4);
  return md.slice(end + 5).trim();
}

export function fakeTeamCore(api: ApiRoute, localSkills: () => Skill[] = () => []) {
  const state = {
    etag: null as string | null,
    skills: [] as TeamMeta[],
    cached: {} as Record<string, unknown>,
    bundles: {} as Record<string, TeamSkill>,
    links: {} as Record<string, ShareLink>,
  };
  const requests: ApiRequest[] = [];
  const calls: string[] = [];

  const view = (): CacheView => ({
    etag: state.etag,
    skills: state.skills.map((row) => ({ ...row })),
    cached: { ...state.cached },
    links: { ...state.links },
  });
  const approved = (id: string) => state.skills.find((row) => row.id === id && row.status === "approved");

  const handlers = {
    skills_team_request: (args: Args) => {
      const req: ApiRequest = {
        method: String(args?.method),
        path: String(args?.path),
        body: args?.body ?? null,
        ifNoneMatch: (args?.ifNoneMatch as string | null) ?? null,
      };
      requests.push(req);
      const reply = api(req);
      if ("fail" in reply) throw { code: reply.fail };
      return { status: reply.status, etag: reply.etag ?? null, body: reply.body ?? null };
    },
    skills_team_cache_load: () => {
      calls.push("load");
      return view();
    },
    skills_team_cache_store_list: (args: Args) => {
      calls.push("store_list");
      state.etag = (args?.etag as string | null) ?? null;
      state.skills = (args?.skills as TeamMeta[]).map((row) => ({ ...row }));
      for (const id of Object.keys(state.cached)) {
        if (!approved(id)) {
          delete state.cached[id];
          delete state.bundles[id];
        }
      }
      return view();
    },
    skills_team_cache_put: (args: Args) => {
      calls.push("put");
      const wire = args?.skill as TeamMeta & { files?: Array<{ path: string; content: string }> };
      // Rust deserializes a WireSkill: no `files` is an argument error.
      if (!Array.isArray(wire?.files)) throw "invalid args `skill` for command `skills_team_cache_put`: missing field `files`";
      const listed = approved(wire.id);
      if (!listed) throw { code: "not_found" };
      const md = wire.files.find((f) => f.path === "SKILL.md")?.content ?? "";
      const skill: TeamSkill = {
        id: wire.id,
        title: listed.title,
        description: listed.description,
        author_name: listed.author_name,
        instructions: body(md),
        references: wire.files
          .filter((f) => f.path.startsWith("references/"))
          .map((f) => ({ name: f.path.slice("references/".length), content: f.content })),
      };
      state.bundles[wire.id] = skill;
      state.cached[wire.id] = listed.updated_at;
      return skill;
    },
    skills_team_cache_get: (args: Args) => {
      const id = String(args?.id);
      if (!approved(id) || !state.bundles[id]) throw { code: "not_found" };
      return state.bundles[id];
    },
    skills_team_cache_clear: () => {
      calls.push("clear");
      state.etag = null;
      state.skills = [];
      state.cached = {};
      state.bundles = {};
      return undefined;
    },
    skills_team_link: (args: Args) => {
      const localId = String(args?.localId);
      const link = args?.link as ShareLink | null;
      if (link) state.links[localId] = link;
      else delete state.links[localId];
      return view();
    },
    skills_bundle: (args: Args) => {
      const skill = localSkills().find((s) => s.id === args?.id);
      if (!skill) throw { code: "not_found" };
      return localBundleOf(skill);
    },
  };

  return { handlers, state, requests, calls };
}
