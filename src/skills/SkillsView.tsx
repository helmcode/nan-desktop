// The Skills view (T14/S1): the user's own local skills. A list (use, edit,
// delete) and a three-field form (name, what it is for, instructions) plus
// optional reference files. The user never sees the generated SKILL.md or
// its frontmatter: the core generates it from these fields on every save.

import { useRef, useState } from "react";
import { useT } from "../i18n";
import { IconArrowLeft, IconBolt, IconFile, IconPencil, IconPlus, IconTrash, IconX } from "../icons";
import {
  REFERENCE_ACCEPT,
  addReferenceFiles,
  checkDraft,
  createSkill,
  deleteSkill,
  draftFromSkill,
  emptyDraft,
  skillErrorText,
  updateSkill,
  type Skill,
  type SkillDraft,
} from "./skills";

export type SkillsViewProps = {
  skills: Skill[];
  /** The skills could not be listed. */
  loadError: boolean;
  /** The open form (null shows the list). Owned by the shell so "Save as
   *  skill" in a chat can open it preloaded. */
  form: SkillDraft | null;
  onFormChange: (form: SkillDraft | null) => void;
  onSaved: (skill: Skill) => void;
  onDeleted: (id: string) => void;
  onUse: (skill: Skill) => void;
  onBack: () => void;
};

export function SkillsView({
  skills,
  loadError,
  form,
  onFormChange,
  onSaved,
  onDeleted,
  onUse,
  onBack,
}: SkillsViewProps) {
  const t = useT();
  const s = t.skills;
  const [armedId, setArmedId] = useState<string | null>(null);
  const [listError, setListError] = useState("");

  const remove = async (skill: Skill): Promise<void> => {
    if (armedId !== skill.id) {
      setArmedId(skill.id);
      return;
    }
    setArmedId(null);
    try {
      await deleteSkill(skill.id);
      setListError("");
      onDeleted(skill.id);
    } catch {
      setListError(s.errors.delete);
    }
  };

  return (
    <section className="settings skills-view" aria-labelledby="skills-title">
      <header className="settings-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={form ? () => onFormChange(null) : onBack}>
          <IconArrowLeft size={16} />
          {form ? s.title : s.back}
        </button>
        <h1 id="skills-title">{form ? (form.id ? s.formEditTitle : s.formNewTitle) : s.title}</h1>
        {!form && <p className="section-lede">{s.intro}</p>}
      </header>
      <div className="settings-body">
        {form ? (
          <SkillForm form={form} onChange={onFormChange} onSaved={onSaved} />
        ) : (
          <>
            {loadError && (
              <p className="inline-error" role="alert">
                {s.errors.load}
              </p>
            )}
            {listError && (
              <p className="inline-error" role="alert">
                {listError}
              </p>
            )}
            {skills.length === 0 ? (
              <div className="skills-empty">
                <IconBolt size={28} />
                <p className="empty-title">{s.emptyTitle}</p>
                <p className="empty-hint">{s.emptyHint}</p>
                <button type="button" className="btn btn-primary" onClick={() => onFormChange(emptyDraft())}>
                  <IconPlus size={16} />
                  {s.create}
                </button>
              </div>
            ) : (
              <>
                <div className="skills-toolbar">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => onFormChange(emptyDraft())}>
                    <IconPlus size={16} />
                    {s.newSkill}
                  </button>
                </div>
                <ul className="grant-list skills-list" aria-label={s.title}>
                  {skills.map((skill) => {
                    const armed = armedId === skill.id;
                    return (
                      <li key={skill.id} className="grant-card skill-card">
                        <div className="skill-text">
                          <p className="skill-title">{skill.title}</p>
                          <p className="skill-description">{skill.description}</p>
                        </div>
                        <div className="grant-actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            aria-label={s.useLabel(skill.title)}
                            onClick={() => onUse(skill)}
                          >
                            {s.use}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            aria-label={s.editLabel(skill.title)}
                            onClick={() => onFormChange(draftFromSkill(skill))}
                          >
                            <IconPencil size={14} />
                            {s.edit}
                          </button>
                          <button
                            type="button"
                            className={`btn btn-sm ${armed ? "btn-danger" : "btn-ghost"}`}
                            aria-label={armed ? s.deleteArmedLabel(skill.title) : s.deleteLabel(skill.title)}
                            onClick={() => void remove(skill)}
                            onBlur={() => armed && setArmedId(null)}
                          >
                            {armed ? s.deleteArmed : <IconTrash size={14} />}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function SkillForm({
  form,
  onChange,
  onSaved,
}: {
  form: SkillDraft;
  onChange: (form: SkillDraft | null) => void;
  onSaved: (skill: Skill) => void;
}) {
  const t = useT();
  const s = t.skills;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const set = (patch: Partial<SkillDraft>): void => onChange({ ...form, ...patch });

  const attach = async (list: FileList | null): Promise<void> => {
    if (!list || list.length === 0) return;
    const { references, problem } = await addReferenceFiles(form.references, Array.from(list));
    set({ references });
    setError(problem ? skillErrorText(t, problem) : "");
    if (fileInput.current) fileInput.current.value = "";
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    const input = {
      title: form.title,
      description: form.description,
      instructions: form.instructions,
      references: form.references,
    };
    const problem = checkDraft(input);
    if (problem) {
      setError(skillErrorText(t, problem));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = form.id ? await updateSkill(form.id, input) : await createSkill(input);
      onSaved(saved);
    } catch (err) {
      setError(skillErrorText(t, err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="skill-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {form.fromChat && (
        <p className="skill-review-hint" role="note">
          {s.reviewHint}
        </p>
      )}
      <label className="skill-field">
        <span className="skill-label">{s.nameLabel}</span>
        <input
          type="text"
          className="text-input"
          value={form.title}
          placeholder={s.namePlaceholder}
          maxLength={120}
          onChange={(e) => set({ title: e.currentTarget.value })}
        />
      </label>
      <label className="skill-field">
        <span className="skill-label">{s.purposeLabel}</span>
        <input
          type="text"
          className="text-input"
          value={form.description}
          placeholder={s.purposePlaceholder}
          maxLength={1024}
          onChange={(e) => set({ description: e.currentTarget.value })}
        />
      </label>
      <label className="skill-field">
        <span className="skill-label">{s.instructionsLabel}</span>
        <textarea
          className="text-input skill-instructions"
          value={form.instructions}
          placeholder={s.instructionsPlaceholder}
          rows={12}
          onChange={(e) => set({ instructions: e.currentTarget.value })}
        />
      </label>
      <span className="skill-hint">{s.instructionsHint}</span>

      <div className="skill-field">
        <span className="skill-label">{s.filesLabel}</span>
        <span className="skill-hint">{s.filesHint}</span>
        {form.references.length > 0 && (
          <ul className="skill-files">
            {form.references.map((reference) => (
              <li key={reference.name} className="skill-file">
                <IconFile size={14} />
                <span className="skill-file-name">{reference.name}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={s.removeFile(reference.name)}
                  title={s.removeFile(reference.name)}
                  onClick={() => set({ references: form.references.filter((r) => r.name !== reference.name) })}
                >
                  <IconX size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInput.current?.click()}>
            <IconPlus size={14} />
            {s.addFiles}
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={REFERENCE_ACCEPT}
            className="visually-hidden"
            tabIndex={-1}
            aria-label={s.addFiles}
            onChange={(e) => void attach(e.currentTarget.files)}
          />
        </div>
      </div>

      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="skill-form-actions">
        <button type="button" className="btn btn-ghost" onClick={() => onChange(null)}>
          {s.cancel}
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? s.saving : s.save}
        </button>
      </div>
    </form>
  );
}
