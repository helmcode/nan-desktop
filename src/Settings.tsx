// Settings screen: workspace folders, memory, voice, about/sign-out.
// Plain language only — the target user is not technical.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VOICES, folderName, profileTitle } from "./copy";
import {
  IconArrowLeft,
  IconCheck,
  IconComputer,
  IconFolder,
  IconPlus,
  IconWarning,
} from "./icons";
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
}: {
  profile: ProfileView | undefined;
  workspace: Workspace;
  voice: string;
  onVoiceChange: (voice: string) => void;
  onAskComputerWide: () => void;
  onBack: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [runCommand, setRunCommand] = useState(false);
  const [runCommandBusy, setRunCommandBusy] = useState(false);
  const [memoryMode, setMemoryMode] = useState<MemoryMode>("remote");
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [version, setVersion] = useState("");

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

  // Escape returns to the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const toggleRunCommand = async (enabled: boolean): Promise<void> => {
    setRunCommandBusy(true);
    try {
      // Enabling shows a native confirmation from the core; declining
      // leaves it off.
      await invoke("tools_set_run_command_enabled", { enabled });
      setRunCommand(enabled);
    } catch {
      setRunCommand(false);
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

  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="settings-header">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          <IconArrowLeft size={16} />
          Volver al chat
        </button>
        <h1 id="settings-title">Ajustes</h1>
      </header>

      <div className="settings-body">
        {/* ---- Workspace ------------------------------------------------ */}
        <section className="settings-section" aria-labelledby="ws-title">
          <h2 id="ws-title">Carpetas de trabajo</h2>
          <p className="section-lede">
            El asistente solo puede trabajar con archivos de las carpetas que elijas aquí, y
            siempre te pide permiso antes de cada acción.
          </p>

          <ul className="grant-list">
            {workspace.computerWide && (
              <li className="grant-card grant-card-wide">
                <span className="grant-icon">
                  <IconComputer />
                </span>
                <div className="grant-text">
                  <strong>Todo el equipo</strong>
                  <span>
                    El asistente puede pedirte acceso a cualquier archivo de tu usuario. Bajo tu
                    responsabilidad.
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void workspace.disableComputerWide()}
                  disabled={workspace.busy}
                >
                  Desactivar
                </button>
              </li>
            )}
            {workspace.folders.map((grant) => (
              <li key={grant.id} className="grant-card">
                <span className="grant-icon">
                  <IconFolder />
                </span>
                <div className="grant-text">
                  <strong>{folderName(grant.canonical_path)}</strong>
                  <span>
                    El asistente puede leer y escribir en {folderName(grant.canonical_path)}.
                  </span>
                  <code className="grant-path" title={grant.canonical_path}>
                    {grant.canonical_path}
                  </code>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void workspace.removeGrant(grant.id)}
                  disabled={workspace.busy}
                  aria-label={`Quitar la carpeta ${folderName(grant.canonical_path)}`}
                >
                  Quitar
                </button>
              </li>
            ))}
            {workspace.folders.length === 0 && !workspace.computerWide && (
              <li className="grant-empty">
                Todavía no has elegido ninguna carpeta. El asistente puede conversar contigo, pero
                no tocará ningún archivo.
              </li>
            )}
          </ul>

          <div className="row-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void workspace.addFolder()}
              disabled={workspace.busy || !profile}
            >
              <IconPlus size={16} />
              Añadir carpeta…
            </button>
            {!workspace.computerWide && (
              <button
                type="button"
                className="btn btn-ghost btn-warn"
                onClick={onAskComputerWide}
                disabled={workspace.busy || !profile}
              >
                <IconWarning size={16} />
                Dar acceso a todo el equipo…
              </button>
            )}
          </div>
          {workspace.error && (
            <p className="inline-error" role="alert">
              {workspace.error}
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
                <strong>Ejecutar órdenes en tu equipo</strong>
                <span className="tag tag-danger">Experimental</span>
              </span>
            </label>
            <p className="danger-note">
              <IconWarning size={16} />
              <span>
                Permite que el asistente ejecute órdenes dentro de tus carpetas de trabajo,
                pidiéndote permiso cada vez. Una orden puede hacer cualquier cosa que harías tú:
                borrar archivos, usar internet o cambiar ajustes. Déjalo desactivado si no lo
                necesitas.
              </span>
            </p>
          </div>
        </section>

        {/* ---- Memory --------------------------------------------------- */}
        <section className="settings-section" aria-labelledby="mem-title">
          <h2 id="mem-title">Memoria</h2>
          <p className="section-lede">Dónde se guardan tus conversaciones.</p>
          <div className="choice-list" role="radiogroup" aria-labelledby="mem-title">
            <ChoiceCard
              selected={memoryMode === "remote"}
              disabled={memoryBusy || !profile}
              onSelect={() => void chooseMemory("remote")}
              title="En tu cuenta"
              badge="Recomendado"
              description="Tus conversaciones se guardan en tu cuenta — disponibles en cualquier dispositivo."
            />
            <ChoiceCard
              selected={memoryMode === "local"}
              disabled={memoryBusy || !profile}
              onSelect={() => void chooseMemory("local")}
              title="Solo en este dispositivo"
              description="Tus conversaciones no salen de este ordenador. No las verás en otros dispositivos."
            />
          </div>
        </section>

        {/* ---- Voice ---------------------------------------------------- */}
        <section className="settings-section" aria-labelledby="voice-title">
          <h2 id="voice-title">Voz</h2>
          <p className="section-lede">La voz que lee en alto las respuestas.</p>
          <div className="choice-list choice-list-compact" role="radiogroup" aria-labelledby="voice-title">
            {VOICES.map((v) => (
              <ChoiceCard
                key={v.id}
                selected={voice === v.id}
                onSelect={() => onVoiceChange(v.id)}
                title={v.label}
                description={v.hint}
              />
            ))}
          </div>
        </section>

        {/* ---- About ---------------------------------------------------- */}
        <section className="settings-section" aria-labelledby="about-title">
          <h2 id="about-title">Acerca de</h2>
          <dl className="about-list">
            <div>
              <dt>Cuenta</dt>
              <dd>{profile ? profileTitle(profile.id, profile.name) : "—"}</dd>
            </div>
            <div>
              <dt>Versión</dt>
              <dd className="mono">{version || "—"}</dd>
            </div>
          </dl>
          <button
            type="button"
            className="btn btn-ghost btn-danger"
            onClick={onSignOut}
            disabled={signingOut}
          >
            Cerrar sesión
          </button>
        </section>
      </div>
    </section>
  );
}

function ChoiceCard({
  selected,
  disabled,
  onSelect,
  title,
  description,
  badge,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`choice-card${selected ? " selected" : ""}`}
      onClick={onSelect}
      disabled={disabled}
    >
      <span className="choice-dot" aria-hidden="true">
        {selected && <IconCheck size={12} />}
      </span>
      <span className="choice-text">
        <strong>
          {title}
          {badge && <span className="tag">{badge}</span>}
        </strong>
        <span>{description}</span>
      </span>
    </button>
  );
}
