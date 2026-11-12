// @vitest-environment jsdom
// Shared skills (S4) over the mocked Tauri IPC and a fake library API:
// "Share with my team" gating (hidden on NaN and without the org flag), the
// share dialog (exactly what teammates see + the warning), the POST bundle,
// the card states and "Share again" (PUT), the Team tab (featured first,
// sanitized read-only view with provenance, Use in the chat, Duplicate),
// the 15-minute ETag refresh and the 404 / 429 / 401 states.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { invokedWith, resetTauri } from "./test/tauriMock";
import { fakeTeamCore, localBundleOf, meta, skillRoute, wireSkill, type ApiReply, type ApiRequest } from "./test/teamMock";

vi.mock("@tauri-apps/api/core", async () => (await import("./test/tauriMock")).coreModule());
vi.mock("@tauri-apps/api/event", async () => (await import("./test/tauriMock")).eventModule());

import App from "./App";
import { I18nProvider, type Locale } from "./i18n";
import type { Skill, SkillInput } from "./skills/skills";
import { TEAM_SYNC_INTERVAL_MS, planNextSync, type ShareLink, type TeamMeta } from "./skills/team";
import type { ChatMessageRow } from "./types";

const LOCAL = "0123456789abcdef0123456789abcdef";
const WARNING_EN =
  "Your name will appear as the author. An administrator will review it before your team sees it.";
const WARNING_ES = "Tu nombre aparecerá como autor. Un administrador la revisará antes de que el equipo la vea.";

function row(id: number, role: string, content: string): ChatMessageRow {
  return { id, conversation_id: 7, role, content, model: null, created_at: "", partial: false, media_path: null, sources: [] };
}

function weekly(patch: Partial<Skill> = {}): Skill {
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

type Setup = {
  profile?: "nan" | "helmcode";
  sharing?: boolean;
  /** Override for `GET /api/auth/me` (round 13: the identity chip). */
  me?: { status: number; body?: Record<string, unknown> };
  skills?: Skill[];
  rows?: TeamMeta[];
  links?: Record<string, ShareLink>;
  instructions?: Record<string, string>;
  /** Overrides for `GET /api/skills` (the list), checked first. */
  list?: (req: ApiRequest) => ApiReply | null;
  /** Overrides for `GET /api/skills/{id}` (a bundle), before the row lookup. */
  bundle?: (req: ApiRequest) => ApiReply | null;
  /** Overrides for a publish (`POST /api/skills`, `PUT /api/skills/{id}`). */
  publish?: (req: ApiRequest) => ApiReply | null;
  /** Core command overrides, applied after the fake team core. */
  core?: Record<string, (args: Record<string, unknown> | undefined) => unknown>;
};

/// The chat handlers, a local skills store and a stateful library API.
function setup(opts: Setup = {}) {
  const profile = opts.profile ?? "helmcode";
  let store = [...(opts.skills ?? [])];
  const rows = [...(opts.rows ?? [])];
  let version = 1;
  let created = 0;
  const route = (req: ApiRequest): ApiReply => {
    if (req.path === "/api/auth/me") {
      if (opts.me) return { status: opts.me.status, body: opts.me.body ?? {} };
      // The real enterprise-api /me shape (handlers/auth.go Me).
      return {
        status: 200,
        body: {
          email: "ana@example.com",
          featureFlags: opts.sharing ? ["chat", "skills_sharing"] : ["chat"],
          skillsSharing: opts.sharing === true,
        },
      };
    }
    if (req.method === "GET" && req.path === "/api/skills") {
      const override = opts.list?.(req);
      if (override) return override;
      const etag = `"v${version}"`;
      if (req.ifNoneMatch === etag) return { status: 304, etag };
      return { status: 200, etag, body: { skills: rows, etag } };
    }
    const { id, query } = skillRoute(req.path) ?? { id: "", query: "" };
    if (req.method === "GET") {
      const override = opts.bundle?.(req);
      if (override) return override;
    }
    if (req.method === "POST" || req.method === "PUT") {
      const override = opts.publish?.(req);
      if (override) return override;
    }
    if (req.method === "POST") {
      const added = meta("sk_new", { status: "pending", title: "Weekly report", author_name: "Me" });
      rows.push(added);
      version += 1;
      return { status: 201, body: { skill: added } };
    }
    if (req.method === "PUT") {
      const index = rows.findIndex((r) => r.id === id);
      rows[index] = { ...rows[index], status: "pending", reject_reason: null };
      version += 1;
      return { status: 200, body: { skill: rows[index] } };
    }
    if (req.method === "GET") {
      const found = rows.find((r) => r.id === id);
      return found ? { status: 200, body: wireSkill(found, opts.instructions?.[id], query) } : { status: 404 };
    }
    return { status: 500 };
  };
  const core = fakeTeamCore(route, () => store);
  Object.assign(core.state.links, opts.links ?? {});
  let next = 0;
  resetTauri({
    profiles_load: () => ({
      profiles: [{ id: profile, name: profile, has_key: true, key_mask: "sk-…abcd" }],
      active_profile: profile,
    }),
    conversation_list: () => [{ id: 7, title: "Notes", updated_at: "", last_message: null }],
    messages_list: () => [row(1, "user", "Summarize my notes weekly")],
    memory_sync: () => false,
    models_list: () => ["deepseek-v4-flash"],
    tools_grant_list: () => [],
    tts_stop: () => undefined,
    chat_send: () => undefined,
    skills_list: () => store,
    skills_create: (args: Record<string, unknown> | undefined) => {
      const input = args?.input as SkillInput;
      next += 1;
      const skill: Skill = {
        id: `${"c".repeat(31)}${next}`,
        name: "copy",
        title: input.title,
        description: input.description,
        instructions: input.instructions,
        references: input.references,
        created_at: 50,
        updated_at: 50,
      };
      store = [skill, ...store];
      created += 1;
      return skill;
    },
    skills_update: () => undefined,
    skills_delete: () => undefined,
    ...core.handlers,
    ...(opts.core ?? {}),
  });
  return { core, rows, created: () => created, bump: () => { version += 1; } };
}

function renderApp(locale: Locale = "en") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

async function openSkills(settings = "Settings", skills = "Skills"): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /Account menu|Menú de la cuenta/ }));
  fireEvent.click(await screen.findByRole("menuitem", { name: settings }));
  fireEvent.click(await screen.findByRole("button", { name: skills }));
  await screen.findByRole("heading", { name: skills, level: 1 });
}

async function openTeamTab(name = "Team"): Promise<void> {
  fireEvent.click(await screen.findByRole("tab", { name }));
}

/**
 * Captures the team sync delays (the short retries and the 15-minute
 * refresh) without firing them; everything else keeps the real timer.
 */
function captureSyncTimers(): Array<{ delay: number; run: () => void }> {
  const timers: Array<{ delay: number; run: () => void }> = [];
  const original = window.setTimeout.bind(window);
  const watched = [60_000, 5 * 60_000, TEAM_SYNC_INTERVAL_MS];
  vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, timeout?: number) => {
    if (typeof timeout === "number" && watched.includes(timeout)) {
      timers.push({ delay: timeout, run: handler as () => void });
      return original(() => {}, 1_000_000);
    }
    return original(handler as () => void, timeout);
  }) as unknown as typeof window.setTimeout);
  return timers;
}

/** The most recent captured timer with that delay (throws when none exists). */
function lastTimerFor(timers: Array<{ delay: number; run: () => void }>, delay: number): () => void {
  const matches = timers.filter((t) => t.delay === delay);
  const last = matches[matches.length - 1];
  if (!last) throw new Error(`no timer for delay ${delay}`);
  return last.run;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Share with my team: gating", () => {
  it("round 13: the bottom-left chip shows the signed-in user's email", async () => {
    setup({ profile: "helmcode" });
    renderApp();
    await screen.findByText("ana@example.com");
    expect(screen.queryByText("Helmcode for teams")).toBeNull();
  });

  it("round 13: without /api/auth/me the chip keeps the platform label", async () => {
    setup({ profile: "helmcode", me: { status: 404, body: {} } });
    renderApp();
    await screen.findByText("Helmcode for teams");
    expect(screen.queryByText("ana@example.com")).toBeNull();
  });

  it("is hidden on the community profile even with the flag, and NaN never calls the library", async () => {
    const { core } = setup({ profile: "nan", sharing: true, skills: [weekly()] });
    renderApp();
    await openSkills();
    expect(await screen.findByText("Weekly report")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /with my team/ })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    // Round 13: the only allowed community call is the identity read of the
    // bottom-left chip; no skills/library surfaces may fire.
    expect(core.requests).toEqual([{ method: "GET", path: "/api/auth/me", body: null, ifNoneMatch: null }]);
  });

  it("round 15 (F3): on Helmcode with the org flag off it is visible but disabled and says why", async () => {
    const { core } = setup({ sharing: false, skills: [weekly()] });
    renderApp();
    await openSkills();
    await waitFor(() => expect(core.requests.some((r) => r.path === "/api/auth/me")).toBe(true));
    expect(await screen.findByRole("tab", { name: "Team" })).toBeTruthy();
    const button = screen.getByRole("button", { name: 'Share "Weekly report" with my team' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const why = "Sharing with your team is turned off for your organization. An admin can turn it on in the Helmcode console.";
    expect(button.getAttribute("title")).toBe(why);
    expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe(why);
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(core.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("round 15 (D6): with the org flag off and no own skills there is no share-off note", async () => {
    const { core } = setup({ sharing: false, skills: [] });
    renderApp();
    await openSkills();
    await waitFor(() => expect(core.requests.some((r) => r.path === "/api/auth/me")).toBe(true));
    expect(await screen.findByRole("tab", { name: "Team" })).toBeTruthy();
    expect(screen.queryByText(/turned off for your organization/)).toBeNull();
    expect(document.getElementById("skills-share-off")).toBeNull();
  });

  it("round 15 (F3): with /me unreachable the flag is unknown: no share action and no off note", async () => {
    const { core } = setup({ skills: [weekly()], me: { status: 500 } });
    renderApp();
    await openSkills();
    await waitFor(() => expect(core.requests.some((r) => r.path === "/api/auth/me")).toBe(true));
    expect(await screen.findByText("Weekly report")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /with my team/ })).toBeNull();
    expect(screen.queryByText(/turned off for your organization/)).toBeNull();
  });

  it("round 15 (F3): the real /me reply (skillsSharing + featureFlags) enables it from Mine", async () => {
    setup({ sharing: true, skills: [weekly()] });
    renderApp();
    await openSkills();
    // Mine is the default tab: the action is reachable without visiting Team.
    expect(screen.getByRole("tab", { name: "Mine" }).getAttribute("aria-selected")).toBe("true");
    const button = (await screen.findByRole("button", { name: 'Share "Weekly report" with my team' })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Share with my team" })).toBeTruthy();
    expect(screen.queryByText(/turned off for your organization/)).toBeNull();
  });

  it("is visible with the flag", async () => {
    setup({ sharing: true, skills: [weekly()] });
    renderApp();
    await openSkills();
    expect(await screen.findByRole("button", { name: 'Share "Weekly report" with my team' })).toBeTruthy();
    expect(screen.getByText("Local")).toBeTruthy();
  });
});

describe("Share with my team: the flow", () => {
  it("the dialog shows exactly what teammates will see and the warning; confirm POSTs the bundle", async () => {
    const skill = weekly();
    const { core } = setup({ sharing: true, skills: [skill] });
    renderApp();
    await openSkills();
    fireEvent.click(await screen.findByRole("button", { name: 'Share "Weekly report" with my team' }));

    const dialog = await screen.findByRole("dialog", { name: "Share with my team" });
    expect(within(dialog).getByText("This is exactly what your teammates will see:")).toBeTruthy();
    expect(within(dialog).getByText("Weekly report")).toBeTruthy();
    expect(within(dialog).getByText("Writes the weekly report")).toBeTruthy();
    // The instructions are rendered (sanitized markdown), not shown raw.
    expect(dialog.querySelector(".share-preview-body strong")?.textContent).toBe("bullets");
    expect(within(dialog).getByText("a.txt")).toBeTruthy();
    expect(within(dialog).getByText("z.md")).toBeTruthy();
    expect(within(dialog).getByText(WARNING_EN)).toBeTruthy();
    expect(core.requests.some((r) => r.method === "POST")).toBe(false);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Share" }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = core.requests.find((r) => r.method === "POST");
    expect(post?.path).toBe("/api/skills");
    // enterprise-api's publish contract: the slug, the title and the files.
    expect(post?.body).toEqual({ name: "weekly-report", title: "Weekly report", files: localBundleOf(skill).files });
    expect((post?.body as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "references/a.txt",
      "references/z.md",
    ]);
    expect(await screen.findByText("In review")).toBeTruthy();
    expect(
      screen.getByText('"Weekly report" was sent for review. Your team will see it once an administrator approves it.'),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: 'Share "Weekly report" with my team' })).toBeNull();
  });

  it("cancel sends nothing", async () => {
    const { core } = setup({ sharing: true, skills: [weekly()] });
    renderApp();
    await openSkills();
    fireEvent.click(await screen.findByRole("button", { name: 'Share "Weekly report" with my team' }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(core.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("a rejected skill shows its reason; edited after sharing it offers Share again (PUT, back to review)", async () => {
    const { core } = setup({
      sharing: true,
      skills: [weekly({ updated_at: 10 })],
      rows: [meta("sk_1", { status: "rejected", reject_reason: "Too vague", author_name: "Me" })],
      links: { [LOCAL]: { remote_id: "sk_1", sha: "s", local_updated_at: 5 } },
    });
    renderApp();
    await openSkills();
    expect(await screen.findByText("Not approved")).toBeTruthy();
    expect(screen.getByText("Reason: Too vague")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: 'Share the new version of "Weekly report" with my team' }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Share the new version" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Share again" }));
    });
    await waitFor(() => expect(core.requests.some((r) => r.method === "PUT")).toBe(true));
    expect(core.requests.find((r) => r.method === "PUT")?.path).toBe("/api/skills/sk_1");
    expect(await screen.findByText("In review")).toBeTruthy();
    expect(core.state.links[LOCAL].local_updated_at).toBe(10);
  });

  it("an approved, unedited skill shows Shared and no share action", async () => {
    setup({
      sharing: true,
      skills: [weekly({ updated_at: 5 })],
      rows: [meta("sk_1", { status: "approved" })],
      links: { [LOCAL]: { remote_id: "sk_1", sha: "s", local_updated_at: 5 } },
    });
    renderApp();
    await openSkills();
    expect(await screen.findByText("Shared")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /with my team/ })).toBeNull();
  });

  it("round 15 (D7): Spanish says 'con el equipo' on Share again too", async () => {
    setup({
      sharing: true,
      skills: [weekly({ updated_at: 10 })],
      rows: [meta("sk_1", { status: "rejected", reject_reason: "Too vague", author_name: "Me" })],
      links: { [LOCAL]: { remote_id: "sk_1", sha: "s", local_updated_at: 5 } },
    });
    renderApp("es");
    await openSkills("Ajustes", "Skills");
    expect(
      await screen.findByRole("button", { name: "Compartir la nueva versión de «Weekly report» con el equipo" }),
    ).toBeTruthy();
    expect(screen.queryByText(/mi equipo/)).toBeNull();
  });

  it("speaks Spanish: the button, the dialog warning and the tabs", async () => {
    setup({ sharing: true, skills: [weekly()] });
    renderApp("es");
    await openSkills("Ajustes", "Skills");
    expect(await screen.findByRole("tab", { name: "Mías" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Equipo" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Compartir «Weekly report» con el equipo" }));
    const dialog = await screen.findByRole("dialog", { name: "Compartir con el equipo" });
    expect(within(dialog).getByText(WARNING_ES)).toBeTruthy();
  });
});

describe("The Team tab", () => {
  const rows = [
    meta("a", { title: "Alpha", description: "First", author_name: "Ana" }),
    meta("b", { title: "Beta", description: "Second", author_name: "Luis", featured: true }),
    meta("p", { title: "Pending one", status: "pending", author_name: "Me" }),
  ];
  const instructions = { a: "Step **one**.\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>" };

  it("lives inside Settings with the local and team tabs and no conversation list (S2)", async () => {
    setup({ rows, sharing: true, skills: [weekly()] });
    renderApp();
    await openSkills();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("button", { name: "Skills" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("navigation", { name: "History" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Mine" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Team" })).toBeTruthy();
    // Local and team skills keep their own lists under the tabs.
    expect(await screen.findByText("Weekly report")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Team" }));
    const list = await screen.findByRole("list", { name: "Team" });
    expect(within(list).getByText("Beta")).toBeTruthy();
  });

  it("lists the org's approved skills, featured first, with author and provenance", async () => {
    setup({ rows });
    renderApp();
    await openSkills();
    await openTeamTab();
    const list = await screen.findByRole("list", { name: "Team" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Beta");
    expect(items[0].textContent).toContain("Featured");
    expect(items[1].textContent).toContain("Alpha");
    expect(within(items[1]).getByText(/Shared by Ana \(team\)/)).toBeTruthy();
    expect(screen.queryByText("Pending one")).toBeNull();
  });

  it("View shows the sanitized instructions with the provenance (no raw HTML)", async () => {
    setup({ rows, instructions });
    renderApp();
    await openSkills();
    await openTeamTab();
    fireEvent.click(await screen.findByRole("button", { name: 'View "Alpha"' }));
    expect(await screen.findByRole("heading", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByText("Shared by Ana (team)")).toBeTruthy();
    const body = document.querySelector(".team-skill-body") as HTMLElement;
    expect(body.querySelector("strong")?.textContent).toBe("one");
    expect(body.querySelector("img")).toBeNull();
    expect(body.querySelector("script")).toBeNull();
    expect(screen.getByText("notes.md")).toBeTruthy();
  });

  it("Use turns it on in the chat like a local skill: pill + team:<id> sent", async () => {
    setup({ rows });
    renderApp();
    await openSkills();
    await openTeamTab();
    fireEvent.click(await screen.findByRole("button", { name: 'Use "Alpha" in the chat' }));
    expect(await screen.findByText("Using: Alpha")).toBeTruthy();
    const box = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter" });
    });
    await waitFor(() => expect(invokedWith("chat_send")[0]?.skillId).toBe("team:a"));
  });

  it("cached team skills are offered in the composer picker, next to the local ones", async () => {
    setup({ rows, skills: [weekly()] });
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    await waitFor(() => expect(invokedWith("skills_team_cache_put").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole("button", { name: "Use skill" }));
    const list = await screen.findByRole("listbox", { name: "Your skills" });
    expect(within(list).getByText("Beta")).toBeTruthy();
    expect(within(list).getByText("Alpha")).toBeTruthy();
    expect(within(list).getByText("Weekly report")).toBeTruthy();
  });

  it("Duplicate copies the bundle into a new, editable local skill", async () => {
    const { created } = setup({ rows, instructions });
    renderApp();
    await openSkills();
    await openTeamTab();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: 'Duplicate "Alpha" in my skills' }));
    });
    await waitFor(() => expect(created()).toBe(1));
    expect(invokedWith("skills_create")[0]).toEqual({
      input: {
        title: "Alpha",
        description: "First",
        instructions: instructions.a,
        references: [{ name: "notes.md", content: "Notes" }],
      },
    });
    expect(await screen.findByText('"Alpha" is now in your skills. You can edit it.')).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Mine" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: 'Edit skill "Alpha"' })).toBeTruthy();
  });

  it("refreshes every 15 minutes with If-None-Match (a 304 refetches nothing)", async () => {
    const timers = captureSyncTimers();
    const { core } = setup({ rows });
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    await waitFor(() => expect(invokedWith("skills_team_cache_put").length).toBeGreaterThanOrEqual(2));
    const refresh = timers.filter((timer) => timer.delay === TEAM_SYNC_INTERVAL_MS);
    expect(refresh).toHaveLength(1);
    const before = core.requests.length;
    await act(async () => {
      refresh[0].run();
    });
    await waitFor(() => expect(core.requests.length).toBeGreaterThan(before));
    const list = core.requests.slice(before).filter((r) => r.path === "/api/skills");
    expect(list).toHaveLength(1);
    expect(list[0].ifNoneMatch).toBe('"v1"');
    expect(core.requests.slice(before).some((r) => r.path.startsWith("/api/skills/"))).toBe(false);
  });
});

describe("An interrupted bundle round (round 14/S3)", () => {
  it("retries in 60 seconds, then 5 minutes, then the normal interval", () => {
    expect(planNextSync("rate_limited", 0)).toEqual({ delayMs: 60_000, failures: 1 });
    expect(planNextSync("rate_limited", 1)).toEqual({ delayMs: 5 * 60_000, failures: 2 });
    expect(planNextSync("expired", 2)).toEqual({ delayMs: TEAM_SYNC_INTERVAL_MS, failures: 3 });
  });

  it("round 14 QA: the ladder escalates through App and resets after a success", async () => {
    const timers = captureSyncTimers();
    let failing = true;
    const grab = setup({ rows: [meta("a", { title: "Alpha" })], bundle: () => (failing ? { status: 429 } : null) });
    const rows = grab.rows as TeamMeta[];
    renderApp();
    await openSkills();
    await openTeamTab();
    await waitFor(() => expect(screen.getByText("Preparing…")).toBeTruthy());
    const at = (delay: number) => timers.filter((t) => t.delay === delay);
    /** The delays of the timers scheduled after `from` (a slice window). */
    const delaysSince = (from: number) => timers.slice(from).map((t) => t.delay);
    const call = lastTimerFor(timers, 60_000);

    // First failure schedules 60s; a second one escalates to 5 minutes.
    await act(async () => {
      call();
    });
    await waitFor(() => expect(screen.getByText("Preparing…")).toBeTruthy());
    expect(at(5 * 60_000).length > 0).toBe(true);
    const ladderAtFive = lastTimerFor(timers, 5 * 60_000);

    // A success resets the ladder: the timers that success round schedules are
    // the normal 15-minute refresh only.
    failing = false;
    const beforeSuccess = timers.length;
    await act(async () => {
      ladderAtFive();
    });
    await waitFor(() => expect(screen.queryByText("Preparing…")).toBeNull());
    const successRound = delaysSince(beforeSuccess);
    expect(successRound).toContain(TEAM_SYNC_INTERVAL_MS);
    expect(successRound.filter((delay) => delay === 60_000 || delay === 5 * 60_000)).toEqual([]);

    // A fresh failure starts the ladder over at 60 seconds (count reset).
    // Give the sync something NEW to fetch: bump the list etag and the row
    // version, so bundlesToFetch adds it again while the bundle keeps failing.
    rows[0] = meta("a", { title: "Alpha", updated_at: "2026-11-12T00:00:00Z" });
    grab.bump();
    failing = true;
    const beforeFreshFailure = timers.length;
    // Flush the async round inside act so its re-scheduling happens while
    // React is settled; the run continues through list -> bundle -> plan.
    const finalTimer = lastTimerFor(timers, TEAM_SYNC_INTERVAL_MS);
    await act(async () => {
      finalTimer();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText("Preparing…")).toBeTruthy());
    // The fresh round scheduled the first rung (60s), not the 5-minute one.
    const freshRound = delaysSince(beforeFreshFailure);
    expect(freshRound).toEqual([60_000]);
    expect(freshRound).not.toContain(5 * 60_000);
  });

  it("a completed round goes back to the normal interval and resets the count", () => {
    expect(planNextSync(null, 2)).toEqual({ delayMs: TEAM_SYNC_INTERVAL_MS, failures: 0 });
    // Only the two problems that stop a round early ask for a short retry.
    expect(planNextSync("offline", 1)).toEqual({ delayMs: TEAM_SYNC_INTERVAL_MS, failures: 0 });
    expect(planNextSync("generic", 0)).toEqual({ delayMs: TEAM_SYNC_INTERVAL_MS, failures: 0 });
  });

  it("an approved row without a cached bundle says it is being prepared", async () => {
    setup({ rows: [meta("a", { title: "Alpha" })], bundle: () => ({ status: 429 }) });
    renderApp();
    await openSkills();
    await openTeamTab();
    const list = await screen.findByRole("list", { name: "Team" });
    const item = within(list).getByRole("listitem");
    expect(item.textContent).toContain("Alpha");
    expect(within(item).getByText("Preparing…")).toBeTruthy();
    // Round 14 (C10): a space keeps the accessible name "Alpha Preparing…".
    expect(item.querySelector(".skill-title")?.textContent).toBe("Alpha Preparing…");
    // Round 14 (C11): the badge explains what it is waiting for.
    expect(within(item).getByText("Preparing…").getAttribute("title")).toBe(
      "Downloading to this computer; ready in a few seconds.",
    );
  });

  it("the retry in a minute caches the bundle and clears Preparing; cached rows keep their actions", async () => {
    const timers = captureSyncTimers();
    let stopped = true;
    setup({ rows: [meta("a", { title: "Alpha" })], bundle: () => (stopped ? { status: 429 } : null) });
    renderApp();
    await openSkills();
    await openTeamTab();
    expect(await screen.findByText("Preparing…")).toBeTruthy();
    const retry = timers.filter((timer) => timer.delay === 60_000);
    expect(retry).toHaveLength(1);

    stopped = false;
    await act(async () => {
      retry[0].run();
    });
    await waitFor(() => expect(screen.queryByText("Preparing…")).toBeNull());
    const item = within(screen.getByRole("list", { name: "Team" })).getByRole("listitem");
    expect(within(item).getByRole("button", { name: 'View "Alpha"' })).toBeTruthy();
    expect(within(item).getByRole("button", { name: 'Use "Alpha" in the chat' })).toBeTruthy();
    expect(within(item).getByRole("button", { name: 'Duplicate "Alpha" in my skills' })).toBeTruthy();
    // The next round is the normal refresh again.
    expect(timers[timers.length - 1].delay).toBe(TEAM_SYNC_INTERVAL_MS);
  });

  it("round 15 (F1): the real server reply caches the bundle; the badge clears and Use works", async () => {
    setup({ rows: [meta("a", { title: "Alpha" })] });
    renderApp();
    await openSkills();
    await openTeamTab();
    const list = await screen.findByRole("list", { name: "Team" });
    await waitFor(() => expect(within(list).getByRole("button", { name: 'Use "Alpha" in the chat' })).toBeTruthy());
    expect(within(list).queryByText("Preparing…")).toBeNull();
    const put = invokedWith("skills_team_cache_put")[0] as { skill: { id: string; files: unknown[] } };
    expect(put.skill.id).toBe("a");
    expect(put.skill.files).toHaveLength(2);
  });

  it("round 15 (F1): a reply without the bundle keeps Preparing and shows the problem", async () => {
    setup({
      rows: [meta("a", { title: "Alpha" })],
      // What the app used to get: metadata only, bundle null.
      bundle: () => ({ status: 200, body: wireSkill(meta("a", { title: "Alpha" }), undefined, "") }),
    });
    renderApp();
    await openSkills();
    await openTeamTab();
    expect(await screen.findByText("Preparing…")).toBeTruthy();
    expect(await screen.findByText("This skill has a file the app cannot accept.")).toBeTruthy();
    expect(invokedWith("skills_team_cache_put")).toHaveLength(0);
  });

  it("speaks Spanish: the preparing badge", async () => {
    setup({ rows: [meta("a", { title: "Alpha" })], bundle: () => ({ status: 429 }) });
    renderApp("es");
    await openSkills("Ajustes", "Skills");
    await openTeamTab("Equipo");
    expect(await screen.findByText("Preparando…")).toBeTruthy();
  });
});

describe("Escape inside the Skills section (round 14/C2)", () => {
  it("with the form open it closes the form and stays in Skills", async () => {
    setup({ skills: [weekly()] });
    renderApp();
    await openSkills();
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    expect(await screen.findByRole("heading", { name: "New skill", level: 1 })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("heading", { name: "New skill" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
  });

  it("round 14 (F1): with a half-filled form it keeps the draft and stays in the form", async () => {
    setup({ skills: [weekly()] });
    renderApp();
    await openSkills();
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Standup notes" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), {
      target: { value: "Use **bullets** for the standup" },
    });

    fireEvent.keyDown(document.body, { key: "Escape" });

    // Nothing typed is thrown away: the form is still open, with its content.
    expect(screen.getByRole("heading", { name: "New skill", level: 1 })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Standup notes");
    expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(
      "Use **bullets** for the standup",
    );
    // And the key never reached the Settings surface.
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
  });

  it("round 14 (F1): Escape that cancels an IME composition does nothing", async () => {
    setup({ skills: [weekly()] });
    renderApp();
    await openSkills();
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    expect(await screen.findByRole("heading", { name: "New skill", level: 1 })).toBeTruthy();

    // macOS composition (Japanese/Chinese input): Escape cancels the
    // composition, so it must not close anything -- not even an empty form.
    fireEvent.keyDown(document.body, { key: "Escape", isComposing: true });

    expect(screen.getByRole("heading", { name: "New skill", level: 1 })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
  });

  it("round 14 (F2): with the form and the account menu open, Escape closes only the menu", async () => {
    setup({ skills: [weekly()] });
    renderApp();
    await openSkills();
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Standup notes" } });
    // The account menu stays available in the Settings sidebar, so both
    // surfaces are open at once: the menu was opened last.
    fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("heading", { name: "New skill", level: 1 })).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Standup notes");
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
  });

  it("with a team skill open it closes the detail and stays in Skills", async () => {
    setup({ rows: [meta("a", { title: "Alpha" })] });
    renderApp();
    await openSkills();
    await openTeamTab();
    fireEvent.click(await screen.findByRole("button", { name: 'View "Alpha"' }));
    expect(await screen.findByRole("heading", { name: "Alpha", level: 2 })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("heading", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Settings sections" })).toBeTruthy();
  });

  it("with nothing open it leaves Settings, like every other section", async () => {
    setup({ rows: [meta("a", { title: "Alpha" })], skills: [weekly()] });
    renderApp();
    await openSkills();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(screen.queryByRole("navigation", { name: "Settings sections" })).toBeNull();
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeTruthy();
  });

  it("round 14 (C12): the purpose field keeps its activation guide visible", async () => {
    setup({ skills: [weekly()] });
    renderApp();
    await openSkills();
    fireEvent.click(await screen.findByRole("button", { name: "New skill" }));
    const purpose = await screen.findByRole("textbox", { name: "What it is for" });
    expect(purpose.getAttribute("placeholder")).toBe("e.g. Write the weekly report from my notes");
    expect(purpose.getAttribute("aria-describedby")).toBe("skill-purpose-hint");
    expect(document.getElementById("skill-purpose-hint")?.textContent).toBe(
      'Describe what it does and when to use it: start with "Use when…"',
    );
  });
});

describe("Team library errors", () => {
  it("404: the org has shared skills off", async () => {
    setup({ list: () => ({ status: 404 }) });
    renderApp();
    await openSkills();
    await openTeamTab();
    expect(await screen.findByText("Your organization does not have shared skills turned on.")).toBeTruthy();
  });

  it("404 in Spanish", async () => {
    setup({ list: () => ({ status: 404 }) });
    renderApp("es");
    await openSkills("Ajustes", "Skills");
    await openTeamTab("Equipo");
    expect(await screen.findByText("Tu organización no tiene skills compartidas activadas")).toBeTruthy();
  });

  it("429: a gentle wait a moment", async () => {
    setup({ list: () => ({ status: 429 }) });
    renderApp();
    await openSkills();
    await openTeamTab();
    expect(await screen.findByText("Wait a moment and try again.")).toBeTruthy();
  });

  it("401: the session-expired flow", async () => {
    setup({ list: () => ({ status: 401 }) });
    renderApp();
    await openSkills();
    await openTeamTab();
    expect(await screen.findByText("Your session has expired.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
  });
});

describe("Share with my team: failures say what went wrong (round 16, P3)", () => {
  async function shareAndFail(opts: Setup, locale: Locale = "en"): Promise<HTMLElement> {
    setup({ sharing: true, skills: [weekly()], ...opts });
    renderApp(locale);
    await openSkills(locale === "es" ? "Ajustes" : "Settings");
    const share = locale === "es" ? "Compartir «Weekly report» con el equipo" : 'Share "Weekly report" with my team';
    fireEvent.click(await screen.findByRole("button", { name: share }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: locale === "es" ? "Compartir" : "Share" }));
    });
    return within(dialog).findByTestId("share-problem");
  }

  it("a server validation refusal names the file and the rule, like a local save", async () => {
    const line = await shareAndFail({
      publish: () => ({
        status: 400,
        body: {
          error: "secret_detected",
          detail: '"references/creds.md" looks like it contains a credential (credential_assignment); remove it and publish again',
        },
      }),
    });
    expect(line.textContent).toContain("references/creds.md seems to contain credentials");
    expect(line.textContent).not.toContain("Could not reach your team");
  });

  it("a core bundle refusal reads its SkillError reason", async () => {
    const line = await shareAndFail({
      core: {
        skills_team_request: (args) => {
          if (args?.method === "POST") {
            throw {
              code: "bundle",
              detail: "Bundle { reason: FileTooLarge }",
              reason: { code: "file_too_large", path: "references/helmcode-brandbook.md" },
            };
          }
          if (args?.path === "/api/auth/me") {
            return { status: 200, etag: null, body: { featureFlags: ["skills_sharing"], skillsSharing: true } };
          }
          return { status: 200, etag: null, body: { skills: [] } };
        },
      },
    });
    expect(line.textContent).toContain("helmcode-brandbook.md is too large (64 KB at most).");
  });

  it("a title over the library cap says the cap", async () => {
    const line = await shareAndFail({
      publish: () => ({ status: 400, body: { error: "invalid_title", detail: "title must be 1..80 characters" } }),
    });
    expect(line.textContent).toBe("To share it, the name must be 80 characters at most.");
  });

  it("rate limited, stale and name taken have their own words", async () => {
    expect((await shareAndFail({ publish: () => ({ status: 429, body: { error: "rate_limited" } }) })).textContent).toBe(
      "Wait a moment and try again.",
    );
    cleanup();
    expect(
      (await shareAndFail({ publish: () => ({ status: 409, body: { error: "not_pending" } }) })).textContent,
    ).toContain("changed in your team's library meanwhile");
    cleanup();
    expect(
      (await shareAndFail({ publish: () => ({ status: 409, body: { error: "name_taken" } }) })).textContent,
    ).toContain("already has a skill with this name");
    cleanup();
    expect(
      (
        await shareAndFail({
          publish: () => ({ status: 429, body: { error: "pending_limit_reached", detail: "at most 20 skills can await review" } }),
        })
      ).textContent,
    ).toContain("too many skills awaiting review");
  });

  it("an unknown failure says the SHARE failed (not 'loading') and shows the detail", async () => {
    const line = await shareAndFail({ publish: () => ({ status: 500, body: { error: "internal_error" } }) }, "es");
    expect(line.textContent).toContain("No se ha podido compartir la skill.");
    expect(line.textContent).not.toContain("cargar las skills");
    expect(line.querySelector(".share-problem-detail")?.textContent).toBe("Detalle: HTTP 500 internal_error");
  });

  it("offline says to check the network, without the 'last saved copy' line of the library", async () => {
    const line = await shareAndFail({ publish: () => ({ fail: "offline" }) });
    expect(line.textContent).toBe("No connection. Check your network and try again.");
  });
});
