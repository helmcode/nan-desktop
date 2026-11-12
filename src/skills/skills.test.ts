// Local skills (T14/S1): the pure helpers behind the Skills view, the
// composer picker and "Save as skill".
import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { es } from "../i18n/es";
import {
  MAX_REFERENCE_BYTES,
  REFERENCE_ACCEPT,
  activeSkillFor,
  addReferenceFiles,
  adoptActiveSkill,
  checkDraft,
  draftFromConversation,
  draftFromDistilled,
  draftFromSkill,
  emptyDraft,
  filterSkills,
  fold,
  preloadFromConversation,
  readReferenceFile,
  resolvedTitle,
  settleSkillDraft,
  skillErrorText,
  slashQuery,
  upsertSkill,
  withActiveSkill,
  withoutSkill,
  type Skill,
} from "./skills";

function skill(id: string, title: string, extra: Partial<Skill> = {}): Skill {
  return {
    id,
    name: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    description: `${title} description`,
    instructions: `${title} instructions`,
    references: [],
    created_at: 1,
    updated_at: 1,
    ...extra,
  };
}

function textFile(name: string, content: string | Uint8Array): File {
  return new File([content as BlobPart], name, { type: "text/plain" });
}

describe("the / picker query", () => {
  it("is the word typed after a leading slash", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/inf")).toBe("inf");
    expect(slashQuery("/Revisión")).toBe("Revisión");
  });

  it("is null for anything that is a message", () => {
    expect(slashQuery("")).toBeNull();
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery(" /inf")).toBeNull();
    expect(slashQuery("/inf now")).toBeNull();
    expect(slashQuery("/inf\n")).toBeNull();
  });

  it("filters by title, description or name, ignoring case and accents", () => {
    const list = [skill("a", "Revisión de código"), skill("b", "Informe semanal", { description: "Weekly notes" })];
    expect(fold("Revisión")).toBe("revision");
    expect(filterSkills(list, "").map((s) => s.id)).toEqual(["a", "b"]);
    expect(filterSkills(list, "REVISION").map((s) => s.id)).toEqual(["a"]);
    expect(filterSkills(list, "weekly").map((s) => s.id)).toEqual(["b"]);
    expect(filterSkills(list, "informe-sem").map((s) => s.id)).toEqual(["b"]);
    expect(filterSkills(list, "nothing")).toEqual([]);
  });
});

describe("Save as skill (preload)", () => {
  it("starts from the conversation's first system or user message", () => {
    expect(
      preloadFromConversation([
        { role: "assistant", content: "Hi!" },
        { role: "user", content: "  Write the weekly report from these notes.  " },
        { role: "user", content: "second" },
      ]),
    ).toBe("Write the weekly report from these notes.");
    expect(preloadFromConversation([{ role: "system", content: "Be formal." }, { role: "user", content: "x" }])).toBe(
      "Be formal.",
    );
    expect(preloadFromConversation([{ role: "user", content: "  " }, { role: "user", content: "real" }])).toBe("real");
    expect(preloadFromConversation([])).toBe("");
  });

  it("opens a new draft marked as coming from a chat", () => {
    const draft = draftFromConversation([{ role: "user", content: "Do X" }]);
    expect(draft).toEqual({ ...emptyDraft(), instructions: "Do X", fromChat: true });
    expect(draft.id).toBeNull();
  });

  it("edit opens the skill's own fields (edit = regenerate)", () => {
    const s = skill("a", "Tone", { references: [{ name: "a.md", content: "x" }] });
    const draft = draftFromSkill(s);
    expect(draft).toEqual({
      id: "a",
      title: "Tone",
      description: "Tone description",
      instructions: "Tone instructions",
      references: [{ name: "a.md", content: "x" }],
      fromChat: false,
    });
    expect(draft.references[0]).not.toBe(s.references[0]);
  });
});

describe("form checks", () => {
  const ok = { title: "T", description: "D", instructions: "I", references: [] };

  it("accepts a complete form", () => {
    expect(checkDraft(ok)).toBeNull();
  });

  it("asks for every field", () => {
    expect(checkDraft({ ...ok, title: " " })).toEqual({ code: "title_empty" });
    expect(checkDraft({ ...ok, description: "" })).toEqual({ code: "description_empty" });
    expect(checkDraft({ ...ok, instructions: "\n" })).toEqual({ code: "instructions_empty" });
    expect(checkDraft({ ...ok, title: "t".repeat(121) })).toEqual({ code: "title_too_long" });
    expect(checkDraft({ ...ok, description: "d".repeat(1025) })).toEqual({ code: "description_too_long" });
  });

  it("rejects 100 KiB of instructions", () => {
    expect(checkDraft({ ...ok, instructions: "a".repeat(100 * 1024) })).toEqual({ code: "too_large" });
  });

  it("rejects a bundle over 256 KiB with its files", () => {
    const big = "a".repeat(MAX_REFERENCE_BYTES);
    const references = [1, 2, 3, 4].map((n) => ({ name: `${n}.md`, content: big }));
    expect(checkDraft({ ...ok, instructions: "a".repeat(40 * 1024), references })).toEqual({
      code: "bundle_too_large",
    });
  });
});

describe("reference files", () => {
  it("accepts the allowlisted text files", async () => {
    expect(REFERENCE_ACCEPT).toBe(".md,.txt,.json,.yaml,.yml");
    for (const name of ["a.md", "b.txt", "c.json", "d.yaml", "e.yml", "F.MD"]) {
      expect(await readReferenceFile(textFile(name, "hola"))).toEqual({ name, content: "hola" });
    }
  });

  it("refuses other extensions, dotfiles, oversize, non-UTF-8 and NUL", async () => {
    expect(await readReferenceFile(textFile("run.sh", "x"))).toEqual({ code: "extension", name: "run.sh" });
    expect(await readReferenceFile(textFile("notes", "x"))).toEqual({ code: "extension", name: "notes" });
    expect(await readReferenceFile(textFile(".env.md", "x"))).toEqual({ code: "file_invalid", name: ".env.md" });
    expect(await readReferenceFile(textFile("big.md", "a".repeat(MAX_REFERENCE_BYTES + 1)))).toEqual({
      code: "file_too_large",
      name: "big.md",
    });
    expect(await readReferenceFile(textFile("bin.md", new Uint8Array([0xff, 0xfe, 0x00])))).toEqual({
      code: "not_text",
      name: "bin.md",
    });
    expect(await readReferenceFile(textFile("nul.md", "a\0b"))).toEqual({ code: "not_text", name: "nul.md" });
  });

  it("normalizes names to NFC", async () => {
    const read = await readReferenceFile(textFile("guía.md", "x"));
    expect(read).toEqual({ name: "guía.md", content: "x" });
  });

  it("keeps at most five and no duplicate names", async () => {
    const five = [1, 2, 3, 4, 5].map((n) => textFile(`${n}.md`, "x"));
    const full = await addReferenceFiles([], five);
    expect(full.references.map((r) => r.name)).toEqual(["1.md", "2.md", "3.md", "4.md", "5.md"]);
    expect(full.problem).toBeNull();
    const sixth = await addReferenceFiles(full.references, [textFile("6.md", "x")]);
    expect(sixth.references).toHaveLength(5);
    expect(sixth.problem).toEqual({ code: "too_many_files", name: "6.md" });
    const dup = await addReferenceFiles([{ name: "1.md", content: "x" }], [textFile("1.md", "y"), textFile("2.md", "z")]);
    expect(dup.references.map((r) => r.name)).toEqual(["1.md", "2.md"]);
    expect(dup.problem).toEqual({ code: "duplicate", name: "1.md" });
  });
});

describe("per-conversation active skill", () => {
  const list = [skill("a", "A"), skill("b", "B")];

  it("turns a skill on and off for one conversation only", () => {
    let active = withActiveSkill(new Map(), 7, "a");
    expect(activeSkillFor(active, 7, list)?.id).toBe("a");
    expect(activeSkillFor(active, 8, list)).toBeNull();
    active = withActiveSkill(active, 7, null);
    expect(activeSkillFor(active, 7, list)).toBeNull();
  });

  it("the blank chat's skill moves to its new row", () => {
    const active = adoptActiveSkill(withActiveSkill(new Map(), -1, "b"), -1, 12);
    expect(activeSkillFor(active, 12, list)?.id).toBe("b");
    expect(activeSkillFor(active, -1, list)).toBeNull();
    const none = new Map<number, string>();
    expect(adoptActiveSkill(none, -1, 12)).toBe(none);
  });

  it("a deleted or unknown skill is never active", () => {
    const active = withActiveSkill(withActiveSkill(new Map(), 7, "a"), 8, "b");
    expect(activeSkillFor(active, 7, [list[1]])).toBeNull();
    const pruned = withoutSkill(active, "a");
    expect([...pruned.entries()]).toEqual([[8, "b"]]);
  });

  it("a saved skill replaces its old copy and goes first", () => {
    const edited = skill("b", "B2");
    expect(upsertSkill(list, edited).map((s) => s.title)).toEqual(["B2", "A"]);
    expect(upsertSkill(list, skill("c", "C")).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });
});

describe("error texts", () => {
  it("round 14 (C13): the save form's guide reads in Spanish", () => {
    expect(es.skills.purposeHint).toContain("Úsala cuando");
    expect(es.skills.purposeHint).not.toContain("Use when");
    expect(es.skills.purposePlaceholder).not.toContain("Use when");
  });
  it("round 14: secret_detected names the file in en and es, defaulting to SKILL.md", () => {
    expect(skillErrorText(en, { code: "secret_detected", path: "references/a.md" })).toBe(
      en.skills.errors.secretDetected("references/a.md"),
    );
    expect(skillErrorText(es, { code: "secret_detected", path: "references/a.md" })).toBe(
      es.skills.errors.secretDetected("references/a.md"),
    );
    expect(skillErrorText(en, { code: "secret_detected" })).toBe(
      en.skills.errors.secretDetected("SKILL.md"),
    );
    expect(skillErrorText(es, { code: "secret_detected" })).toBe(
      es.skills.errors.secretDetected("SKILL.md"),
    );
    // The equality above would also hold if the template dropped its
    // placeholder; these pin the file name in the rendered text.
    expect(skillErrorText(en, { code: "secret_detected", path: "references/a.md" })).toContain("references/a.md");
    expect(skillErrorText(es, { code: "secret_detected", path: "references/a.md" })).toContain("references/a.md");
    expect(skillErrorText(en, { code: "secret_detected" })).toContain("SKILL.md");
    expect(skillErrorText(es, { code: "secret_detected" })).toContain("SKILL.md");
  });

  it("localizes the core's refusals and the local problems", () => {
    expect(skillErrorText(en, { code: "file_too_large", path: "SKILL.md" })).toBe(en.skills.errors.tooLarge);
    expect(skillErrorText(en, { code: "file_too_large", path: "references/a.md" })).toBe(
      en.skills.errors.fileTooLarge("a.md"),
    );
    expect(skillErrorText(en, { code: "extension_not_allowed", path: "references/x.sh" })).toBe(
      en.skills.errors.extension("x.sh"),
    );
    expect(skillErrorText(en, { code: "extension", name: "x.sh" })).toBe(en.skills.errors.extension("x.sh"));
    expect(skillErrorText(es, { code: "bundle_too_large" })).toBe(es.skills.errors.bundleTooLarge);
    expect(skillErrorText(es, { code: "not_found" })).toBe(es.skills.errors.notFound);
    expect(skillErrorText(en, new Error("boom"))).toBe(en.skills.errors.generic);
    expect(skillErrorText(en, { code: "something_new" })).toBe(en.skills.errors.generic);
  });
});

describe("resolvedTitle (round 15/F2, mirror of skills.rs unique_title)", () => {
  const taken = [{ title: "Informe" }, { title: "Informe 2" }, { title: "Otro" }];

  it("keeps a free title and suffixes a taken one past every taken suffix", () => {
    expect(resolvedTitle("Nuevo", taken)).toBe("Nuevo");
    expect(resolvedTitle("Informe", taken)).toBe("Informe 3");
    expect(resolvedTitle("Info", taken)).toBe("Info");
  });

  it("compares like the core: any case, collapsed whitespace, NFC", () => {
    expect(resolvedTitle("  otro ", taken)).toBe("otro 2");
    expect(resolvedTitle("Informe   semanal", [{ title: "informe semanal" }])).toBe("Informe semanal 2");
    expect(resolvedTitle("Revisión", [{ title: "Revisio\u0301n" }])).toBe("Revisión 2");
  });

  it("stays within the title limit and is empty for an empty title", () => {
    const long = "a".repeat(120);
    const out = resolvedTitle(long, [{ title: long }]);
    expect([...out].length).toBe(120);
    expect(out.endsWith(" 2")).toBe(true);
    expect(resolvedTitle("   ", taken)).toBe("");
  });
});

describe("save-as-skill drafts (round 15/F4)", () => {
  const rows = [
    { role: "assistant", content: "Hi" },
    { role: "user", content: "Summarize my notes weekly" },
  ];
  const distilled = { title: "T", description: "D. Use when: x.", instructions: "1. Step." };

  it("the model's draft prefills every field and is marked as distilled", () => {
    expect(draftFromDistilled(distilled)).toEqual({
      id: null,
      title: "T",
      description: "D. Use when: x.",
      instructions: "1. Step.",
      references: [],
      fromChat: true,
      distilled: true,
    });
  });

  it("settles to the model's draft, else the template when asked, else nothing", () => {
    expect(settleSkillDraft(distilled, true, rows)).toEqual(draftFromDistilled(distilled));
    expect(settleSkillDraft(distilled, false, rows)).toEqual(draftFromDistilled(distilled));
    expect(settleSkillDraft(undefined, true, rows)).toEqual(draftFromConversation(rows));
    expect(settleSkillDraft(undefined, true, rows)?.distilled).toBeUndefined();
    expect(settleSkillDraft(undefined, false, rows)).toBeNull();
  });

  it("has the request and the review hint in both languages", () => {
    expect(en.skills.distillPrompt).toBe("Save this conversation as a reusable skill.");
    expect(es.skills.distillPrompt).toBe("Guarda esta conversación como una skill reutilizable.");
    expect(en.skills.reviewHintDistilled).toContain("AI summarized");
    expect(es.skills.reviewHintDistilled).toContain("La IA ha resumido");
  });
});
