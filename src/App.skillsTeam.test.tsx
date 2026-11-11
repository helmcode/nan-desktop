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
import { fakeTeamCore, localBundleOf, meta, wireSkill, type ApiReply, type ApiRequest } from "./test/teamMock";

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
      return { status: 200, body: { email: "ana@example.com", ...(opts.sharing ? { skills_sharing: true } : {}) } };
    }
    if (req.method === "GET" && req.path === "/api/skills") {
      const override = opts.list?.(req);
      if (override) return override;
      const etag = `"v${version}"`;
      if (req.ifNoneMatch === etag) return { status: 304, etag };
      return { status: 200, etag, body: { skills: rows, etag } };
    }
    const id = req.path.slice("/api/skills/".length);
    if (req.method === "GET") {
      const override = opts.bundle?.(req);
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
      return found ? { status: 200, body: wireSkill(found, opts.instructions?.[id]) } : { status: 404 };
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
  });
  return { core, rows, created: () => created };
}

function renderApp(locale: Locale = "en") {
  return render(
    <I18nProvider initial={locale}>
      <App />
    </I18nProvider>,
  );
}

async function openSkills(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
  await screen.findByRole("heading", { name: "Skills", level: 1 });
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

  it("is hidden on Helmcode when the org flag is off (the Team tab still exists)", async () => {
    const { core } = setup({ sharing: false, skills: [weekly()] });
    renderApp();
    await openSkills();
    await waitFor(() => expect(core.requests.some((r) => r.path === "/api/auth/me")).toBe(true));
    expect(await screen.findByRole("tab", { name: "Team" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /with my team/ })).toBeNull();
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
    expect(post?.body).toEqual({ files: localBundleOf(skill).files });
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

  it("speaks Spanish: the button, the dialog warning and the tabs", async () => {
    setup({ sharing: true, skills: [weekly()] });
    renderApp("es");
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    expect(await screen.findByRole("tab", { name: "Mías" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Equipo" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Compartir «Weekly report» con mi equipo" }));
    const dialog = await screen.findByRole("dialog", { name: "Compartir con mi equipo" });
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

  it("cached team skills are offered in the composer picker", async () => {
    setup({ rows });
    renderApp();
    await screen.findByText("Summarize my notes weekly");
    await waitFor(() => expect(invokedWith("skills_team_cache_put").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole("button", { name: "Use skill" }));
    const list = await screen.findByRole("listbox", { name: "Your skills" });
    expect(within(list).getByText("Beta")).toBeTruthy();
    expect(within(list).getByText("Alpha")).toBeTruthy();
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

  it("speaks Spanish: the preparing badge", async () => {
    setup({ rows: [meta("a", { title: "Alpha" })], bundle: () => ({ status: 429 }) });
    renderApp("es");
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
    await openTeamTab("Equipo");
    expect(await screen.findByText("Se está preparando…")).toBeTruthy();
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
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));
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
