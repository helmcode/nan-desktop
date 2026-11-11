// Settings: working folders (with per-grant approval mode), commands,
// memory, language, voice (hidden this round) and about/sign-out.
// Plain language only; the target user is not technical.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BrandMark } from "./brand";
import type { SettingsSection } from "./components/UserMenu";
import { UpdateAction } from "./components/UpdateAction";
import { VOICES, folderName, grantErrorLabel, profileTitle } from "./copy";
import { DEFAULT_GRANT_MODE, type GrantMode } from "./core";
import { VOICE_UI } from "./flags";
import { LOCALES, useI18n } from "./i18n";
import { IconArrowLeft, IconCheck, IconComputer, IconFolder, IconPlus, IconWarning } from "./icons";
import type { AppInfo, MemoryMode, MemorySettingsView, ProfileView, ToolsSettingsView } from "./types";
import type { Workspace } from "./workspace";

export function Settings({
  profile,
  workspace,
  voice,
  onVoiceChange,
  onAskComputerWide,
  onBack,
  onSignOut,
  signingOut,
  focusSection = null,
  backLabel,
  update = null,
}: {
  profile: ProfileView | undefined;
  workspace: Workspace;
  voice: string;
  onVoiceChange: (voice: string) => void;
  onAskComputerWide: () => void;
  onBack: () => void;
  onSignOut: () => void;
  signingOut: boolean;
  focusSection?: SettingsSection;
  /// The Back button's text (where Back returns to); "Back to chat" by default.
  backLabel?: string;
  /// Round 14 (C6): the newer version, when the update check found one. The
  /// same busy state as the banner and the account menu (one install at a
  /// time), so the Account section offers the update without leaving chat.
  update?: { version: string; onUpdate: () => Promise<void>; busy: boolean } | null;
}) {
  const { t, locale, setLocale } = useI18n();
  // S15: run_command is on by default; the core still asks per action.
  const [runCommand, setRunCommand] = useState(true);
  const [runCommandBusy, setRunCommandBusy] = useState(false);
  const [memoryMode, setMemoryMode] = useState<MemoryMode>("remote");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [newFolderMode, setNewFolderMode] = useState<GrantMode>(DEFAULT_GRANT_MODE);
  const [version, setVersion] = useState("");
  const foldersRef = useRef<HTMLElement | null>(null);
  const memoryRef = useRef<HTMLElement | null>(null);
  const languageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    void workspace.refresh();
    invoke<ToolsSettingsView>("tools_settings_get")
      .then((s) => setRunCommand(s.tools_allow_run_command))
      .catch(() => {});
    invoke<MemorySettingsView>("memory_settings_get")
      .then((s) => setMemoryMode(s.mode))
      .catch(() => {});
    invoke<AppInfo>("app_info")
      .then((info) => setVersion(info.version))
      .catch(() => {});
    // Load once per visit (the workspace object changes identity per render).
  }, []);

  // Entry from the user menu: bring the requested section into view.
  useEffect(() => {
    const target =
      focusSection === "folders"
        ? foldersRef.current
        : focusSection === "memory"
          ? memoryRef.current
          : focusSection === "language"
            ? languageRef.current
            : null;
    target?.scrollIntoView?.({ block: "start" });
  }, [focusSection]);

  // Round 14 (C2): Escape returns to the chat from the Settings surface in
  // App.tsx, so every section (Skills included) behaves the same and an inner
  // surface can consume the key first (B1/B2).

  const toggleRunCommand = async (enabled: boolean): Promise<void> => {
    setRunCommandBusy(true);
    const previous = runCommand;
    try {
      await invoke("tools_set_run_command_enabled", { enabled });
      setRunCommand(enabled);
    } catch {
      setRunCommand(previous);
    } finally {
      setRunCommandBusy(false);
    }
  };

  const chooseMemory = async (mode: MemoryMode): Promise<void> => {
    if (!profile || mode === memoryMode) return;
    setMemoryBusy(true);
    const previous = memoryMode;
    setMemoryMode(mode);
    try {
      // The core migrates once, silently; nothing to configure.
      const view = await invoke<MemorySettingsView>("memory_set_mode", {
        profileId: profile.id,
        mode,
      });
      setMemoryMode(view.mode);
    } catch {
      setMemoryMode(previous);
    } finally {
      setMemoryBusy(false);
    }
  };

  const f = t.settings.folders;
  const errorText = grantErrorLabel(t, workspace.error);

  return (
    <section className="settings">
      <header className="settings-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft size={16} />
          {backLabel ?? t.settings.back}
        </button>
      </header>

      <div className="settings-body">
        {/* ---- Working folders ------------------------------------------ */}
        <section className="settings-section" aria-labelledby="ws-title" ref={foldersRef}>
          <h1 id="ws-title">{f.title}</h1>
          <p className="section-lede">{f.lede}</p>

          <ul className="grant-list">
            {workspace.computerWide && (
              <li className="grant-card grant-card-wide">
                <span className="grant-icon">
                  <IconComputer />
                </span>
                <div className="grant-text">
                  <strong>{f.wideTitle}</strong>
                  <span>{f.wideBody}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void workspace.disableComputerWide()}
                  disabled={workspace.busy}
                >
                  {f.disable}
                </button>
              </li>
            )}
            {workspace.folders.map((grant) => {
              const name = folderName(grant.canonical_path);
              const mode = workspace.modes[grant.id] ?? DEFAULT_GRANT_MODE;
              return (
                <li key={grant.id} className="grant-card">
                  <span className="grant-icon">
                    <IconFolder />
                  </span>
                  <div className="grant-text">
                    <strong>{name}</strong>
                    <span>{f.folderBody(name)}</span>
                    <code className="grant-path" title={grant.canonical_path}>
                      {grant.canonical_path}
                    </code>
                    <ModeSwitch
                      label={f.modeLabel(name)}
                      value={mode}
                      disabled={workspace.busy}
                      onChange={(next) => void workspace.setMode(grant.id, next)}
                    />
                    {mode === "allow" && <span className="grant-mode-hint">{f.modeAllowHint}</span>}
                  </div>
                  <div className="grant-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void workspace.repickFolder(grant.id)}
                      disabled={workspace.busy}
                      aria-label={f.repickLabel(name)}
                    >
                      {f.repick}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void workspace.removeGrant(grant.id)}
                      disabled={workspace.busy}
                      aria-label={f.removeLabel(name)}
                    >
                      {f.remove}
                    </button>
                  </div>
                </li>
              );
            })}
            {workspace.folders.length === 0 && !workspace.computerWide && (
              <li className="grant-empty">{f.empty}</li>
            )}
          </ul>

          <div className="row-actions">
            <ModeSwitch
              label={f.newFolderMode}
              showLabel
              value={newFolderMode}
              disabled={workspace.busy || !profile}
              onChange={setNewFolderMode}
            />
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void workspace.addFolder(newFolderMode)}
              disabled={workspace.busy || !profile}
            >
              <IconPlus size={16} />
              {f.add}
            </button>
            {!workspace.computerWide && (
              <button
                type="button"
                className="btn btn-ghost btn-warn"
                onClick={onAskComputerWide}
                disabled={workspace.busy || !profile}
              >
                <IconWarning size={16} />
                {f.giveWide}
              </button>
            )}
          </div>
          {errorText && (
            <p className="inline-error" role="alert">
              {errorText}
            </p>
          )}

          <div className="danger-option">
            <label className="switch-row">
              <span className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={runCommand}
                  onChange={(e) => void toggleRunCommand(e.currentTarget.checked)}
                  disabled={runCommandBusy}
                />
                <span className="switch-track" aria-hidden="true" />
              </span>
              <span className="switch-label">
                <strong>{t.settings.commands.title}</strong>
              </span>
            </label>
            <p className="danger-note">
              <IconWarning size={16} />
              <span>{t.settings.commands.body}</span>
            </p>
          </div>
        </section>

        {/* ---- Memory --------------------------------------------------- */}
        <section className="settings-section" aria-labelledby="mem-title" ref={memoryRef}>
          <h1 id="mem-title">{t.settings.memory.title}</h1>
          <p className="section-lede">{t.settings.memory.lede}</p>
          <div className="choice-list" role="radiogroup" aria-labelledby="mem-title">
            <ChoiceCard
              selected={memoryMode === "remote"}
              disabled={memoryBusy || !profile}
              onSelect={() => void chooseMemory("remote")}
              title={t.settings.memory.remoteTitle}
              badge={t.settings.memory.remoteBadge}
              description={t.settings.memory.remoteBody}
            />
            <ChoiceCard
              selected={memoryMode === "local"}
              disabled={memoryBusy || !profile}
              onSelect={() => void chooseMemory("local")}
              title={t.settings.memory.localTitle}
              description={t.settings.memory.localBody}
            />
          </div>
        </section>

        {/* ---- Language ------------------------------------------------- */}
        <section className="settings-section" aria-labelledby="lang-title" ref={languageRef}>
          <h1 id="lang-title">{t.settings.language.title}</h1>
          <p className="section-lede">{t.settings.language.lede}</p>
          <div className="choice-list choice-list-compact" role="radiogroup" aria-labelledby="lang-title">
            {LOCALES.map((id) => (
              <ChoiceCard
                key={id}
                selected={locale === id}
                onSelect={() => setLocale(id)}
                title={t.language.names[id]}
                lang={id}
              />
            ))}
          </div>
        </section>

        {/* ---- Voice (S24: hidden this round) ---------------------------- */}
        {VOICE_UI && (
          <section className="settings-section" aria-labelledby="voice-title">
            <h1 id="voice-title">{t.settings.voice.title}</h1>
            <p className="section-lede">{t.settings.voice.lede}</p>
            <div className="choice-list choice-list-compact" role="radiogroup" aria-labelledby="voice-title">
              {VOICES.map((v) => (
                <ChoiceCard
                  key={v.id}
                  selected={voice === v.id}
                  onSelect={() => onVoiceChange(v.id)}
                  title={v.label}
                  description={t.voices[v.id] ?? ""}
                />
              ))}
            </div>
          </section>
        )}

        {/* ---- About ---------------------------------------------------- */}
        <section className="settings-section" aria-labelledby="about-title">
          <h1 id="about-title">{t.settings.about.title}</h1>
          <div className="about-product">
            <BrandMark size="md" />
            <strong>{t.settings.about.product}</strong>
          </div>
          <dl className="about-list">
            <div>
              <dt>{t.settings.about.account}</dt>
              <dd>{profile ? profileTitle(t, profile.id, profile.name) : t.settings.about.none}</dd>
            </div>
            <div>
              <dt>{t.settings.about.version}</dt>
              <dd className="mono">{version || "-"}</dd>
            </div>
          </dl>
          {update && (
            <div className="about-update">
              <UpdateAction version={update.version} onUpdate={update.onUpdate} busy={update.busy} />
            </div>
          )}
          <button type="button" className="btn btn-ghost btn-danger" onClick={onSignOut} disabled={signingOut}>
            {t.settings.about.signOut}
          </button>
        </section>
      </div>
    </section>
  );
}

/// Two-option segmented switch for a grant's approval mode (S13).
function ModeSwitch({
  label,
  value,
  onChange,
  disabled,
  showLabel = false,
}: {
  label: string;
  value: GrantMode;
  onChange: (mode: GrantMode) => void;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const { t } = useI18n();
  const options: Array<{ id: GrantMode; text: string }> = [
    { id: "ask", text: t.settings.folders.modeAsk },
    { id: "allow", text: t.settings.folders.modeAllow },
  ];
  return (
    <div className="mode-switch-wrap">
      {showLabel && <span className="mode-switch-label">{label}</span>}
      <div className="mode-switch" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={`mode-option${value === option.id ? " selected" : ""}${option.id === "allow" ? " allow" : ""}`}
            onClick={() => value !== option.id && onChange(option.id)}
            disabled={disabled}
          >
            {option.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChoiceCard({
  selected,
  disabled,
  onSelect,
  title,
  description,
  badge,
  lang,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  description?: string;
  badge?: string;
  lang?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`choice-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      disabled={disabled}
      lang={lang}
    >
      <span className="choice-dot" aria-hidden="true">
        {selected && <IconCheck size={12} />}
      </span>
      <span className="choice-text">
        <strong>
          {title}
          {badge && <span className="tag">{badge}</span>}
        </strong>
        {description && <span>{description}</span>}
      </span>
    </button>
  );
}
