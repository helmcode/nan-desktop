// Shared skills (S4): the sync decisions (ETag / 304, revocation purge,
// error states), the share upload, the org flag and the derived UI state,
// over the mocked Tauri IPC with a fake core (src/test/teamMock.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, resetTauri } from "../test/tauriMock";
import { fakeTeamCore, localBundleOf, meta, wireSkill, type ApiRequest, type ApiReply } from "../test/teamMock";

vi.mock("@tauri-apps/api/core", async () => (await import("../test/tauriMock")).coreModule());

import type { Skill } from "./skills";
import {
  EMPTY_VIEW,
  TEAM_PREFIX,
  bundlesToFetch,
  fetchSkillsSharing,
  loadTeamSkill,
  parseList,
  parseSkillsSharing,
  problemForError,
  problemForStatus,
  shareSkill,
  shareStateFor,
  syncTeam,
  teamAsSkill,
  teamLibrary,
  usableTeamSkills,
  type CacheView,
} from "./team";

const P = "helmcode";
const LOCAL = "0123456789abcdef0123456789abcdef";

function local(patch: Partial<Skill> = {}): Skill {
  return {
    id: LOCAL,
    name: "weekly-report",
    title: "Weekly report",
    description: "Writes the weekly report",
    instructions: "Use **bullets**.",
    references: [
      { name: "z.md", content: "Z" },
      { name: "a.txt", content: "A" },
    ],
    created_at: 1,
    updated_at: 10,
    ...patch,
  };
}

/** A route table: list replies in order, bundles by id. */
function api(listReplies: ApiReply[], extra: (req: ApiRequest) => ApiReply | null = () => null) {
  let n = 0;
  return (req: ApiRequest): ApiReply => {
    const custom = extra(req);
    if (custom) return custom;
    if (req.method === "GET" && req.path === "/api/skills") {
      const reply = listReplies[Math.min(n, listReplies.length - 1)];
      n += 1;
      return reply;
    }
    const id = req.path.startsWith("/api/skills/") ? req.path.slice("/api/skills/".length) : null;
    if (req.method === "GET" && id) return { status: 200, body: wireSkill(meta(id)) };
    return { status: 500 };
  };
}

beforeEach(() => resetTauri());

describe("syncTeam", () => {
  it("stores the list with its ETag and caches every approved bundle", async () => {
    const core = fakeTeamCore(
      api([
        {
          status: 200,
          etag: '"v1"',
          body: { skills: [meta("a"), meta("p", { status: "pending" }), meta("b")], etag: '"v1"' },
        },
      ]),
    );
    resetTauri(core.handlers);
    const { view, problem } = await syncTeam(P);
    expect(problem).toBeNull();
    expect(view.etag).toBe('"v1"');
    expect(Object.keys(view.cached).sort()).toEqual(["a", "b"]);
    const paths = core.requests.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(["GET /api/skills", "GET /api/skills/a", "GET /api/skills/b"]);
    expect(core.requests[0].ifNoneMatch).toBeNull();
  });

  it("sends If-None-Match with the stored ETag; a 304 keeps the cache and refetches nothing", async () => {
    const core = fakeTeamCore(
      api([
        { status: 200, etag: '"v1"', body: { skills: [meta("a")], etag: '"v1"' } },
        { status: 304, etag: '"v1"' },
      ]),
    );
    resetTauri(core.handlers);
    await syncTeam(P);
    core.requests.length = 0;
    core.calls.length = 0;

    const { view, problem } = await syncTeam(P);
    expect(problem).toBeNull();
    expect(core.requests).toHaveLength(1);
    expect(core.requests[0].ifNoneMatch).toBe('"v1"');
    expect(core.calls).not.toContain("store_list");
    expect(core.calls).not.toContain("put");
    expect(view.cached).toHaveProperty("a");
  });

  it("purges a cached skill the next list no longer contains (revocation)", async () => {
    const core = fakeTeamCore(
      api([
        { status: 200, etag: '"v1"', body: { skills: [meta("a"), meta("b")] } },
        { status: 200, etag: '"v2"', body: { skills: [meta("b")] } },
      ]),
    );
    resetTauri(core.handlers);
    await syncTeam(P);
    expect("skill" in (await loadTeamSkill(P, "a"))).toBe(true);

    const { view } = await syncTeam(P);
    expect(view.cached).not.toHaveProperty("a");
    expect(view.skills.map((m) => m.id)).toEqual(["b"]);
    expect(core.state.bundles).not.toHaveProperty("a");
    // "Use" can no longer resolve it from the cache.
    await expect(invoke("skills_team_cache_get", { profileId: P, id: "a" })).rejects.toEqual({ code: "not_found" });
  });

  it("refetches a bundle whose updated_at changed", async () => {
    const core = fakeTeamCore(
      api([
        { status: 200, etag: '"v1"', body: { skills: [meta("a")] } },
        { status: 200, etag: '"v2"', body: { skills: [meta("a", { updated_at: "2026-11-02T00:00:00Z" })] } },
      ]),
    );
    resetTauri(core.handlers);
    await syncTeam(P);
    core.requests.length = 0;
    const { view } = await syncTeam(P);
    expect(core.requests.map((r) => r.path)).toEqual(["/api/skills", "/api/skills/a"]);
    expect(view.cached.a).toBe("2026-11-02T00:00:00Z");
  });

  it("404 means the org has sharing off: the cache is cleared", async () => {
    const core = fakeTeamCore(
      api([
        { status: 200, etag: '"v1"', body: { skills: [meta("a")] } },
        { status: 404, body: { error: "not_found" } },
      ]),
    );
    resetTauri(core.handlers);
    await syncTeam(P);
    const { view, problem } = await syncTeam(P);
    expect(problem).toBe("disabled");
    expect(core.calls).toContain("clear");
    expect(view.skills).toEqual([]);
    expect(view.cached).toEqual({});
  });

  it("429, 401, 403 and offline keep the cached copy and report the problem", async () => {
    for (const [reply, expected] of [
      [{ status: 429 }, "rate_limited"],
      [{ status: 401 }, "expired"],
      [{ status: 403 }, "forbidden"],
      [{ fail: "offline" }, "offline"],
      [{ fail: "no_session" }, "expired"],
    ] as const) {
      const core = fakeTeamCore(api([{ status: 200, etag: '"v1"', body: { skills: [meta("a")] } }, reply]));
      resetTauri(core.handlers);
      await syncTeam(P);
      const { view, problem } = await syncTeam(P);
      expect(problem).toBe(expected);
      expect(view.cached).toHaveProperty("a");
      expect(core.calls).not.toContain("clear");
    }
  });

  it("a rate limit while fetching bundles stops the round", async () => {
    const core = fakeTeamCore(
      api([{ status: 200, etag: '"v1"', body: { skills: [meta("a"), meta("b")] } }], (req) =>
        req.path === "/api/skills/a" ? { status: 429 } : null,
      ),
    );
    resetTauri(core.handlers);
    const { problem, view } = await syncTeam(P);
    expect(problem).toBe("rate_limited");
    expect(core.requests.map((r) => r.path)).toEqual(["/api/skills", "/api/skills/a"]);
    expect(view.cached).toEqual({});
  });
});

describe("shareSkill", () => {
  it("POSTs exactly the core's canonical bundle (SKILL.md first, then references) and records the link", async () => {
    const skill = local();
    const core = fakeTeamCore(
      api([], (req) =>
        req.method === "POST" ? { status: 201, body: { skill: meta("sk_new", { status: "pending" }) } } : null,
      ),
      () => [skill],
    );
    resetTauri(core.handlers);
    const result = await shareSkill(P, skill, null);
    expect(result.ok).toBe(true);
    const post = core.requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/api/skills");
    const sent = post?.body as { files: Array<{ path: string; content: string }> };
    expect(Object.keys(sent)).toEqual(["files"]);
    expect(sent.files).toEqual(localBundleOf(skill).files);
    expect(sent.files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.txt", "references/z.md"]);
    expect(sent.files[0].content.startsWith("---\nname: weekly-report\ndescription: ")).toBe(true);
    expect(core.state.links[LOCAL]).toEqual({ remote_id: "sk_new", sha: `sha-${LOCAL}-10`, local_updated_at: 10 });
    if (result.ok) expect(result.view.skills.map((m) => m.id)).toContain("sk_new");
  });

  it("re-shares with PUT on the linked id (back to pending)", async () => {
    const skill = local({ updated_at: 20 });
    const core = fakeTeamCore(
      api([], (req) =>
        req.method === "PUT" ? { status: 200, body: { skill: meta("sk_1", { status: "pending" }) } } : null,
      ),
      () => [skill],
    );
    resetTauri(core.handlers);
    const result = await shareSkill(P, skill, { remote_id: "sk_1", sha: "old", local_updated_at: 10 });
    expect(result.ok).toBe(true);
    expect(core.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /api/skills/sk_1"]);
    expect(core.state.links[LOCAL].local_updated_at).toBe(20);
  });

  it("a PUT on a deleted row falls back to a new POST", async () => {
    const skill = local();
    const core = fakeTeamCore(
      api([], (req) =>
        req.method === "PUT"
          ? { status: 404 }
          : req.method === "POST"
            ? { status: 201, body: { skill: meta("sk_2", { status: "pending" }) } }
            : null,
      ),
      () => [skill],
    );
    resetTauri(core.handlers);
    const result = await shareSkill(P, skill, { remote_id: "sk_gone", sha: "s", local_updated_at: 1 });
    expect(result.ok).toBe(true);
    expect(core.state.links[LOCAL].remote_id).toBe("sk_2");
  });

  it("maps 404, 429 and 401 to problems without linking", async () => {
    for (const [status, problem] of [
      [404, "disabled"],
      [429, "rate_limited"],
      [401, "expired"],
    ] as const) {
      const skill = local();
      const core = fakeTeamCore(api([], () => ({ status })), () => [skill]);
      resetTauri(core.handlers);
      expect(await shareSkill(P, skill, null)).toEqual({ ok: false, problem });
      expect(core.state.links).toEqual({});
    }
  });
});

describe("the org flag", () => {
  it("parses skills_sharing from /api/auth/me, default false", () => {
    expect(parseSkillsSharing({ skills_sharing: true })).toBe(true);
    expect(parseSkillsSharing({ org: { skills_sharing: true } })).toBe(true);
    expect(parseSkillsSharing({ features: { skills_sharing: true } })).toBe(true);
    expect(parseSkillsSharing({ skills_sharing: "yes" })).toBe(false);
    expect(parseSkillsSharing({ email: "a@b.c" })).toBe(false);
    expect(parseSkillsSharing(null)).toBe(false);
  });

  it("is never fetched for the community profile", async () => {
    const core = fakeTeamCore(() => ({ status: 200, body: { skills_sharing: true } }));
    resetTauri(core.handlers);
    expect(await fetchSkillsSharing("nan")).toBe(false);
    expect(core.requests).toHaveLength(0);
    expect(await fetchSkillsSharing(P)).toBe(true);
    expect(core.requests[0]).toMatchObject({ method: "GET", path: "/api/auth/me" });
  });

  it("is false when /api/auth/me fails", async () => {
    resetTauri(fakeTeamCore(() => ({ status: 401 })).handlers);
    expect(await fetchSkillsSharing(P)).toBe(false);
    resetTauri(fakeTeamCore(() => ({ fail: "offline" })).handlers);
    expect(await fetchSkillsSharing(P)).toBe(false);
  });
});

describe("derived state", () => {
  const view = (patch: Partial<CacheView>): CacheView => ({ ...EMPTY_VIEW, ...patch });

  it("the library is approved rows, featured first, server order kept", () => {
    const v = view({
      skills: [
        meta("a"),
        meta("b", { featured: true }),
        meta("p", { status: "pending" }),
        meta("c"),
        meta("d", { featured: true }),
        meta("r", { status: "rejected" }),
      ],
    });
    expect(teamLibrary(v).map((m) => m.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("only cached team skills are offered in the picker, with a team: id", () => {
    const v = view({ skills: [meta("a"), meta("b")], cached: { b: "x" } });
    expect(usableTeamSkills(v).map((s) => s.id)).toEqual([`${TEAM_PREFIX}b`]);
    expect(teamAsSkill(meta("a")).title).toBe("Title a");
  });

  it("share state: local, in review, shared, not approved with its reason, edited", () => {
    const skill = local();
    expect(shareStateFor(skill, view({}))).toEqual({ kind: "local" });
    const link = { remote_id: "sk", sha: "s", local_updated_at: 10 };
    // Linked but the row is gone: local again.
    expect(shareStateFor(skill, view({ links: { [LOCAL]: link } }))).toEqual({ kind: "local" });
    const withRow = (status: string, reason: string | null = null) =>
      view({ links: { [LOCAL]: link }, skills: [meta("sk", { status, reject_reason: reason })] });
    expect(shareStateFor(skill, withRow("pending"))).toMatchObject({ kind: "pending", edited: false });
    expect(shareStateFor(skill, withRow("approved"))).toMatchObject({ kind: "approved", edited: false });
    expect(shareStateFor(skill, withRow("rejected", "Too vague"))).toEqual({
      kind: "rejected",
      edited: false,
      reason: "Too vague",
    });
    expect(shareStateFor(local({ updated_at: 11 }), withRow("approved"))).toMatchObject({ edited: true });
  });

  it("status and error mapping", () => {
    expect(problemForStatus(200)).toBeNull();
    expect(problemForStatus(304)).toBeNull();
    expect(problemForStatus(404)).toBe("disabled");
    expect(problemForStatus(401)).toBe("expired");
    expect(problemForStatus(403)).toBe("forbidden");
    expect(problemForStatus(429)).toBe("rate_limited");
    expect(problemForStatus(500)).toBe("generic");
    expect(problemForError({ code: "no_session" })).toBe("expired");
    expect(problemForError({ code: "offline" })).toBe("offline");
    expect(problemForError({ code: "bundle", reason: { code: "too_many_files" } })).toBe("invalid");
    expect(problemForError("boom")).toBe("generic");
  });

  it("parses the list body and needs only missing or outdated approved bundles", () => {
    expect(parseList({ nope: 1 })).toBeNull();
    const parsed = parseList({ skills: [meta("a"), { id: "" }, "x", meta("b")], etag: '"e"' });
    expect(parsed?.skills.map((m) => m.id)).toEqual(["a", "b"]);
    expect(parsed?.etag).toBe('"e"');
    const v = view({
      skills: [meta("a"), meta("b"), meta("p", { status: "pending" })],
      cached: { a: meta("a").updated_at, b: "old" },
    });
    expect(bundlesToFetch(v).map((m) => m.id)).toEqual(["b"]);
  });
});
