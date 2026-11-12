// The Skills view (T14/S1 + S4): the user's own local skills ("Mine": use,
// edit, delete, and "Share with my team" when the org allows it) and, on
// Helmcode, the team library ("Team": view, use, duplicate). A three-field
// form (name, what it is for, instructions) plus optional reference files;
// the user never sees the generated SKILL.md or its frontmatter.

import { useEffect, useRef, useState } from "react";
import { isTopLayer, useEscapeLayer } from "../escapeLayers";
import { useI18n, useT, type Strings } from "../i18n";
import { Markdown } from "../Markdown";
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
import {
  isBundleCached,
  loadTeamSkill,
  shareSkill,
  shareStateFor,
  teamLibrary,
  type ShareState,
  type TeamMeta,
  type TeamProblem,
  type TeamSkill,
  type TeamState,
} from "./team";

/** The team side of the view (Helmcode only; `null` hides all of it). */
export type TeamProps = {
  profileId: string;
  /** The org's `skills_sharing` flag: share is enabled only with it, shown
   *  disabled (with the reason) when it is off, and absent while unknown. */
  sharing: boolean | null;
  state: TeamState;
  onState: (state: TeamState) => void;
  onRetry: () => void;
  /** Turn a team skill on in the chat (its bundle is cached first). */
  onUse: (meta: TeamMeta) => void;
  /** The session-expired flow. */
  onSignIn: () => void;
};

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
  /** Where Back returns to (round 14/C1: the same label Settings uses). */
  backLabel?: string;
  /** S4: the team library and sharing. `null` (NaN) hides both. */
  team?: TeamProps | null;
};

type Tab = "mine" | "team";

/** True when the draft holds anything closing it would throw away. */
function draftHasContent(form: SkillDraft): boolean {
  return (
    form.title.trim() !== "" ||
    form.description.trim() !== "" ||
    form.instructions.trim() !== "" ||
    form.references.length > 0
  );
}

export function SkillsView({
  skills,
  loadError,
  form,
  onFormChange,
  onSaved,
  onDeleted,
  onUse,
  onBack,
  backLabel,
  team = null,
}: SkillsViewProps) {
  const t = useT();
  const s = t.skills;
  const [tab, setTab] = useState<Tab>("mine");
  const [armedId, setArmedId] = useState<string | null>(null);
  const [listError, setListError] = useState("");
  const [notice, setNotice] = useState("");
  const [sharing, setSharing] = useState<{ skill: Skill; reshare: boolean } | null>(null);
  const showTabs = !form && team !== null;
  const activeTab: Tab = showTabs ? tab : "mine";
  const formOpen = form !== null;
  const formFilled = form !== null && draftHasContent(form);
  const formLayer = useEscapeLayer(formOpen);

  // Round 14 (C2): Esc closes the form before it reaches the Settings surface,
  // which would otherwise exit Settings. Captured, so it runs before the
  // surface's own handler (B1/B2). Round 14 review (F1): a draft that holds
  // anything is never closed or wiped this way -- only its own Cancel/Back
  // button closes it -- and an Escape that cancels an IME composition is not a
  // dismissal at all. Round 14 review (F2): only the innermost open surface
  // consumes the key (see escapeLayers).
  useEffect(() => {
    if (!formOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (!isTopLayer(formLayer)) return;
      // Consumed either way, so the Settings surface behind the form stays put.
      e.preventDefault();
      if (!formFilled) onFormChange(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [formOpen, formFilled, formLayer, onFormChange]);

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

  const pickTab = (next: Tab): void => {
    setTab(next);
    setNotice("");
  };

  return (
    <section className="settings skills-view" aria-labelledby="skills-title">
      <header className="settings-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={form ? () => onFormChange(null) : onBack}>
          <IconArrowLeft size={16} />
          {form ? s.title : (backLabel ?? s.back)}
        </button>
        <h1 id="skills-title">{form ? (form.id ? s.formEditTitle : s.formNewTitle) : s.title}</h1>
        {!form && <p className="section-lede">{activeTab === "team" ? s.team.intro : s.intro}</p>}
        {showTabs && (
          <div className="skills-tabs" role="tablist" aria-label={s.team.tabsLabel}>
            {(["mine", "team"] as const).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`skills-tab-${key}`}
                aria-selected={activeTab === key}
                aria-controls={`skills-panel-${key}`}
                className={`skills-tab${activeTab === key ? " active" : ""}`}
                onClick={() => pickTab(key)}
              >
                {key === "mine" ? s.team.tabMine : s.team.tabTeam}
              </button>
            ))}
          </div>
        )}
      </header>
      <div
        className="settings-body"
        {...(showTabs ? { role: "tabpanel", id: `skills-panel-${activeTab}`, "aria-labelledby": `skills-tab-${activeTab}` } : {})}
      >
        {notice && (
          <p className="skills-notice" role="status">
            {notice}
          </p>
        )}
        {form ? (
          <SkillForm form={form} onChange={onFormChange} onSaved={onSaved} />
        ) : activeTab === "team" && team ? (
          <TeamPanel
            team={team}
            onUseTeam={team.onUse}
            onDuplicated={(created) => {
              onSaved(created);
              setTab("mine");
              setNotice(s.team.duplicated(created.title));
            }}
          />
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
                {team !== null && team.sharing === false && (
                  <p className="skill-hint" id="skills-share-off">
                    {s.team.shareOff}
                  </p>
                )}
                <ul className="grant-list skills-list" aria-label={s.title}>
                  {skills.map((skill) => {
                    const armed = armedId === skill.id;
                    const state: ShareState | null = team?.sharing ? shareStateFor(skill, team.state.view) : null;
                    const canShare = state !== null && state.kind === "local";
                    const canReshare = state !== null && state.kind !== "local" && state.edited;
                    // Round 15 (F3): on Helmcode the action is always visible;
                    // with the org flag off it is disabled and says why.
                    const shareOff = team !== null && team.sharing === false;
                    return (
                      <li key={skill.id} className="grant-card skill-card">
                        <div className="skill-text">
                          <p className="skill-title">
                            {skill.title}
                            {state && <ShareBadge state={state} />}
                          </p>
                          <p className="skill-description">{skill.description}</p>
                          {state && state.kind === "rejected" && state.reason && (
                            <p className="skill-share-note">{s.team.rejectReason(state.reason)}</p>
                          )}
                          {canReshare && <p className="skill-share-note">{s.team.editedNote}</p>}
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
                          {(canShare || canReshare) && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              aria-label={canShare ? s.team.shareLabel(skill.title) : s.team.reshareLabel(skill.title)}
                              onClick={() => setSharing({ skill, reshare: canReshare })}
                            >
                              {canShare ? s.team.share : s.team.reshare}
                            </button>
                          )}
                          {shareOff && (
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              disabled
                              aria-label={s.team.shareLabel(skill.title)}
                              aria-describedby="skills-share-off"
                              title={s.team.shareOff}
                            >
                              {s.team.share}
                            </button>
                          )}
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
      {sharing && team && (
        <ShareDialog
          skill={sharing.skill}
          reshare={sharing.reshare}
          team={team}
          onCancel={() => setSharing(null)}
          onShared={(title) => {
            setSharing(null);
            setNotice(s.team.shared(title));
          }}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------- sharing --

function ShareBadge({ state }: { state: ShareState }) {
  const s = useT().skills.team;
  const label =
    state.kind === "local"
      ? s.statusLocal
      : state.kind === "pending"
        ? s.statusPending
        : state.kind === "approved"
          ? s.statusApproved
          : state.kind === "rejected"
            ? s.statusRejected
            : s.statusHidden;
  return <span className={`skill-badge skill-badge-${state.kind}`}>{label}</span>;
}

/** Localized text for a team problem. */
export function teamProblemText(t: Strings, problem: TeamProblem): string {
  const s = t.skills.team;
  switch (problem) {
    case "disabled":
      return s.disabled;
    case "expired":
      return s.expired;
    case "forbidden":
      return s.forbidden;
    case "rate_limited":
      return s.rateLimited;
    case "offline":
      return s.offline;
    case "invalid":
      return s.invalid;
    default:
      return s.generic;
  }
}

function ProblemLine({ problem, onSignIn }: { problem: TeamProblem; onSignIn: () => void }) {
  const t = useT();
  return (
    <p className={problem === "rate_limited" || problem === "offline" ? "skills-notice" : "inline-error"} role="alert">
      {teamProblemText(t, problem)}
      {problem === "expired" && (
        <>
          {" "}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSignIn}>
            {t.skills.team.signIn}
          </button>
        </>
      )}
    </p>
  );
}

/**
 * The confirmation before sharing: EXACTLY what teammates will see (title,
 * description, the rendered instructions, the file names) and the warning.
 */
function ShareDialog({
  skill,
  reshare,
  team,
  onCancel,
  onShared,
}: {
  skill: Skill;
  reshare: boolean;
  team: TeamProps;
  onCancel: () => void;
  onShared: (title: string) => void;
}) {
  const t = useT();
  const s = t.skills.team;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<TeamProblem | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const layer = useEscapeLayer(true);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (!isTopLayer(layer)) return;
      // Round 14 (B1): the dialog is the innermost surface and consumes Esc
      // (round 14 review F2: only the innermost one).
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [layer, onCancel]);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const link = team.state.view.links[skill.id] ?? null;
    const result = await shareSkill(team.profileId, skill, link);
    setBusy(false);
    if (result.ok) {
      team.onState({ ...team.state, view: result.view });
      onShared(skill.title);
      return;
    }
    setProblem(result.problem);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="modal share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        aria-describedby="share-warning"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="share-title">{reshare ? s.dialogResubmitTitle : s.dialogTitle}</h2>
        <p className="modal-note">{s.dialogLede}</p>
        <div className="share-preview" aria-label={s.dialogLede}>
          <p className="skill-title">{skill.title}</p>
          <p className="skill-description">{skill.description}</p>
          <div className="share-preview-body">
            <Markdown text={skill.instructions} />
          </div>
          {skill.references.length > 0 && (
            <>
              <p className="skill-label">{s.referencesLabel}</p>
              <ul className="skill-files">
                {skill.references.map((reference) => (
                  <li key={reference.name} className="skill-file">
                    <IconFile size={14} />
                    <span className="skill-file-name">{reference.name}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
        <p id="share-warning" className="share-warning">
          {s.warning}
        </p>
        {problem && <ProblemLine problem={problem} onSignIn={team.onSignIn} />}
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="btn btn-ghost" onClick={onCancel}>
            {t.skills.cancel}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>
            {busy ? s.sharing : reshare ? s.reshare : s.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------- the library --

function formatDate(value: string, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString(locale);
}

function TeamPanel({
  team,
  onUseTeam,
  onDuplicated,
}: {
  team: TeamProps;
  onUseTeam: (meta: TeamMeta) => void;
  onDuplicated: (created: Skill) => void;
}) {
  const { t, locale } = useI18n();
  const s = t.skills.team;
  const [viewing, setViewing] = useState<{ meta: TeamMeta; skill: TeamSkill } | null>(null);
  const [problem, setProblem] = useState<TeamProblem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [duplicateError, setDuplicateError] = useState("");
  const library = teamLibrary(team.state.view);
  const syncProblem = team.state.problem;
  const detailLayer = useEscapeLayer(viewing !== null);

  // Round 14 (C2): Esc closes the open team skill before the Settings surface
  // sees the key (the same rule as the form and the share dialog). Round 14
  // review (F1/F2): never for an IME composition, and only when the detail is
  // the innermost open surface.
  useEffect(() => {
    if (!viewing) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.isComposing) return;
      if (!isTopLayer(detailLayer)) return;
      e.preventDefault();
      setViewing(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [viewing, detailLayer]);

  /** The cached bundle (fetched and cached when missing). */
  const load = async (meta: TeamMeta): Promise<TeamSkill | null> => {
    setBusyId(meta.id);
    setProblem(null);
    setDuplicateError("");
    const result = await loadTeamSkill(team.profileId, meta.id);
    setBusyId(null);
    if ("problem" in result) {
      setProblem(result.problem);
      return null;
    }
    const { view } = team.state;
    if (!(meta.id in view.cached)) {
      team.onState({ ...team.state, view: { ...view, cached: { ...view.cached, [meta.id]: meta.updated_at } } });
    }
    return result.skill;
  };

  const open = async (meta: TeamMeta): Promise<void> => {
    const skill = await load(meta);
    if (skill) setViewing({ meta, skill });
  };

  const use = async (meta: TeamMeta): Promise<void> => {
    if (await load(meta)) onUseTeam(meta);
  };

  const duplicate = async (meta: TeamMeta): Promise<void> => {
    const skill = await load(meta);
    if (!skill) return;
    try {
      const created = await createSkill({
        title: skill.title,
        description: skill.description,
        instructions: skill.instructions,
        references: skill.references.map((reference) => ({ ...reference })),
      });
      onDuplicated(created);
    } catch (err) {
      setDuplicateError(skillErrorText(t, err));
    }
  };

  if (syncProblem === "disabled") {
    return (
      <div className="skills-empty">
        <IconBolt size={28} />
        <p className="empty-title">{s.disabled}</p>
      </div>
    );
  }

  const actions = (meta: TeamMeta) => (
    <>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        aria-label={s.useLabel(meta.title)}
        disabled={busyId === meta.id}
        onClick={() => void use(meta)}
      >
        {s.use}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-label={s.duplicateLabel(meta.title)}
        disabled={busyId === meta.id}
        onClick={() => void duplicate(meta)}
      >
        {s.duplicate}
      </button>
    </>
  );

  const problems = (
    <>
      {syncProblem && <ProblemLine problem={syncProblem} onSignIn={team.onSignIn} />}
      {problem && problem !== syncProblem && <ProblemLine problem={problem} onSignIn={team.onSignIn} />}
      {duplicateError && (
        <p className="inline-error" role="alert">
          {duplicateError}
        </p>
      )}
    </>
  );

  if (viewing) {
    const { meta, skill } = viewing;
    return (
      <article className="team-skill-detail" aria-labelledby="team-skill-title">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setViewing(null)}>
          <IconArrowLeft size={16} />
          {s.back}
        </button>
        <h2 id="team-skill-title">{skill.title}</h2>
        <p className="skill-provenance">{s.sharedBy(meta.author_name || skill.author_name)}</p>
        <p className="skill-description">{skill.description}</p>
        <div className="team-skill-body">
          <Markdown text={skill.instructions} />
        </div>
        {skill.references.length > 0 && (
          <>
            <p className="skill-label">{s.referencesLabel}</p>
            <ul className="skill-files">
              {skill.references.map((reference) => (
                <li key={reference.name} className="skill-file">
                  <IconFile size={14} />
                  <span className="skill-file-name">{reference.name}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {problems}
        <div className="grant-actions">{actions(meta)}</div>
      </article>
    );
  }

  return (
    <>
      {problems}
      {syncProblem && syncProblem !== "rate_limited" && syncProblem !== "offline" && library.length === 0 && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={team.onRetry}>
          {s.retry}
        </button>
      )}
      {library.length === 0 ? (
        !syncProblem && (
          <div className="skills-empty">
            <IconBolt size={28} />
            <p className="empty-title">{s.empty}</p>
          </div>
        )
      ) : (
        <ul className="grant-list skills-list" aria-label={s.tabTeam}>
          {library.map((meta) => {
            const date = formatDate(meta.updated_at, locale);
            // Approved but not cached yet: the round that fetches the bundle
            // has not finished, so the skill is not usable in the chat yet.
            const preparing = !isBundleCached(team.state.view, meta);
            return (
              <li key={meta.id} className="grant-card skill-card">
                <div className="skill-text">
                  <p className="skill-title">
                    {meta.title}
                    {meta.featured && (
                      <>
                        {" "}
                        <span className="skill-badge skill-badge-featured">{s.featured}</span>
                      </>
                    )}
                    {preparing && (
                      <>
                        {" "}
                        {/* Round 14 (C11): the badge explains what it waits for. */}
                        <span className="skill-badge skill-badge-preparing" title={s.preparingHint}>
                          {s.preparing}
                        </span>
                      </>
                    )}
                  </p>
                  <p className="skill-description">{meta.description}</p>
                  <p className="skill-provenance">
                    {s.sharedBy(meta.author_name)}
                    {date && ` · ${s.updated(date)}`}
                  </p>
                </div>
                <div className="grant-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={s.viewLabel(meta.title)}
                    disabled={busyId === meta.id}
                    onClick={() => void open(meta)}
                  >
                    {s.view}
                  </button>
                  {actions(meta)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ------------------------------------------------------------- the form --

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
          aria-describedby="skill-purpose-hint"
          maxLength={1024}
          onChange={(e) => set({ description: e.currentTarget.value })}
        />
      </label>
      {/* Round 14 (C12): the guide stays visible, wrapped like the
          instructions hint, so it is described to assistive tech too. */}
      <span className="skill-hint" id="skill-purpose-hint">
        {s.purposeHint}
      </span>
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
