// Local skills (T14, slice S1): types, IPC wrappers and the pure helpers the
// Skills view, the composer's "Use skill" picker and "Save as skill" share.
//
// The Rust core owns the store and the validation (src-tauri/src/skills.rs);
// the checks here only give the user an early, localized answer. A skill is
// TEXT: turning it on only sends its id with `chat_send`, and the core adds
// its instructions to that reply's context as a delimited block. It never
// touches tools, folders, approvals or the model.

import { invoke } from "@tauri-apps/api/core";
import type { Strings } from "../i18n";

export type ReferenceFile = { name: string; content: string };

export type Skill = {
  id: string;
  /** Generated agentskills name (slug). Never shown to the user. */
  name: string;
  title: string;
  description: string;
  instructions: string;
  references: ReferenceFile[];
  created_at: number;
  updated_at: number;
};

export type SkillInput = {
  title: string;
  description: string;
  instructions: string;
  references: ReferenceFile[];
};

/** What the form starts from: empty, an existing skill, or a chat. */
export type SkillDraft = SkillInput & {
  id: string | null;
  fromChat: boolean;
  /** Round 15 (F4): the model distilled it (save_chat_as_skill), not the template. */
  distilled?: boolean;
};

export const MAX_REFERENCES = 5;
export const MAX_REFERENCE_BYTES = 64 * 1024;
export const MAX_SKILL_MD_BYTES = 64 * 1024;
export const MAX_BUNDLE_BYTES = 256 * 1024;
export const MAX_TITLE_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 1024;

/** A title as the core stores it: whitespace collapsed to single spaces, NFC. */
export function cleanTitle(title: string): string {
  return title.split(/\s+/).filter(Boolean).join(" ").normalize("NFC");
}

/** How two titles compare for duplicates: clean and in any case. */
function titleKey(title: string): string {
  return cleanTitle(title).toLowerCase();
}

/**
 * The title a NEW skill will be saved with (mirror of skills.rs
 * `unique_title`): the title itself, or `Title 2`, `Title 3`... when another
 * skill already shows it, so the picker never lists two identical entries.
 * Shown in the form before saving; the core decides.
 */
export function resolvedTitle(title: string, existing: Array<Pick<Skill, "title">>): string {
  const clean = cleanTitle(title);
  const taken = new Set(existing.map((skill) => titleKey(skill.title)));
  if (!clean || !taken.has(titleKey(clean))) return clean;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const stem = [...clean].slice(0, MAX_TITLE_CHARS - suffix.length).join("").trimEnd();
    const candidate = `${stem}${suffix}`;
    if (!taken.has(titleKey(candidate))) return candidate;
  }
}
export const REFERENCE_EXTENSIONS = ["md", "txt", "json", "yaml", "yml"] as const;
/** The file input's `accept` attribute. */
export const REFERENCE_ACCEPT = REFERENCE_EXTENSIONS.map((ext) => `.${ext}`).join(",");
/** Generous room for the generated frontmatter around the instructions. */
const FRONTMATTER_ROOM = MAX_DESCRIPTION_CHARS * 4 + 256;

// ------------------------------------------------------------------ IPC --

export function listSkills(): Promise<Skill[]> {
  return invoke<Skill[]>("skills_list");
}

export function createSkill(input: SkillInput): Promise<Skill> {
  return invoke<Skill>("skills_create", { input });
}

export function updateSkill(id: string, input: SkillInput): Promise<Skill> {
  return invoke<Skill>("skills_update", { id, input });
}

export function deleteSkill(id: string): Promise<void> {
  return invoke<void>("skills_delete", { id });
}

// --------------------------------------------------------------- drafts --

export function emptyDraft(): SkillDraft {
  return { id: null, title: "", description: "", instructions: "", references: [], fromChat: false };
}

export function draftFromSkill(skill: Skill): SkillDraft {
  return {
    id: skill.id,
    title: skill.title,
    description: skill.description,
    instructions: skill.instructions,
    references: skill.references.map((reference) => ({ ...reference })),
    fromChat: false,
  };
}

/**
 * "Save as skill" on a conversation: the instructions start from the
 * conversation's first system or user message, for the user to review.
 */
export function preloadFromConversation(messages: ReadonlyArray<{ role: string; content: string }>): string {
  const first = messages.find((m) => (m.role === "system" || m.role === "user") && m.content.trim().length > 0);
  return first ? first.content.trim() : "";
}

export function draftFromConversation(messages: ReadonlyArray<{ role: string; content: string }>): SkillDraft {
  return { ...emptyDraft(), instructions: preloadFromConversation(messages), fromChat: true };
}

/** What the core sends on `chat://skill_draft` (tools/save_skill.rs). */
export type DistilledDraft = { title: string; description: string; instructions: string };

/** A draft the model distilled with `save_chat_as_skill`, for the save form. */
export function draftFromDistilled(draft: DistilledDraft): SkillDraft {
  return {
    ...emptyDraft(),
    title: draft.title,
    description: draft.description,
    instructions: draft.instructions,
    fromChat: true,
    distilled: true,
  };
}

/**
 * Round 15 (F4): the form a finished turn opens. The model's distilled
 * draft wins; when "Save as skill" asked for one and the model never called
 * the tool (or the turn failed), the deterministic template is the
 * fallback; otherwise nothing opens.
 */
export function settleSkillDraft(
  distilled: DistilledDraft | undefined,
  awaiting: boolean,
  messages: ReadonlyArray<{ role: string; content: string }>,
): SkillDraft | null {
  if (distilled) return draftFromDistilled(distilled);
  return awaiting ? draftFromConversation(messages) : null;
}

// ------------------------------------------------- per-conversation state --

/** The skill turned on per conversation key (the blank chat has its own). */
export type ActiveSkills = ReadonlyMap<number, string>;

/** The skill on in `key`, if it still exists. */
export function activeSkillFor(active: ActiveSkills, key: number, skills: readonly Skill[]): Skill | null {
  const id = active.get(key);
  return id === undefined ? null : (skills.find((skill) => skill.id === id) ?? null);
}

/** Turn a skill on (an id) or off (null) for `key`. */
export function withActiveSkill(active: ActiveSkills, key: number, id: string | null): Map<number, string> {
  const next = new Map(active);
  if (id === null) next.delete(key);
  else next.set(key, id);
  return next;
}

/** The blank chat's skill moves to the conversation row created for it. */
export function adoptActiveSkill(active: ActiveSkills, from: number, to: number): ActiveSkills {
  const id = active.get(from);
  if (id === undefined) return active;
  const next = new Map(active);
  next.delete(from);
  next.set(to, id);
  return next;
}

/** A deleted skill is turned off everywhere. */
export function withoutSkill(active: ActiveSkills, id: string): ActiveSkills {
  if (![...active.values()].includes(id)) return active;
  return new Map([...active].filter(([, value]) => value !== id));
}

/** The saved skill replaces its old copy, or goes first when new. */
export function upsertSkill(skills: readonly Skill[], saved: Skill): Skill[] {
  return [saved, ...skills.filter((skill) => skill.id !== saved.id)];
}

// ------------------------------------------------------------ the picker --

/**
 * The "/" picker query: the composer starts with "/" and the rest is one
 * word so far ("/inf" -> "inf", "/" -> ""). Anything else is a message.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

/** Lowercase without accents, so "revision" finds "Revisión". */
export function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** Skills whose title, description or name contain the query. */
export function filterSkills(skills: readonly Skill[], query: string): Skill[] {
  const q = fold(query.trim());
  if (!q) return [...skills];
  return skills.filter((skill) => [skill.title, skill.description, skill.name].some((field) => fold(field).includes(q)));
}

// ------------------------------------------------------------ validation --

const encoder = new TextEncoder();

export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export type FormProblem =
  | { code: "title_empty" | "title_too_long" | "description_empty" | "description_too_long" | "instructions_empty" }
  | { code: "too_large" | "bundle_too_large" };

/** The early, client-side check of the form (the core checks again). */
export function checkDraft(draft: SkillInput): FormProblem | null {
  const title = draft.title.trim();
  if (!title) return { code: "title_empty" };
  if ([...title].length > MAX_TITLE_CHARS) return { code: "title_too_long" };
  const description = draft.description.trim();
  if (!description) return { code: "description_empty" };
  if ([...description].length > MAX_DESCRIPTION_CHARS) return { code: "description_too_long" };
  const instructions = draft.instructions.trim();
  if (!instructions) return { code: "instructions_empty" };
  if (byteLength(instructions) > MAX_SKILL_MD_BYTES - FRONTMATTER_ROOM / 4) return { code: "too_large" };
  const total =
    byteLength(instructions) +
    draft.references.reduce((sum, reference) => sum + byteLength(reference.content), 0);
  if (total > MAX_BUNDLE_BYTES - FRONTMATTER_ROOM) return { code: "bundle_too_large" };
  return null;
}

export type FileProblem = {
  code: "extension" | "file_too_large" | "not_text" | "file_invalid" | "too_many_files" | "duplicate";
  name: string;
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** A file's bytes (FileReader where `Blob.arrayBuffer` is missing). */
function fileBytes(file: Blob): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Read one picked file as a reference: allowlisted extension, at most
 * 64 KiB, strict UTF-8 without NUL, a plain file name (no dotfile).
 */
export async function readReferenceFile(file: File): Promise<ReferenceFile | FileProblem> {
  const name = file.name.normalize("NFC");
  if (!name || name.startsWith(".") || /[/\\]/.test(name)) return { code: "file_invalid", name };
  if (!(REFERENCE_EXTENSIONS as readonly string[]).includes(extensionOf(name))) return { code: "extension", name };
  if (file.size > MAX_REFERENCE_BYTES) return { code: "file_too_large", name };
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await fileBytes(file)));
  } catch {
    return { code: "not_text", name };
  }
  if (content.includes("\0")) return { code: "not_text", name };
  return { name, content };
}

/** Add picked files to the current list (count cap, no duplicate names). */
export async function addReferenceFiles(
  current: readonly ReferenceFile[],
  files: readonly File[],
): Promise<{ references: ReferenceFile[]; problem: FileProblem | null }> {
  const references = [...current];
  let problem: FileProblem | null = null;
  for (const file of files) {
    if (references.length >= MAX_REFERENCES) {
      problem = { code: "too_many_files", name: file.name };
      break;
    }
    const read = await readReferenceFile(file);
    if ("code" in read) {
      problem = read;
      continue;
    }
    if (references.some((reference) => reference.name === read.name)) {
      problem = { code: "duplicate", name: read.name };
      continue;
    }
    references.push(read);
  }
  return { references, problem };
}

// --------------------------------------------------------------- errors --

/** The core's refusal shape `{ code, path? }`, or a local `{ code, name }`. */
type CoreError = { code: string; path?: string; name?: string };

function asCoreError(err: unknown): CoreError | null {
  if (err && typeof err === "object" && typeof (err as CoreError).code === "string") return err as CoreError;
  return null;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/** Localized text for a form problem, a file problem or a core refusal. */
export function skillErrorText(t: Strings, err: unknown): string {
  const e = t.skills.errors;
  const core = asCoreError(err);
  if (!core) return e.generic;
  const name = baseName(core.path ?? core.name ?? "");
  switch (core.code) {
    case "title_empty":
      return e.titleEmpty;
    case "title_too_long":
      return e.titleTooLong;
    case "description_empty":
      return e.descriptionEmpty;
    case "description_too_long":
      return e.descriptionTooLong;
    case "instructions_empty":
      return e.instructionsEmpty;
    case "too_large":
      return e.tooLarge;
    case "bundle_too_large":
      return e.bundleTooLarge;
    case "too_many_files":
      return e.tooManyFiles;
    case "secret_detected":
      return e.secretDetected(core.path ?? "SKILL.md");
    case "file_too_large":
      return core.path === "SKILL.md" ? e.tooLarge : e.fileTooLarge(name);
    case "extension":
    case "extension_not_allowed":
      return e.extension(name);
    case "not_text":
    case "not_utf8":
    case "contains_nul":
      return e.notText(name);
    case "duplicate":
    case "duplicate_file":
      return e.duplicate(name);
    case "file_invalid":
    case "path_invalid":
    case "path_not_nfc":
      return e.fileInvalid(name);
    case "not_found":
      return e.notFound;
    default:
      return e.generic;
  }
}
